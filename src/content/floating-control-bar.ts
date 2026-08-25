import type { ExtensionSettings, PlaybackState } from "../shared/models";

type ControlIcon =
  | "play"
  | "pause"
  | "loading"
  | "selection"
  | "text"
  | "speed"
  | "volume"
  | "settings"
  | "drag";

/** 控制栏把界面操作转换成回调，不直接依赖扩展消息或 chrome.tts。 */
export interface FloatingControlBarActions {
  onTogglePlayback(): void;
  onPlaySelection(): void;
  onPlayText(text: string): void;
  onRateChange(rate: number): void;
  onVolumeChange(volume: number): void;
  onOpenSettings(): void;
}

/**
 * 注入网页右侧的快捷控制栏。
 *
 * 所有元素都位于 Shadow DOM，避免目标网站的按钮、字体和表单样式覆盖扩展 UI；
 * 宿主页只能看到一个带专属 ID 的空壳元素。
 */
export class FloatingControlBar {
  private readonly host: HTMLDivElement;
  private readonly controlBarElement: HTMLDivElement;
  private readonly playButton: HTMLButtonElement;
  private readonly inputPanel: HTMLDivElement;
  private readonly textInput: HTMLTextAreaElement;
  private readonly inputMessage: HTMLDivElement;
  private readonly ratePanel: HTMLDivElement;
  private readonly rateValue: HTMLOutputElement;
  private readonly volumePanel: HTMLDivElement;
  private readonly volumeInput: HTMLInputElement;
  private readonly volumeValue: HTMLOutputElement;
  private currentRate = 1;

  public constructor(actions: FloatingControlBarActions) {
    this.host = document.createElement("div");
    this.host.id = "chrome-tts-floating-control-bar";

    const shadowRoot = this.host.attachShadow({ mode: "closed" });
    shadowRoot.append(this.createStyles());

    this.controlBarElement = document.createElement("div");
    this.controlBarElement.className = "control-bar";
    this.controlBarElement.setAttribute("role", "toolbar");
    this.controlBarElement.setAttribute("aria-label", "Chrome TTS 快捷控制栏");

    this.playButton = this.createButton("play", "播放固定文本");
    const selectionButton = this.createButton("selection", "播放选中文本");
    const textButton = this.createButton("text", "输入文本并播放");
    const rateButton = this.createButton("speed", "调整播放速度");
    const volumeButton = this.createButton("volume", "调整音量");
    const settingsButton = this.createButton("settings", "打开设置");
    const dragButton = this.createButton("drag", "拖动快捷控制栏");
    dragButton.classList.add("drag-button");

    this.playButton.addEventListener("click", actions.onTogglePlayback);
    selectionButton.addEventListener("click", actions.onPlaySelection);
    textButton.addEventListener("click", () => this.toggleInputPanel());
    rateButton.addEventListener("click", () => this.toggleRatePanel());
    volumeButton.addEventListener("click", () => this.toggleVolumePanel());
    settingsButton.addEventListener("click", actions.onOpenSettings);
    this.initializeDragging(dragButton);

    this.controlBarElement.append(
      this.playButton,
      selectionButton,
      textButton,
      rateButton,
      volumeButton,
      settingsButton,
      dragButton,
    );

    this.inputPanel = document.createElement("div");
    this.inputPanel.className = "input-panel";
    this.inputPanel.hidden = true;

    this.textInput = document.createElement("textarea");
    this.textInput.placeholder = "输入需要朗读的文本";
    this.textInput.maxLength = 32768;
    this.textInput.setAttribute("aria-label", "需要朗读的文本");

    const actionRow = document.createElement("div");
    actionRow.className = "input-actions";

    const pasteButton = document.createElement("button");
    pasteButton.type = "button";
    pasteButton.className = "paste-button";
    pasteButton.textContent = "粘贴";
    pasteButton.title = "从剪贴板粘贴文本";
    pasteButton.setAttribute("aria-label", "从剪贴板粘贴文本");
    pasteButton.addEventListener("click", () => {
      void this.pasteClipboardText();
    });

    const submitButton = document.createElement("button");
    submitButton.type = "button";
    submitButton.className = "submit-button";
    submitButton.textContent = "播放";
    submitButton.addEventListener("click", () => {
      const text = this.textInput.value.trim();
      if (!text) {
        this.showInputMessage("请输入文本。");
        return;
      }

      this.showInputMessage("");
      this.inputPanel.hidden = true;
      actions.onPlayText(text);
    });

    actionRow.append(pasteButton, submitButton);

    this.inputMessage = document.createElement("div");
    this.inputMessage.className = "input-message";
    this.inputMessage.setAttribute("role", "status");

    this.inputPanel.append(this.textInput, actionRow, this.inputMessage);

    this.ratePanel = document.createElement("div");
    this.ratePanel.className = "setting-panel rate-panel";
    this.ratePanel.hidden = true;

    const rateAdjustmentRow = document.createElement("div");
    rateAdjustmentRow.className = "adjustment-row";
    const decreaseRateButton = this.createAdjustmentButton("−", "语速降低 0.1");
    const increaseRateButton = this.createAdjustmentButton("+", "语速提高 0.1");
    this.rateValue = document.createElement("output");
    this.rateValue.className = "setting-value";
    this.rateValue.textContent = "1×";
    decreaseRateButton.addEventListener("click", () => {
      this.changeRate(this.currentRate - 0.1, actions);
    });
    increaseRateButton.addEventListener("click", () => {
      this.changeRate(this.currentRate + 0.1, actions);
    });
    rateAdjustmentRow.append(
      decreaseRateButton,
      this.rateValue,
      increaseRateButton,
    );

    const presetRow = document.createElement("div");
    presetRow.className = "preset-row";
    for (const preset of [0.5, 1, 1.5]) {
      const presetButton = document.createElement("button");
      presetButton.type = "button";
      presetButton.className = "preset-button";
      presetButton.textContent = `${preset}×`;
      presetButton.addEventListener("click", () => {
        this.changeRate(preset, actions);
      });
      presetRow.append(presetButton);
    }
    this.ratePanel.append(rateAdjustmentRow, presetRow);

    this.volumePanel = document.createElement("div");
    this.volumePanel.className = "setting-panel volume-panel";
    this.volumePanel.hidden = true;
    this.volumeInput = document.createElement("input");
    this.volumeInput.type = "range";
    this.volumeInput.min = "0";
    this.volumeInput.max = "1";
    this.volumeInput.step = "0.05";
    this.volumeInput.value = "1";
    this.volumeInput.setAttribute("aria-label", "播放音量");
    this.volumeValue = document.createElement("output");
    this.volumeValue.className = "volume-value";
    this.volumeValue.textContent = "100%";
    this.volumeInput.addEventListener("input", () => {
      const volume = Number(this.volumeInput.value);
      this.volumeValue.textContent = `${Math.round(volume * 100)}%`;
    });
    this.volumeInput.addEventListener("change", () => {
      const volume = Number(this.volumeInput.value);
      actions.onVolumeChange(volume);
    });
    this.volumePanel.append(this.volumeInput, this.volumeValue);

    shadowRoot.append(
      this.controlBarElement,
      this.inputPanel,
      this.ratePanel,
      this.volumePanel,
    );
    document.documentElement.append(this.host);

    // 拖动后使用固定 left/top；视口缩小时重新约束，避免控制栏留在不可见区域。
    const handleViewportResize = (): void => {
      window.requestAnimationFrame(() => this.constrainToViewport());
    };
    window.addEventListener("resize", handleViewportResize);
    window.visualViewport?.addEventListener("resize", handleViewportResize);

    // Escape 只关闭扩展自己的输入层，不阻断目标网站继续处理该按键。
    this.textInput.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        this.inputPanel.hidden = true;
      }
    });
  }

  /** 根据播放器状态更新主按钮的图标、说明和可用性。 */
  public renderState(state: PlaybackState): void {
    this.playButton.disabled = state.status === "loading";

    if (state.status === "loading") {
      this.setPlayButton("loading", "正在准备播放");
    } else if (state.status === "playing") {
      this.setPlayButton("pause", "暂停播放");
    } else if (state.status === "paused") {
      this.setPlayButton("play", "恢复播放");
    } else {
      this.setPlayButton("play", "播放固定文本");
    }
  }

  /** 将 storage 中的倍速和音量同步到控制栏，不触发保存回调。 */
  public renderSettings(settings: ExtensionSettings): void {
    this.currentRate = settings.rate;
    this.rateValue.textContent = `${formatRate(settings.rate)}×`;
    this.volumeInput.value = String(settings.volume);
    this.volumeValue.textContent = `${Math.round(settings.volume * 100)}%`;
  }

  /** 在输入层中显示临时提示，第三阶段统一替换为网页顶部错误 toast。 */
  public showInputMessage(message: string): void {
    this.inputMessage.textContent = message;
  }

  /** 创建统一尺寸的图标按钮，title 与 aria-label 同时提供可访问说明。 */
  private createButton(
    icon: ControlIcon,
    description: string,
  ): HTMLButtonElement {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "control-button";
    button.append(this.createIcon(icon));
    button.title = description;
    button.setAttribute("aria-label", description);
    return button;
  }

  /** 创建倍速微调按钮；弹层控件使用文字可直接表达增减方向。 */
  private createAdjustmentButton(
    label: string,
    description: string,
  ): HTMLButtonElement {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "adjustment-button";
    button.textContent = label;
    button.title = description;
    button.setAttribute("aria-label", description);
    return button;
  }

  /**
   * 使用 Pointer Events 实现鼠标和触控拖动。
   * setPointerCapture 可在指针移出按钮后继续接收移动事件，松开时再释放捕获。
   */
  private initializeDragging(dragButton: HTMLButtonElement): void {
    dragButton.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) {
        return;
      }

      event.preventDefault();
      const initialRect = this.controlBarElement.getBoundingClientRect();
      const pointerOffsetX = event.clientX - initialRect.left;
      const pointerOffsetY = event.clientY - initialRect.top;

      // 首次拖动时把右侧居中定位转换为等价的左上角坐标，防止元素跳动。
      this.constrainToViewport(initialRect.left, initialRect.top);
      dragButton.classList.add("is-dragging");
      dragButton.setPointerCapture(event.pointerId);

      const handlePointerMove = (moveEvent: PointerEvent): void => {
        this.constrainToViewport(
          moveEvent.clientX - pointerOffsetX,
          moveEvent.clientY - pointerOffsetY,
        );
      };

      const finishDragging = (finishEvent: PointerEvent): void => {
        dragButton.classList.remove("is-dragging");
        dragButton.removeEventListener("pointermove", handlePointerMove);
        dragButton.removeEventListener("pointerup", finishDragging);
        dragButton.removeEventListener("pointercancel", finishDragging);
        if (dragButton.hasPointerCapture(finishEvent.pointerId)) {
          dragButton.releasePointerCapture(finishEvent.pointerId);
        }
      };

      dragButton.addEventListener("pointermove", handlePointerMove);
      dragButton.addEventListener("pointerup", finishDragging);
      dragButton.addEventListener("pointercancel", finishDragging);
    });
  }

  /**
   * 把请求位置限制在当前可视区域内。
   * 未提供坐标时使用元素现有位置，因此同一方法也可处理窗口缩放后的自动回收。
   */
  private constrainToViewport(requestedLeft?: number, requestedTop?: number): void {
    const currentRect = this.controlBarElement.getBoundingClientRect();
    const safeMargin = 16;
    const visualViewport = window.visualViewport;
    const viewportWidth = Math.min(
      document.documentElement.clientWidth,
      visualViewport?.width ?? window.innerWidth,
    );
    const viewportHeight = Math.min(
      document.documentElement.clientHeight,
      visualViewport?.height ?? window.innerHeight,
    );
    const maximumLeft = Math.max(
      safeMargin,
      viewportWidth - currentRect.width - safeMargin,
    );
    const maximumTop = Math.max(
      safeMargin,
      viewportHeight - currentRect.height - safeMargin,
    );
    const left = Math.min(
      maximumLeft,
      Math.max(safeMargin, requestedLeft ?? currentRect.left),
    );
    const top = Math.min(
      maximumTop,
      Math.max(safeMargin, requestedTop ?? currentRect.top),
    );

    this.host.style.right = "auto";
    this.host.style.transform = "none";
    this.host.style.left = `${left}px`;
    this.host.style.top = `${top}px`;
  }

  /** 展开或关闭文本输入层，并在展开后把键盘焦点移到文本框。 */
  private toggleInputPanel(): void {
    this.ratePanel.hidden = true;
    this.volumePanel.hidden = true;
    this.inputPanel.hidden = !this.inputPanel.hidden;
    this.showInputMessage("");
    if (!this.inputPanel.hidden) {
      this.textInput.focus();
    }
  }

  /** 切换倍速弹层并关闭其他互斥弹层。 */
  private toggleRatePanel(): void {
    this.inputPanel.hidden = true;
    this.volumePanel.hidden = true;
    this.ratePanel.hidden = !this.ratePanel.hidden;
  }

  /** 切换音量弹层并关闭其他互斥弹层。 */
  private toggleVolumePanel(): void {
    this.inputPanel.hidden = true;
    this.ratePanel.hidden = true;
    this.volumePanel.hidden = !this.volumePanel.hidden;
  }

  /** 将微调结果限制在 0.5–1.5，并消除小数累加产生的浮点误差。 */
  private changeRate(
    requestedRate: number,
    actions: FloatingControlBarActions,
  ): void {
    const rate =
      Math.round(Math.min(1.5, Math.max(0.5, requestedRate)) * 10) / 10;
    this.currentRate = rate;
    this.rateValue.textContent = `${formatRate(rate)}×`;
    actions.onRateChange(rate);
  }

  /**
   * 在用户点击后读取系统剪贴板并覆盖文本框内容。
   * clipboardRead 权限只用于这次显式操作；读取失败时保留原文本并显示原因。
   */
  private async pasteClipboardText(): Promise<void> {
    try {
      const clipboardText = await navigator.clipboard.readText();
      if (!clipboardText) {
        this.showInputMessage("剪贴板中没有文本。");
        return;
      }

      this.textInput.value = clipboardText.slice(0, this.textInput.maxLength);
      this.showInputMessage("");
      this.textInput.focus();
      this.textInput.setSelectionRange(
        this.textInput.value.length,
        this.textInput.value.length,
      );
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      this.showInputMessage(`读取剪贴板失败：${message}`);
    }
  }

  /** 同步主按钮的可见符号与辅助说明。 */
  private setPlayButton(icon: ControlIcon, description: string): void {
    this.playButton.replaceChildren(this.createIcon(icon));
    this.playButton.title = description;
    this.playButton.setAttribute("aria-label", description);
  }

  /** 创建统一为 20×20 的内联 SVG，避免字体和系统 emoji 导致图标大小不一致。 */
  private createIcon(icon: ControlIcon): SVGSVGElement {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("width", "20");
    svg.setAttribute("height", "20");
    svg.setAttribute("aria-hidden", "true");
    svg.setAttribute("focusable", "false");
    svg.setAttribute("fill", "none");
    svg.setAttribute("stroke", "currentColor");
    svg.setAttribute("stroke-width", "2");
    svg.setAttribute("stroke-linecap", "round");
    svg.setAttribute("stroke-linejoin", "round");

    const appendShape = (
      tagName: string,
      attributes: Record<string, string>,
    ): void => {
      const shape = document.createElementNS("http://www.w3.org/2000/svg", tagName);
      for (const [name, value] of Object.entries(attributes)) {
        shape.setAttribute(name, value);
      }
      svg.append(shape);
    };

    switch (icon) {
      case "play":
        appendShape("path", { d: "M8 5v14l11-7z", fill: "currentColor", stroke: "none" });
        break;
      case "pause":
        appendShape("rect", { x: "6", y: "5", width: "4", height: "14", rx: "1", fill: "currentColor", stroke: "none" });
        appendShape("rect", { x: "14", y: "5", width: "4", height: "14", rx: "1", fill: "currentColor", stroke: "none" });
        break;
      case "loading":
        svg.classList.add("loading-icon");
        appendShape("circle", { cx: "12", cy: "12", r: "8", "stroke-dasharray": "32 18" });
        break;
      case "selection":
        appendShape("path", { d: "M4 6h12M4 10h10M4 14h7" });
        appendShape("path", { d: "m14 13 6 3-3 1-1 3z", fill: "currentColor" });
        break;
      case "text":
        appendShape("rect", { x: "5", y: "3", width: "14", height: "18", rx: "2" });
        appendShape("path", { d: "M8 8h8M8 12h8M8 16h5" });
        break;
      case "speed":
        appendShape("path", { d: "M4.93 19.07a10 10 0 1 1 14.14 0" });
        appendShape("path", { d: "m12 12 4-4" });
        appendShape("circle", { cx: "12", cy: "12", r: "1.5", fill: "currentColor", stroke: "none" });
        break;
      case "volume":
        appendShape("path", { d: "M5 10v4h3l4 4V6L8 10z", fill: "currentColor", stroke: "none" });
        appendShape("path", { d: "M16 9a4 4 0 0 1 0 6M18.5 6.5a8 8 0 0 1 0 11" });
        break;
      case "settings":
        // 使用完整齿轮轮廓，避免中心圆加放射线在视觉上被识别为亮度按钮。
        appendShape("path", {
          d: "M19.14 12.94c.04-.31.06-.63.06-.94s-.02-.63-.07-.94l2.03-1.58a.5.5 0 0 0 .12-.64l-1.92-3.32a.5.5 0 0 0-.61-.22l-2.39.96a7.1 7.1 0 0 0-1.62-.94L14.38 2.8a.49.49 0 0 0-.49-.4h-3.84a.49.49 0 0 0-.49.4L9.2 5.34c-.58.24-1.12.55-1.62.94L5.19 5.32a.49.49 0 0 0-.61.22L2.66 8.86a.49.49 0 0 0 .12.64l2.03 1.58c-.05.31-.08.64-.08.96s.03.63.08.94l-2.03 1.58a.5.5 0 0 0-.12.64l1.92 3.32c.13.23.4.32.61.22l2.39-.96c.5.39 1.04.71 1.62.94l.36 2.54c.04.24.24.4.49.4h3.84c.25 0 .45-.16.49-.4l.36-2.54c.58-.24 1.12-.55 1.62-.94l2.39.96c.23.08.49 0 .61-.22l1.92-3.32a.5.5 0 0 0-.12-.64zM12 15.5A3.5 3.5 0 1 1 12 8a3.5 3.5 0 0 1 0 7.5z",
          fill: "currentColor",
          stroke: "none",
        });
        break;
      case "drag":
        for (const x of [9, 15]) {
          for (const y of [6, 12, 18]) {
            appendShape("circle", { cx: String(x), cy: String(y), r: "1.4", fill: "currentColor", stroke: "none" });
          }
        }
        break;
    }

    return svg;
  }

  /**
   * 样式只注入闭合 ShadowRoot，不会改变目标网站元素。
   * z-index 使用较高固定值，确保控制栏不会被普通页面内容遮挡。
   */
  private createStyles(): HTMLStyleElement {
    const style = document.createElement("style");
    style.textContent = `
      :host {
        all: initial;
        display: block;
        position: fixed;
        top: 50%;
        right: 16px;
        z-index: 2147483647;
        transform: translateY(-50%);
        color-scheme: light;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }

      .control-bar {
        display: flex;
        flex-direction: column;
        gap: 6px;
        padding: 7px;
        border: 1px solid rgb(0 0 0 / 12%);
        border-radius: 12px;
        background: rgb(255 255 255 / 96%);
        box-shadow: 0 5px 20px rgb(0 0 0 / 18%);
      }

      .control-button,
      .submit-button,
      .paste-button {
        box-sizing: border-box;
        border: 0;
        border-radius: 8px;
        color: #202124;
        background: #f1f3f4;
        cursor: pointer;
        font: 600 14px/1 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }

      .control-button {
        display: grid;
        place-items: center;
        width: 38px;
        height: 38px;
        padding: 0;
      }

      .control-button:hover,
      .submit-button:hover,
      .paste-button:hover {
        background: #e3e7ea;
      }

      .control-button:focus-visible,
      .submit-button:focus-visible,
      .paste-button:focus-visible,
      textarea:focus-visible {
        outline: 2px solid #1a73e8;
        outline-offset: 2px;
      }

      .control-button:disabled {
        cursor: wait;
        opacity: 0.55;
      }

      .control-button svg {
        display: block;
        width: 20px;
        height: 20px;
        pointer-events: none;
      }

      .loading-icon {
        animation: chrome-tts-spin 0.8s linear infinite;
      }

      .drag-button {
        cursor: grab;
        touch-action: none;
      }

      .drag-button.is-dragging {
        cursor: grabbing;
        background: #dbe7f8;
      }

      @keyframes chrome-tts-spin {
        to {
          transform: rotate(360deg);
        }
      }

      .input-panel {
        position: absolute;
        top: 86px;
        right: 54px;
        width: 336px;
        padding: 10px;
        border: 1px solid rgb(0 0 0 / 12%);
        border-radius: 10px;
        background: #fff;
        box-shadow: 0 5px 20px rgb(0 0 0 / 18%);
      }

      .input-panel[hidden] {
        display: none;
      }

      .setting-panel {
        position: absolute;
        right: 54px;
        box-sizing: border-box;
        padding: 10px;
        border: 1px solid rgb(0 0 0 / 12%);
        border-radius: 10px;
        background: #fff;
        box-shadow: 0 5px 20px rgb(0 0 0 / 18%);
      }

      .setting-panel[hidden] {
        display: none;
      }

      .rate-panel {
        top: 126px;
        width: 280px;
      }

      .volume-panel {
        top: 170px;
        display: flex;
        align-items: center;
        gap: 10px;
        width: 250px;
      }

      .adjustment-row {
        display: grid;
        grid-template-columns: 38px 1fr 38px;
        align-items: center;
        gap: 8px;
      }

      .adjustment-button,
      .preset-button {
        box-sizing: border-box;
        border: 0;
        border-radius: 7px;
        color: #202124;
        background: #f1f3f4;
        cursor: pointer;
        font: 600 13px/1 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }

      .adjustment-button {
        height: 34px;
        font-size: 20px;
      }

      .setting-value {
        text-align: center;
        font-size: 15px;
        font-weight: 600;
      }

      .preset-row {
        display: grid;
        grid-template-columns: repeat(3, 1fr);
        gap: 5px;
        margin-top: 8px;
      }

      .preset-button {
        padding: 8px 3px;
      }

      .adjustment-button:hover,
      .preset-button:hover {
        background: #e3e7ea;
      }

      .volume-panel input[type="range"] {
        flex: 1;
        min-width: 0;
        accent-color: #1a73e8;
      }

      .volume-value {
        flex: 0 0 42px;
        text-align: right;
        font-size: 13px;
        font-weight: 600;
      }

      textarea {
        box-sizing: border-box;
        width: 100%;
        height: 220px;
        margin: 0 0 8px;
        padding: 8px;
        resize: vertical;
        border: 1px solid #c7cacf;
        border-radius: 7px;
        color: #202124;
        background: #fff;
        font: 13px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        overflow-y: auto;
        scrollbar-color: transparent transparent;
        scrollbar-width: thin;
      }

      textarea:hover,
      textarea:focus {
        scrollbar-color: rgb(95 99 104 / 60%) transparent;
      }

      textarea::-webkit-scrollbar {
        width: 8px;
      }

      textarea::-webkit-scrollbar-track {
        background: transparent;
      }

      textarea::-webkit-scrollbar-thumb {
        border: 2px solid transparent;
        border-radius: 999px;
        background: transparent;
        background-clip: padding-box;
      }

      textarea:hover::-webkit-scrollbar-thumb,
      textarea:focus::-webkit-scrollbar-thumb {
        background: rgb(95 99 104 / 60%);
        background-clip: padding-box;
      }

      .input-actions {
        display: flex;
        gap: 8px;
      }

      .submit-button {
        flex: 1;
        padding: 9px;
        color: #fff;
        background: #1a73e8;
      }

      .paste-button {
        flex: 0 0 72px;
        padding: 9px;
      }

      .submit-button:hover {
        background: #1765cc;
      }

      .input-message {
        margin-top: 6px;
        color: #b3261e;
        font-size: 12px;
        line-height: 16px;
      }

      .input-message:empty {
        display: none;
      }
    `;
    return style;
  }
}

/** 移除无意义的尾随零，保证 0.1 粒度以简洁形式显示。 */
function formatRate(rate: number): string {
  return Number(rate.toFixed(2)).toString();
}
