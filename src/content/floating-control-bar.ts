import type { PlaybackState } from "../shared/models";
import type { SiteToolPanelConfig } from "./site-tool-panel";

type ControlIcon =
  | "previous"
  | "play"
  | "next"
  | "pause"
  | "loading"
  | "selection"
  | "text"
  | "settings"
  | "site-tools"
  | "drag"
  | "compact"
  | "collapse";

type ControlBarMode = "expanded" | "compact" | "collapsed";

const COMPACT_STATE_STORAGE_PREFIX = "floatingControlBarCompact:";

/** 控制栏把界面操作转换成回调，不直接依赖扩展消息或 chrome.tts。 */
export interface FloatingControlBarActions {
  onTogglePlayback(): void;
  onPrevious(): void;
  onNext(): void;
  onPlaySelection(): void;
  onPlayText(text: string): void;
}

/**
 * 注入网页右侧的快捷控制栏。
 *
 * 所有元素都位于 Shadow DOM，避免目标网站的按钮、字体和表单样式覆盖扩展 UI；
 * 宿主页只能看到一个带专属 ID 的空壳元素。
 */
export class FloatingControlBar {
  private readonly host: HTMLDivElement;
  private readonly launcherHost: HTMLDivElement;
  private readonly controlBarElement: HTMLDivElement;
  private readonly playButton: HTMLButtonElement;
  private readonly previousButton: HTMLButtonElement;
  private readonly nextButton: HTMLButtonElement;
  private readonly collapseButton: HTMLButtonElement;
  private readonly inputPanel: HTMLDivElement;
  private readonly textInput: HTMLTextAreaElement;
  private readonly inputMessage: HTMLDivElement;
  private readonly siteToolPanel: HTMLDivElement;
  private readonly settingsOverlayHost: HTMLDivElement;
  private readonly compactStateStorageKey: string;
  private readonly siteToolActionVisibility: Array<{
    button: HTMLButtonElement;
    isAvailable: () => boolean;
  }> = [];
  private hasPageItems = false;
  private isLoading = false;
  private mode: ControlBarMode = "expanded";
  private modeRevision = 0;
  private compactStateWriteQueue: Promise<void> = Promise.resolve();
  private isGloballyEnabled = true;
  private horizontalPositionRatio: number | null = null;
  private verticalPositionRatio: number | null = null;

  public constructor(
    actions: FloatingControlBarActions,
    siteTools: SiteToolPanelConfig | null = null,
    startExpanded = false,
  ) {
    this.mode = startExpanded ? "expanded" : "collapsed";
    // hostname 让同一网站的不同路径共享状态，同时不把完整 URL 写入扩展存储。
    this.compactStateStorageKey =
      `${COMPACT_STATE_STORAGE_PREFIX}${window.location.hostname.toLowerCase()}`;
    this.host = document.createElement("div");
    this.host.id = "chrome-tts-floating-control-bar";

    const shadowRoot = this.host.attachShadow({ mode: "closed" });
    shadowRoot.append(this.createStyles());

    this.launcherHost = this.createLauncher();

    this.controlBarElement = document.createElement("div");
    this.controlBarElement.className = "control-bar";
    this.controlBarElement.setAttribute("role", "toolbar");
    this.controlBarElement.setAttribute("aria-label", "Chrome TTS 快捷控制栏");

    this.previousButton = this.createButton("previous", "播放上一条");
    this.playButton = this.createButton("play", "播放页面文本");
    this.nextButton = this.createButton("next", "播放下一条");
    const selectionButton = this.createButton("selection", "播放选中文本");
    const textButton = this.createButton("text", "输入文本并播放");
    const settingsButton = this.createButton("settings", "打开设置");
    this.collapseButton = this.createButton("compact", "切换为简洁控制栏");
    const dragButton = this.createButton("drag", "拖动快捷控制栏");
    dragButton.classList.add("drag-button");

    // 简洁态只保留站点工具、上一条、播放、下一条和二级收起按钮。
    selectionButton.classList.add("expanded-only");
    textButton.classList.add("expanded-only");
    settingsButton.classList.add("expanded-only");
    dragButton.classList.add("expanded-only");

    this.playButton.addEventListener("click", actions.onTogglePlayback);
    this.previousButton.addEventListener("click", actions.onPrevious);
    this.nextButton.addEventListener("click", actions.onNext);
    selectionButton.addEventListener("click", actions.onPlaySelection);
    textButton.addEventListener("click", () => this.toggleInputPanel());
    settingsButton.addEventListener("click", () => this.openSettingsPanel());
    this.collapseButton.addEventListener("click", () => this.advanceCollapseMode());
    this.initializeDragging(dragButton);

    if (siteTools !== null) {
      const siteToolsButton = this.createButton("site-tools", siteTools.title);
      siteToolsButton.addEventListener("click", () => this.toggleSiteToolPanel());
      this.controlBarElement.append(siteToolsButton);
    }

    this.controlBarElement.append(
      this.previousButton,
      this.playButton,
      this.nextButton,
      selectionButton,
      textButton,
      settingsButton,
      this.collapseButton,
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

    this.siteToolPanel = document.createElement("div");
    this.siteToolPanel.className = "site-tool-panel";
    this.siteToolPanel.hidden = true;
    if (siteTools !== null) {
      this.siteToolPanel.setAttribute("aria-label", siteTools.title);
      for (const action of siteTools.actions) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "site-tool-action";
        button.textContent = action.label;
        button.title = action.description;
        if (action.isAvailable) {
          this.siteToolActionVisibility.push({
            button,
            isAvailable: action.isAvailable,
          });
          button.hidden = !action.isAvailable();
        }
        button.addEventListener("click", () => {
          this.siteToolPanel.hidden = true;
          action.activate();
        });
        this.siteToolPanel.append(button);
      }
    }

    this.settingsOverlayHost = this.createSettingsOverlay();

    shadowRoot.append(
      this.controlBarElement,
      this.inputPanel,
      this.siteToolPanel,
    );
    document.documentElement.append(this.host);
    document.documentElement.append(this.launcherHost);
    document.documentElement.append(this.settingsOverlayHost);
    this.renderVisibility();
    void this.restoreCompactState();

    // 拖动后使用固定 left/top；视口缩小时重新约束，避免控制栏留在不可见区域。
    const handleViewportResize = (): void => {
      window.requestAnimationFrame(() => {
        this.constrainToViewport();
        this.constrainLauncherToViewport();
        this.constrainInputPanelToViewport();
      });
    };
    window.addEventListener("resize", handleViewportResize);
    window.visualViewport?.addEventListener("resize", handleViewportResize);
    window.visualViewport?.addEventListener("scroll", handleViewportResize);

    // 捕获阶段监听可避免网站阻止冒泡后扩展无法感知外部点击。
    document.addEventListener(
      "pointerdown",
      (event) => {
        if (!event.composedPath().includes(this.host)) {
          this.closeAllPanels();
        }
      },
      true,
    );

    // Escape 统一关闭所有弹层，但不阻止网页继续处理同一个键盘事件。
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        this.closeAllPanels();
      }
    }, true);
  }

  /** 根据播放器状态更新主按钮的图标、说明和可用性。 */
  public renderState(state: PlaybackState): void {
    this.isLoading = state.status === "loading";
    this.playButton.disabled = this.isLoading || !this.hasPageItems;

    if (state.status === "loading") {
      this.setPlayButton("loading", "正在准备播放");
    } else if (state.status === "playing") {
      this.setPlayButton("pause", "暂停播放");
    } else if (state.status === "paused") {
      this.setPlayButton("play", "恢复播放");
    } else {
      this.setPlayButton("play", "播放页面文本");
    }
  }

  /** 根据页面队列位置控制上一条/下一条按钮的边界可用性。 */
  public renderNavigation(currentIndex: number, total: number): void {
    this.hasPageItems = total > 0;
    this.previousButton.disabled = total === 0 || currentIndex <= 0;
    this.nextButton.disabled = total === 0 || currentIndex >= total - 1;
    this.playButton.disabled = !this.hasPageItems || this.isLoading;
  }

  /** 全局关闭时同时隐藏完整控制栏和收起后的启动图标。 */
  public setGlobalEnabled(enabled: boolean): void {
    this.isGloballyEnabled = enabled;
    this.renderVisibility();
    if (!enabled) {
      this.closeAllPanels();
    }
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
    // 收起时元素没有布局尺寸。若此时读取 DOMRect，会得到 left=0、width=0，
    // 随后的约束会误把浮动条位置永久写成左侧安全边距。
    if (this.host.hidden || this.mode === "collapsed") {
      return;
    }

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
    const availableHorizontalSpace = maximumLeft - safeMargin;
    const availableVerticalSpace = maximumTop - safeMargin;
    const isExplicitMove = requestedLeft !== undefined || requestedTop !== undefined;

    // 拖动时使用请求坐标；缩放和重新展开时使用相对位置。这样靠右、居中、
    // 靠下等关系不会因视口尺寸变化而退化为旧的绝对像素坐标。
    const candidateLeft = requestedLeft ?? (
      this.horizontalPositionRatio === null
        ? currentRect.left
        : safeMargin + availableHorizontalSpace * this.horizontalPositionRatio
    );
    const candidateTop = requestedTop ?? (
      this.verticalPositionRatio === null
        ? currentRect.top
        : safeMargin + availableVerticalSpace * this.verticalPositionRatio
    );
    const left = Math.min(maximumLeft, Math.max(safeMargin, candidateLeft));
    const top = Math.min(maximumTop, Math.max(safeMargin, candidateTop));

    if (isExplicitMove || this.horizontalPositionRatio === null) {
      this.horizontalPositionRatio = availableHorizontalSpace > 0
        ? (left - safeMargin) / availableHorizontalSpace
        : 0;
    }
    if (isExplicitMove || this.verticalPositionRatio === null) {
      this.verticalPositionRatio = availableVerticalSpace > 0
        ? (top - safeMargin) / availableVerticalSpace
        : 0;
    }

    this.host.style.right = "auto";
    this.host.style.transform = "none";
    this.host.style.left = `${left}px`;
    this.host.style.top = `${top}px`;
  }

  /** 展开或关闭文本输入层，并在展开后把键盘焦点移到文本框。 */
  private toggleInputPanel(): void {
    this.siteToolPanel.hidden = true;
    this.inputPanel.hidden = !this.inputPanel.hidden;
    this.showInputMessage("");
    if (!this.inputPanel.hidden) {
      this.constrainInputPanelToViewport();
      this.textInput.focus();
      // Android 软键盘会在 focus 后改变 visualViewport，再补一次布局以避免短暂越界。
      window.requestAnimationFrame(() => this.constrainInputPanelToViewport());
    }
  }

  /**
   * 根据移动端实际可视窗口限制文本输入层尺寸和位置。
   * visualViewport 能反映地址栏、屏幕方向及软键盘占用后的区域；通过 transform 校正
   * 绝对定位弹层，不改变浮动条自身位置和用户保存的拖动比例。
   */
  private constrainInputPanelToViewport(): void {
    if (this.inputPanel.hidden) {
      return;
    }

    const viewport = window.visualViewport;
    const viewportLeft = viewport?.offsetLeft ?? 0;
    const viewportTop = viewport?.offsetTop ?? 0;
    const viewportWidth = viewport?.width ?? document.documentElement.clientWidth;
    const viewportHeight = viewport?.height ?? document.documentElement.clientHeight;
    const safeMargin = 12;

    this.inputPanel.style.width = `${Math.min(336, Math.max(160, viewportWidth - safeMargin * 2))}px`;
    this.textInput.style.height = `${Math.min(220, Math.max(96, viewportHeight - 120))}px`;
    this.inputPanel.style.transform = "none";

    const rect = this.inputPanel.getBoundingClientRect();
    const minimumLeft = viewportLeft + safeMargin;
    const maximumRight = viewportLeft + viewportWidth - safeMargin;
    const minimumTop = viewportTop + safeMargin;
    const maximumBottom = viewportTop + viewportHeight - safeMargin;
    let translateX = 0;
    let translateY = 0;

    if (rect.left < minimumLeft) {
      translateX = minimumLeft - rect.left;
    } else if (rect.right > maximumRight) {
      translateX = maximumRight - rect.right;
    }
    if (rect.top < minimumTop) {
      translateY = minimumTop - rect.top;
    } else if (rect.bottom > maximumBottom) {
      translateY = maximumBottom - rect.bottom;
    }

    this.inputPanel.style.transform =
      `translate(${translateX}px, ${translateY}px)`;
  }

  /** 切换当前网站提供的工具面板，并关闭其他互斥弹层。 */
  private toggleSiteToolPanel(): void {
    this.inputPanel.hidden = true;
    for (const action of this.siteToolActionVisibility) {
      action.button.hidden = !action.isAvailable();
    }
    this.siteToolPanel.hidden = !this.siteToolPanel.hidden;
  }

  /** 关闭浮动条内所有弹层以及独立设置遮罩。 */
  private closeAllPanels(): void {
    this.inputPanel.hidden = true;
    this.siteToolPanel.hidden = true;
    this.settingsOverlayHost.hidden = true;
  }

  /** 在网页上方打开通用设置页，绕过 Edge Android 不可用的 action.openPopup。 */
  private openSettingsPanel(): void {
    this.inputPanel.hidden = true;
    this.siteToolPanel.hidden = true;
    this.settingsOverlayHost.hidden = false;
  }

  /**
   * 用独立 Shadow DOM 承载设置页，避免网页样式污染，同时让桌面 popup 与移动端
   * 浮动面板复用同一个 settings.html 和 settings.ts。
   */
  private createSettingsOverlay(): HTMLDivElement {
    const overlayHost = document.createElement("div");
    overlayHost.id = "chrome-tts-settings-overlay";
    overlayHost.hidden = true;
    const shadowRoot = overlayHost.attachShadow({ mode: "closed" });

    const style = document.createElement("style");
    style.textContent = `
      :host {
        all: initial;
        position: fixed;
        inset: 0;
        z-index: 2147483647;
        display: grid;
        place-items: center;
        padding: 16px;
        box-sizing: border-box;
        background: rgb(0 0 0 / 35%);
        color-scheme: light;
      }

      :host([hidden]) {
        display: none;
      }

      .dialog {
        position: relative;
        width: min(380px, calc(100vw - 32px));
        height: min(620px, calc(100vh - 32px));
        overflow: hidden;
        border: 1px solid rgb(0 0 0 / 15%);
        border-radius: 14px;
        background: #fff;
        box-shadow: 0 12px 38px rgb(0 0 0 / 28%);
      }

      iframe {
        display: block;
        width: 100%;
        height: 100%;
        border: 0;
        background: #fff;
      }

      button {
        position: absolute;
        top: 10px;
        right: 10px;
        z-index: 1;
        display: grid;
        place-items: center;
        width: 32px;
        height: 32px;
        padding: 0;
        border: 0;
        border-radius: 8px;
        color: #3c4043;
        background: #f1f3f4;
        cursor: pointer;
        font: 22px/1 sans-serif;
      }

      button:focus-visible {
        outline: 2px solid #1a73e8;
        outline-offset: 2px;
      }
    `;

    const dialog = document.createElement("div");
    dialog.className = "dialog";
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("aria-modal", "true");
    dialog.setAttribute("aria-label", "Chrome TTS 设置");

    const closeButton = document.createElement("button");
    closeButton.type = "button";
    closeButton.textContent = "×";
    closeButton.title = "关闭设置";
    closeButton.setAttribute("aria-label", "关闭设置");
    closeButton.addEventListener("click", () => {
      overlayHost.hidden = true;
    });

    const frame = document.createElement("iframe");
    frame.src = chrome.runtime.getURL("settings.html?embedded=1");
    frame.title = "Chrome TTS 设置";

    dialog.append(closeButton, frame);
    shadowRoot.append(style, dialog);
    overlayHost.addEventListener("pointerdown", (event) => {
      if (event.composedPath().includes(dialog)) {
        return;
      }
      overlayHost.hidden = true;
    });
    return overlayHost;
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
      case "previous":
        appendShape("path", { d: "M18 5 8 12l10 7z", fill: "currentColor", stroke: "none" });
        appendShape("path", { d: "M6 5v14" });
        break;
      case "play":
        appendShape("path", { d: "M8 5v14l11-7z", fill: "currentColor", stroke: "none" });
        break;
      case "pause":
        appendShape("rect", { x: "6", y: "5", width: "4", height: "14", rx: "1", fill: "currentColor", stroke: "none" });
        appendShape("rect", { x: "14", y: "5", width: "4", height: "14", rx: "1", fill: "currentColor", stroke: "none" });
        break;
      case "next":
        appendShape("path", { d: "m6 5 10 7-10 7z", fill: "currentColor", stroke: "none" });
        appendShape("path", { d: "M18 5v14" });
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
      case "settings":
        // 使用完整齿轮轮廓，避免中心圆加放射线在视觉上被识别为亮度按钮。
        appendShape("path", {
          d: "M19.14 12.94c.04-.31.06-.63.06-.94s-.02-.63-.07-.94l2.03-1.58a.5.5 0 0 0 .12-.64l-1.92-3.32a.5.5 0 0 0-.61-.22l-2.39.96a7.1 7.1 0 0 0-1.62-.94L14.38 2.8a.49.49 0 0 0-.49-.4h-3.84a.49.49 0 0 0-.49.4L9.2 5.34c-.58.24-1.12.55-1.62.94L5.19 5.32a.49.49 0 0 0-.61.22L2.66 8.86a.49.49 0 0 0 .12.64l2.03 1.58c-.05.31-.08.64-.08.96s.03.63.08.94l-2.03 1.58a.5.5 0 0 0-.12.64l1.92 3.32c.13.23.4.32.61.22l2.39-.96c.5.39 1.04.71 1.62.94l.36 2.54c.04.24.24.4.49.4h3.84c.25 0 .45-.16.49-.4l.36-2.54c.58-.24 1.12-.55 1.62-.94l2.39.96c.23.08.49 0 .61-.22l1.92-3.32a.5.5 0 0 0-.12-.64zM12 15.5A3.5 3.5 0 1 1 12 8a3.5 3.5 0 0 1 0 7.5z",
          fill: "currentColor",
          stroke: "none",
        });
        break;
      case "site-tools":
        appendShape("rect", { x: "4", y: "4", width: "6", height: "6", rx: "1" });
        appendShape("rect", { x: "14", y: "4", width: "6", height: "6", rx: "1" });
        appendShape("rect", { x: "4", y: "14", width: "6", height: "6", rx: "1" });
        appendShape("path", { d: "M14 17h6M17 14v6" });
        break;
      case "drag":
        for (const x of [9, 15]) {
          for (const y of [6, 12, 18]) {
            appendShape("circle", { cx: String(x), cy: String(y), r: "1.4", fill: "currentColor", stroke: "none" });
          }
        }
        break;
      case "compact":
        // “退出全屏”式四角图形表示从完整控制栏压缩为简洁控制栏。
        appendShape("path", { d: "M9 3v6H3M15 3v6h6M9 21v-6H3M15 21v-6h6" });
        break;
      case "collapse":
        appendShape("path", { d: "m9 5 7 7-7 7" });
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

      :host([hidden]) {
        display: none;
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

      .control-bar.is-compact .expanded-only {
        display: none;
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
        box-sizing: border-box;
        width: min(336px, calc(100vw - 24px));
        max-height: calc(100vh - 24px);
        overflow: auto;
        padding: 10px;
        border: 1px solid rgb(0 0 0 / 12%);
        border-radius: 10px;
        background: #fff;
        box-shadow: 0 5px 20px rgb(0 0 0 / 18%);
      }

      .input-panel[hidden] {
        display: none;
      }

      .site-tool-panel {
        position: absolute;
        top: 0;
        right: 54px;
        display: grid;
        gap: 7px;
        box-sizing: border-box;
        width: 180px;
        padding: 10px;
        border: 1px solid rgb(0 0 0 / 12%);
        border-radius: 10px;
        background: #fff;
        box-shadow: 0 5px 20px rgb(0 0 0 / 18%);
      }

      .site-tool-panel[hidden] {
        display: none;
      }

      .site-tool-action {
        box-sizing: border-box;
        width: 100%;
        min-height: 36px;
        padding: 8px 10px;
        border: 0;
        border-radius: 7px;
        color: #202124;
        background: #f1f3f4;
        cursor: pointer;
        font: 600 13px/1.2 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        text-align: left;
      }

      .site-tool-action:hover {
        background: #e3e7ea;
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

  /** 启动图标使用独立 fixed 宿主，始终固定在窗口右上角且不继承浮动条拖动位置。 */
  private createLauncher(): HTMLDivElement {
    const host = document.createElement("div");
    host.id = "chrome-tts-collapsed-launcher";
    host.hidden = true;
    const shadow = host.attachShadow({ mode: "closed" });
    const style = document.createElement("style");
    style.textContent = `
      :host {
        all: initial;
        position: fixed;
        right: max(16px, env(safe-area-inset-right));
        top: max(16px, env(safe-area-inset-top));
        z-index: 2147483647;
        display: block;
        color-scheme: light;
      }
      :host([hidden]) {
        display: none;
      }
      button {
        display: grid;
        place-items: center;
        box-sizing: border-box;
        width: 46px;
        height: 46px;
        padding: 7px;
        border: 1px solid rgb(0 0 0 / 14%);
        border-radius: 14px;
        background: rgb(255 255 255 / 96%);
        box-shadow: 0 5px 20px rgb(0 0 0 / 22%);
        cursor: pointer;
      }
      button:hover {
        background: #f1f3f4;
      }
      button:focus-visible {
        outline: 3px solid rgb(26 115 232 / 35%);
        outline-offset: 2px;
      }
      img {
        display: block;
        width: 32px;
        height: 32px;
        object-fit: contain;
      }
    `;
    const button = document.createElement("button");
    button.type = "button";
    button.title = "展开 Chrome TTS 快捷控制栏";
    button.setAttribute("aria-label", "展开 Chrome TTS 快捷控制栏");
    const icon = document.createElement("img");
    icon.src = chrome.runtime.getURL("assets/icons/icon-48.png");
    icon.alt = "";
    icon.setAttribute("aria-hidden", "true");
    button.append(icon);
    button.addEventListener("click", () => this.expand());
    shadow.append(style, button);
    return host;
  }

  /**
   * 完整控制栏第一次点击进入简洁态，第二次点击才完全隐藏。
   * 每次改变尺寸前记录相对位置，改变后再按新尺寸约束，避免靠近底部或右侧时越界。
   */
  private advanceCollapseMode(): void {
    this.modeRevision += 1;
    const currentRect = this.controlBarElement.getBoundingClientRect();
    this.constrainToViewport(currentRect.left, currentRect.top);
    this.closeAllPanels();

    if (this.mode === "expanded") {
      this.mode = "compact";
      this.queueCompactStateWrite(true);
      this.renderVisibility();
      window.requestAnimationFrame(() => this.constrainToViewport());
      return;
    }

    this.mode = "collapsed";
    this.queueCompactStateWrite(false);
    this.renderVisibility();
  }

  private expand(): void {
    this.modeRevision += 1;
    this.mode = "expanded";
    this.queueCompactStateWrite(false);
    this.renderVisibility();
    window.requestAnimationFrame(() => this.constrainToViewport());
  }

  /**
   * 页面初始化时只识别值为 true 的简洁态标记。读取完成前若用户已操作浮动条，
   * 通过 revision 放弃旧读取结果，防止异步恢复覆盖用户刚刚选择的新状态。
   */
  private async restoreCompactState(): Promise<void> {
    const revisionAtStart = this.modeRevision;
    try {
      const stored = await chrome.storage.local.get(this.compactStateStorageKey);
      if (
        this.modeRevision !== revisionAtStart ||
        stored[this.compactStateStorageKey] !== true
      ) {
        return;
      }

      this.mode = "compact";
      this.renderVisibility();
      window.requestAnimationFrame(() => this.constrainToViewport());
    } catch {
      // 状态持久化属于辅助功能；存储不可用时保留站点原有默认显示状态。
    }
  }

  /**
   * 只有简洁态写入 true；完整态和隐藏态删除键，因此 storage 中不存在其他状态。
   * 写操作串行执行，保证快速连续点击后最后一次状态不会被较早的异步写入覆盖。
   */
  private queueCompactStateWrite(isCompact: boolean): void {
    this.compactStateWriteQueue = this.compactStateWriteQueue
      .then(async () => {
        if (isCompact) {
          await chrome.storage.local.set({ [this.compactStateStorageKey]: true });
        } else {
          await chrome.storage.local.remove(this.compactStateStorageKey);
        }
      })
      .catch(() => {
        // 存储失败不阻断浮动条当前页面内的状态切换。
      });
  }

  /**
   * 启动图标以 CSS 固定在右上角；额外根据 visualViewport 校正缩放和平移后的可见区域。
   * 这能覆盖移动端地址栏变化、窗口缩放和页面放大后布局视口与可视视口不一致的情况。
   */
  private constrainLauncherToViewport(): void {
    if (this.launcherHost.hidden) {
      return;
    }

    this.launcherHost.style.transform = "none";
    const rect = this.launcherHost.getBoundingClientRect();
    const viewport = window.visualViewport;
    const viewportLeft = viewport?.offsetLeft ?? 0;
    const viewportTop = viewport?.offsetTop ?? 0;
    const viewportWidth = viewport?.width ?? document.documentElement.clientWidth;
    const safeMargin = 16;
    const desiredLeft = viewportLeft + viewportWidth - rect.width - safeMargin;
    const desiredTop = viewportTop + safeMargin;
    this.launcherHost.style.transform =
      `translate(${desiredLeft - rect.left}px, ${desiredTop - rect.top}px)`;
  }

  /** 同步三种显示状态，并为两级收起动作设置不同图标和辅助说明。 */
  private renderVisibility(): void {
    const isCollapsed = this.mode === "collapsed";
    this.host.hidden = !this.isGloballyEnabled || isCollapsed;
    this.launcherHost.hidden = !this.isGloballyEnabled || !isCollapsed;
    this.controlBarElement.classList.toggle("is-compact", this.mode === "compact");

    const collapseIcon: ControlIcon = this.mode === "compact" ? "collapse" : "compact";
    const collapseDescription = this.mode === "compact"
      ? "隐藏快捷控制栏"
      : "切换为简洁控制栏";
    this.collapseButton.replaceChildren(this.createIcon(collapseIcon));
    this.collapseButton.title = collapseDescription;
    this.collapseButton.setAttribute("aria-label", collapseDescription);

    if (!this.launcherHost.hidden) {
      window.requestAnimationFrame(() => this.constrainLauncherToViewport());
    }
  }
}
