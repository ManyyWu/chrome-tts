"use strict";
(() => {
  // src/content/adapters/generic-page-adapter.ts
  var CANDIDATE_SELECTOR = "h1, h2, h3, h4, h5, h6, p, li, blockquote, figcaption, td, th";
  var EXCLUDED_ANCESTOR_SELECTOR = "nav, header, footer, aside, form, dialog, button, input, textarea, select, script, style, noscript, template, [hidden], [aria-hidden='true'], #chrome-tts-floating-control-bar, #chrome-tts-error-feedback, #chrome-tts-selection-jump-prompt, #chrome-tts-position-overlay, #chrome-tts-collapsed-launcher";
  var GenericPageAdapter = class {
    id = "generic";
    priority = 0;
    elementsById = /* @__PURE__ */ new Map();
    matches(_url) {
      return true;
    }
    /** 扫描可见块级文本，过滤页面框架、重复父子内容和无意义短文本。 */
    scanTextItems() {
      this.elementsById.clear();
      const root = this.findContentRoot();
      const candidates = Array.from(
        root.querySelectorAll(CANDIDATE_SELECTOR)
      );
      const acceptedElements = candidates.filter(
        (element) => this.isAcceptedElement(element)
      );
      const acceptedSet = new Set(acceptedElements);
      const seenText = /* @__PURE__ */ new Set();
      const items = [];
      for (const element of acceptedElements) {
        if (Array.from(element.querySelectorAll(CANDIDATE_SELECTOR)).some(
          (child) => child !== element && acceptedSet.has(child)
        )) {
          continue;
        }
        const text = normalizeText(element.innerText);
        if (seenText.has(text)) {
          continue;
        }
        seenText.add(text);
        const id = `generic:${createDomPath(element)}:${hashText(text)}`;
        const item = { id, text, index: items.length };
        items.push(item);
        this.elementsById.set(id, element);
      }
      return items;
    }
    findTextElement(itemId) {
      const element = this.elementsById.get(itemId) ?? null;
      return element?.isConnected === true ? element : null;
    }
    /** 把选区起点转换为规范化段落文本中的字符位置，供“跳转”从该处开始播放。 */
    findSelectionPosition(selection) {
      if (selection.rangeCount === 0 || selection.isCollapsed) {
        return null;
      }
      const selectedRange = selection.getRangeAt(0);
      for (const [itemId, element] of this.elementsById) {
        if (!element.contains(selectedRange.startContainer)) {
          continue;
        }
        const prefixRange = document.createRange();
        prefixRange.selectNodeContents(element);
        try {
          prefixRange.setEnd(
            selectedRange.startContainer,
            selectedRange.startOffset
          );
        } catch {
          return null;
        }
        const fullText = normalizeText(element.innerText);
        const normalizedPrefix = prefixRange.toString().replace(/\s+/g, " ").trimStart();
        return {
          itemId,
          charIndex: Math.min(fullText.length, normalizedPrefix.length)
        };
      }
      return null;
    }
    /** 优先正文语义容器；没有时才扫描 body，减少导航和侧栏进入队列的概率。 */
    findContentRoot() {
      const main = document.querySelector("main");
      if (main) {
        return main;
      }
      const roleMain = document.querySelector("[role='main']");
      if (roleMain) {
        return roleMain;
      }
      const articles = document.querySelectorAll("article");
      return articles.length === 1 ? articles[0] ?? document.body : document.body;
    }
    isAcceptedElement(element) {
      if (element.closest(EXCLUDED_ANCESTOR_SELECTOR)) {
        return false;
      }
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      if (style.display === "none" || style.visibility === "hidden" || rect.width <= 0 || rect.height <= 0) {
        return false;
      }
      const text = normalizeText(element.innerText);
      const isHeading = /^H[1-6]$/.test(element.tagName);
      const minimumLength = isHeading ? 2 : 5;
      return text.length >= minimumLength && text.length <= 32768 && /[\p{L}\p{N}]/u.test(text);
    }
  };
  function normalizeText(text) {
    return text.replace(/\s+/g, " ").trim();
  }
  function createDomPath(element) {
    const segments = [];
    let current = element;
    while (current && current !== document.body) {
      const parent = current.parentElement;
      const siblings = parent ? Array.from(parent.children).filter(
        (sibling) => sibling.tagName === current?.tagName
      ) : [];
      const position = Math.max(0, siblings.indexOf(current)) + 1;
      segments.push(`${current.tagName.toLowerCase()}[${position}]`);
      current = parent;
    }
    return segments.reverse().join("/");
  }
  function hashText(text) {
    let hash = 2166136261;
    for (let index = 0; index < text.length; index += 1) {
      hash ^= text.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(16).padStart(8, "0");
  }

  // src/content/adapters/adapter-resolver.ts
  function resolvePageAdapter(url) {
    const adapters = [new GenericPageAdapter()];
    const matched = adapters.filter((adapter) => adapter.matches(url)).sort((first, second) => second.priority - first.priority)[0];
    if (!matched) {
      throw new Error("\u5F53\u524D\u9875\u9762\u6CA1\u6709\u53EF\u7528\u7684\u6587\u672C\u9002\u914D\u5668\u3002");
    }
    return matched;
  }

  // src/content/adapters/visible-text-adapter.ts
  var EXCLUDED_SELECTOR = "script, style, noscript, template, [hidden], [aria-hidden='true'], input, textarea, select, option, #chrome-tts-floating-control-bar, #chrome-tts-error-feedback, #chrome-tts-selection-jump-prompt, #chrome-tts-position-overlay, #chrome-tts-collapsed-launcher";
  var VisibleTextAdapter = class {
    id = "visible-text";
    priority = 0;
    elementsById = /* @__PURE__ */ new Map();
    matches(_url) {
      return true;
    }
    /** 遍历普通 DOM 中已渲染的文本节点，并按文档顺序生成播放条目。 */
    scanTextItems() {
      this.elementsById.clear();
      const textNodesByGroup = /* @__PURE__ */ new Map();
      const walker = document.createTreeWalker(
        document.body,
        NodeFilter.SHOW_TEXT,
        {
          acceptNode: (node2) => this.isVisibleTextNode(node2) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT
        }
      );
      let node = walker.nextNode();
      while (node) {
        const group = this.findTextGroup(node);
        if (group) {
          const groupedNodes = textNodesByGroup.get(group) ?? [];
          groupedNodes.push(node);
          textNodesByGroup.set(group, groupedNodes);
        }
        node = walker.nextNode();
      }
      const groupsWithNestedGroups = /* @__PURE__ */ new Set();
      for (const group of textNodesByGroup.keys()) {
        let ancestor = group.parentElement;
        while (ancestor && ancestor !== document.body) {
          if (textNodesByGroup.has(ancestor)) {
            groupsWithNestedGroups.add(ancestor);
          }
          ancestor = ancestor.parentElement;
        }
      }
      const items = [];
      for (const [element, groupedNodes] of textNodesByGroup) {
        const text = groupsWithNestedGroups.has(element) ? normalizeText2(groupedNodes.map((node2) => node2.data).join(" ")) : normalizeText2(element.innerText);
        if (!text || text.length > 32768) {
          continue;
        }
        const id = `visible:${createDomPath2(element)}:${hashText2(text)}`;
        items.push({ id, text, index: items.length });
        this.elementsById.set(id, element);
      }
      return items;
    }
    findTextElement(itemId) {
      const element = this.elementsById.get(itemId) ?? null;
      return element?.isConnected === true ? element : null;
    }
    /** 将选区起点映射到当前可见文本条目的规范化字符索引。 */
    findSelectionPosition(selection) {
      if (selection.rangeCount === 0 || selection.isCollapsed) {
        return null;
      }
      const selectedRange = selection.getRangeAt(0);
      for (const [itemId, element] of this.elementsById) {
        if (!element.contains(selectedRange.startContainer)) {
          continue;
        }
        const prefixRange = document.createRange();
        prefixRange.selectNodeContents(element);
        try {
          prefixRange.setEnd(
            selectedRange.startContainer,
            selectedRange.startOffset
          );
        } catch {
          return null;
        }
        const fullText = normalizeText2(element.innerText);
        const normalizedPrefix = prefixRange.toString().replace(/\s+/g, " ").trimStart();
        return {
          itemId,
          charIndex: Math.min(fullText.length, normalizedPrefix.length)
        };
      }
      return null;
    }
    /** 文本节点及其父元素必须实际渲染，隐藏区域和扩展自身界面全部排除。 */
    isVisibleTextNode(node) {
      if (!node.data.trim()) {
        return false;
      }
      const parent = node.parentElement;
      if (!parent || parent.closest(EXCLUDED_SELECTOR)) {
        return false;
      }
      let element = parent;
      while (element) {
        const style = window.getComputedStyle(element);
        if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0" || style.contentVisibility === "hidden") {
          return false;
        }
        element = element.parentElement;
      }
      return parent.getClientRects().length > 0;
    }
    /** 优先最近的块级或可交互容器，使朗读分段接近页面视觉分组。 */
    findTextGroup(node) {
      let element = node.parentElement;
      while (element && element !== document.body) {
        const display = window.getComputedStyle(element).display;
        if (element.matches(
          "button, label, summary, h1, h2, h3, h4, h5, h6, p, li, blockquote, figcaption, td, th, dt, dd, pre"
        ) || display === "block" || display === "flex" || display === "grid" || display === "list-item" || display === "table-cell") {
          return element;
        }
        element = element.parentElement;
      }
      return node.parentElement;
    }
  };
  function normalizeText2(text) {
    return text.replace(/\s+/g, " ").trim();
  }
  function createDomPath2(element) {
    const segments = [];
    let current = element;
    while (current && current !== document.body) {
      const parent = current.parentElement;
      const siblings = parent ? Array.from(parent.children).filter(
        (sibling) => sibling.tagName === current?.tagName
      ) : [];
      const position = Math.max(0, siblings.indexOf(current)) + 1;
      segments.push(`${current.tagName.toLowerCase()}[${position}]`);
      current = parent;
    }
    return segments.reverse().join("/");
  }
  function hashText2(text) {
    let hash = 2166136261;
    for (let index = 0; index < text.length; index += 1) {
      hash ^= text.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(16).padStart(8, "0");
  }

  // src/shared/settings.ts
  var SETTINGS_KEY = "extensionSettings";
  var DEFAULT_SETTINGS = {
    version: 6,
    voiceName: null,
    voiceExtensionId: null,
    lang: null,
    rate: 1,
    volume: 1,
    highlightBorderColor: "#22a06b",
    highlightBackgroundColor: "#e6f6ef",
    autoPlaySelection: false,
    showSelectionJumpPrompt: false,
    playAllVisibleText: false,
    globalEnabled: true
  };
  function clamp(value, minimum, maximum) {
    return Math.min(maximum, Math.max(minimum, value));
  }
  function isNullableString(value) {
    return value === null || typeof value === "string";
  }
  function normalizeColor(value, fallback) {
    return typeof value === "string" && /^#[0-9a-f]{6}$/iu.test(value) ? value.toLowerCase() : fallback;
  }
  function normalizeSettings(value) {
    if (typeof value !== "object" || value === null) {
      return { ...DEFAULT_SETTINGS };
    }
    const stored = value;
    const rate = typeof stored.rate === "number" && Number.isFinite(stored.rate) ? clamp(Math.round(stored.rate * 10) / 10, 0.5, 1.5) : DEFAULT_SETTINGS.rate;
    const volume = typeof stored.volume === "number" && Number.isFinite(stored.volume) ? clamp(stored.volume, 0, 1) : DEFAULT_SETTINGS.volume;
    return {
      version: 6,
      voiceName: isNullableString(stored.voiceName) ? stored.voiceName : DEFAULT_SETTINGS.voiceName,
      voiceExtensionId: isNullableString(stored.voiceExtensionId) ? stored.voiceExtensionId : DEFAULT_SETTINGS.voiceExtensionId,
      lang: isNullableString(stored.lang) ? stored.lang : DEFAULT_SETTINGS.lang,
      rate,
      volume,
      highlightBorderColor: normalizeColor(
        stored.highlightBorderColor,
        DEFAULT_SETTINGS.highlightBorderColor
      ),
      highlightBackgroundColor: normalizeColor(
        stored.highlightBackgroundColor,
        DEFAULT_SETTINGS.highlightBackgroundColor
      ),
      autoPlaySelection: typeof stored.autoPlaySelection === "boolean" ? stored.autoPlaySelection : DEFAULT_SETTINGS.autoPlaySelection,
      showSelectionJumpPrompt: typeof stored.showSelectionJumpPrompt === "boolean" ? stored.showSelectionJumpPrompt : DEFAULT_SETTINGS.showSelectionJumpPrompt,
      playAllVisibleText: typeof stored.playAllVisibleText === "boolean" ? stored.playAllVisibleText : DEFAULT_SETTINGS.playAllVisibleText,
      globalEnabled: typeof stored.globalEnabled === "boolean" ? stored.globalEnabled : DEFAULT_SETTINGS.globalEnabled
    };
  }
  async function loadSettings() {
    const result = await chrome.storage.local.get(SETTINGS_KEY);
    const storedValue = result[SETTINGS_KEY];
    const settings = normalizeSettings(storedValue);
    if (JSON.stringify(storedValue) !== JSON.stringify(settings)) {
      await chrome.storage.local.set({ [SETTINGS_KEY]: settings });
    }
    return settings;
  }

  // src/content/error-feedback.ts
  var ErrorFeedback = class {
    host;
    messageElement;
    hideTimer = null;
    lastErrorKey = "";
    lastShownAt = 0;
    constructor() {
      this.host = document.createElement("div");
      this.host.id = "chrome-tts-error-feedback";
      this.host.hidden = true;
      const shadowRoot = this.host.attachShadow({ mode: "closed" });
      const style = document.createElement("style");
      style.textContent = `
      :host {
        all: initial;
        position: fixed;
        top: 18px;
        left: 50%;
        z-index: 2147483647;
        transform: translateX(-50%);
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }

      /* all: initial \u4F1A\u8986\u76D6\u6D4F\u89C8\u5668\u5BF9 hidden \u5C5E\u6027\u7684\u9ED8\u8BA4 display: none\uFF0C\u5FC5\u987B\u663E\u5F0F\u6062\u590D\u3002 */
      :host([hidden]) {
        display: none;
      }

      .toast {
        box-sizing: border-box;
        max-width: min(560px, calc(100vw - 32px));
        padding: 11px 16px;
        border: 1px solid rgb(179 38 30 / 35%);
        border-radius: 9px;
        color: #7d1b16;
        background: #fce8e6;
        box-shadow: 0 5px 20px rgb(0 0 0 / 20%);
        font-size: 14px;
        font-weight: 600;
        line-height: 1.45;
        word-break: break-word;
      }
    `;
      this.messageElement = document.createElement("div");
      this.messageElement.className = "toast";
      this.messageElement.setAttribute("role", "alert");
      shadowRoot.append(style, this.messageElement);
      document.documentElement.append(this.host);
      this.host.addEventListener("mouseenter", () => this.clearHideTimer());
      this.host.addEventListener("mouseleave", () => this.scheduleHide());
    }
    /** 显示错误；一秒内完全相同的错误只刷新倒计时，不重复播放提示音。 */
    show(error) {
      const now = Date.now();
      const errorKey = `${error.code}:${error.message}`;
      const isDuplicate = errorKey === this.lastErrorKey && now - this.lastShownAt < 1e3;
      this.lastErrorKey = errorKey;
      this.lastShownAt = now;
      this.messageElement.textContent = error.message;
      this.host.hidden = false;
      this.scheduleHide();
      if (!isDuplicate) {
        void this.playErrorTone();
      }
    }
    /** 使用两个短振荡器音调生成提示音，不依赖远程或二进制音频资源。 */
    async playErrorTone() {
      try {
        const audioContext = new AudioContext();
        await audioContext.resume();
        const gain = audioContext.createGain();
        gain.gain.setValueAtTime(1e-4, audioContext.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.12, audioContext.currentTime + 0.01);
        gain.gain.exponentialRampToValueAtTime(1e-4, audioContext.currentTime + 0.22);
        gain.connect(audioContext.destination);
        const oscillator = audioContext.createOscillator();
        oscillator.type = "sine";
        oscillator.frequency.setValueAtTime(520, audioContext.currentTime);
        oscillator.frequency.setValueAtTime(390, audioContext.currentTime + 0.1);
        oscillator.connect(gain);
        oscillator.start();
        oscillator.stop(audioContext.currentTime + 0.23);
        oscillator.addEventListener("ended", () => {
          void audioContext.close();
        });
      } catch {
      }
    }
    /** 重新安排自动隐藏，保证最新错误拥有完整阅读时间。 */
    scheduleHide() {
      this.clearHideTimer();
      this.hideTimer = window.setTimeout(() => {
        this.host.hidden = true;
        this.hideTimer = null;
      }, 5e3);
    }
    clearHideTimer() {
      if (this.hideTimer !== null) {
        window.clearTimeout(this.hideTimer);
        this.hideTimer = null;
      }
    }
  };

  // src/content/floating-control-bar.ts
  var FloatingControlBar = class {
    host;
    launcherHost;
    controlBarElement;
    playButton;
    previousButton;
    nextButton;
    inputPanel;
    textInput;
    inputMessage;
    siteToolPanel;
    settingsOverlayHost;
    hasPageItems = false;
    isLoading = false;
    isCollapsed = false;
    isGloballyEnabled = true;
    horizontalPositionRatio = null;
    verticalPositionRatio = null;
    constructor(actions, siteTools = null, startExpanded = false) {
      this.isCollapsed = !startExpanded;
      this.host = document.createElement("div");
      this.host.id = "chrome-tts-floating-control-bar";
      const shadowRoot = this.host.attachShadow({ mode: "closed" });
      shadowRoot.append(this.createStyles());
      this.launcherHost = this.createLauncher();
      this.controlBarElement = document.createElement("div");
      this.controlBarElement.className = "control-bar";
      this.controlBarElement.setAttribute("role", "toolbar");
      this.controlBarElement.setAttribute("aria-label", "Chrome TTS \u5FEB\u6377\u63A7\u5236\u680F");
      this.previousButton = this.createButton("previous", "\u64AD\u653E\u4E0A\u4E00\u6761");
      this.playButton = this.createButton("play", "\u64AD\u653E\u9875\u9762\u6587\u672C");
      this.nextButton = this.createButton("next", "\u64AD\u653E\u4E0B\u4E00\u6761");
      const selectionButton = this.createButton("selection", "\u64AD\u653E\u9009\u4E2D\u6587\u672C");
      const textButton = this.createButton("text", "\u8F93\u5165\u6587\u672C\u5E76\u64AD\u653E");
      const settingsButton = this.createButton("settings", "\u6253\u5F00\u8BBE\u7F6E");
      const collapseButton = this.createButton("collapse", "\u6536\u8D77\u5FEB\u6377\u63A7\u5236\u680F");
      const dragButton = this.createButton("drag", "\u62D6\u52A8\u5FEB\u6377\u63A7\u5236\u680F");
      dragButton.classList.add("drag-button");
      this.playButton.addEventListener("click", actions.onTogglePlayback);
      this.previousButton.addEventListener("click", actions.onPrevious);
      this.nextButton.addEventListener("click", actions.onNext);
      selectionButton.addEventListener("click", actions.onPlaySelection);
      textButton.addEventListener("click", () => this.toggleInputPanel());
      settingsButton.addEventListener("click", () => this.openSettingsPanel());
      collapseButton.addEventListener("click", () => this.collapse());
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
        collapseButton,
        dragButton
      );
      this.inputPanel = document.createElement("div");
      this.inputPanel.className = "input-panel";
      this.inputPanel.hidden = true;
      this.textInput = document.createElement("textarea");
      this.textInput.placeholder = "\u8F93\u5165\u9700\u8981\u6717\u8BFB\u7684\u6587\u672C";
      this.textInput.maxLength = 32768;
      this.textInput.setAttribute("aria-label", "\u9700\u8981\u6717\u8BFB\u7684\u6587\u672C");
      const actionRow = document.createElement("div");
      actionRow.className = "input-actions";
      const pasteButton = document.createElement("button");
      pasteButton.type = "button";
      pasteButton.className = "paste-button";
      pasteButton.textContent = "\u7C98\u8D34";
      pasteButton.title = "\u4ECE\u526A\u8D34\u677F\u7C98\u8D34\u6587\u672C";
      pasteButton.setAttribute("aria-label", "\u4ECE\u526A\u8D34\u677F\u7C98\u8D34\u6587\u672C");
      pasteButton.addEventListener("click", () => {
        void this.pasteClipboardText();
      });
      const submitButton = document.createElement("button");
      submitButton.type = "button";
      submitButton.className = "submit-button";
      submitButton.textContent = "\u64AD\u653E";
      submitButton.addEventListener("click", () => {
        const text = this.textInput.value.trim();
        if (!text) {
          this.showInputMessage("\u8BF7\u8F93\u5165\u6587\u672C\u3002");
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
        this.siteToolPanel
      );
      document.documentElement.append(this.host);
      document.documentElement.append(this.launcherHost);
      document.documentElement.append(this.settingsOverlayHost);
      this.renderVisibility();
      const handleViewportResize = () => {
        window.requestAnimationFrame(() => {
          this.constrainToViewport();
          this.constrainInputPanelToViewport();
        });
      };
      window.addEventListener("resize", handleViewportResize);
      window.visualViewport?.addEventListener("resize", handleViewportResize);
      document.addEventListener(
        "pointerdown",
        (event) => {
          if (!event.composedPath().includes(this.host)) {
            this.closeAllPanels();
          }
        },
        true
      );
      document.addEventListener("keydown", (event) => {
        if (event.key === "Escape") {
          this.closeAllPanels();
        }
      }, true);
    }
    /** 根据播放器状态更新主按钮的图标、说明和可用性。 */
    renderState(state) {
      this.isLoading = state.status === "loading";
      this.playButton.disabled = this.isLoading || !this.hasPageItems;
      if (state.status === "loading") {
        this.setPlayButton("loading", "\u6B63\u5728\u51C6\u5907\u64AD\u653E");
      } else if (state.status === "playing") {
        this.setPlayButton("pause", "\u6682\u505C\u64AD\u653E");
      } else if (state.status === "paused") {
        this.setPlayButton("play", "\u6062\u590D\u64AD\u653E");
      } else {
        this.setPlayButton("play", "\u64AD\u653E\u9875\u9762\u6587\u672C");
      }
    }
    /** 根据页面队列位置控制上一条/下一条按钮的边界可用性。 */
    renderNavigation(currentIndex, total) {
      this.hasPageItems = total > 0;
      this.previousButton.disabled = total === 0 || currentIndex <= 0;
      this.nextButton.disabled = total === 0 || currentIndex >= total - 1;
      this.playButton.disabled = !this.hasPageItems || this.isLoading;
    }
    /** 全局关闭时同时隐藏完整控制栏和收起后的启动图标。 */
    setGlobalEnabled(enabled) {
      this.isGloballyEnabled = enabled;
      this.renderVisibility();
      if (!enabled) {
        this.closeAllPanels();
      }
    }
    /** 在输入层中显示临时提示，第三阶段统一替换为网页顶部错误 toast。 */
    showInputMessage(message) {
      this.inputMessage.textContent = message;
    }
    /** 创建统一尺寸的图标按钮，title 与 aria-label 同时提供可访问说明。 */
    createButton(icon, description) {
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
    initializeDragging(dragButton) {
      dragButton.addEventListener("pointerdown", (event) => {
        if (event.button !== 0) {
          return;
        }
        event.preventDefault();
        const initialRect = this.controlBarElement.getBoundingClientRect();
        const pointerOffsetX = event.clientX - initialRect.left;
        const pointerOffsetY = event.clientY - initialRect.top;
        this.constrainToViewport(initialRect.left, initialRect.top);
        dragButton.classList.add("is-dragging");
        dragButton.setPointerCapture(event.pointerId);
        const handlePointerMove = (moveEvent) => {
          this.constrainToViewport(
            moveEvent.clientX - pointerOffsetX,
            moveEvent.clientY - pointerOffsetY
          );
        };
        const finishDragging = (finishEvent) => {
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
    constrainToViewport(requestedLeft, requestedTop) {
      if (this.host.hidden || this.isCollapsed) {
        return;
      }
      const currentRect = this.controlBarElement.getBoundingClientRect();
      const safeMargin = 16;
      const visualViewport = window.visualViewport;
      const viewportWidth = Math.min(
        document.documentElement.clientWidth,
        visualViewport?.width ?? window.innerWidth
      );
      const viewportHeight = Math.min(
        document.documentElement.clientHeight,
        visualViewport?.height ?? window.innerHeight
      );
      const maximumLeft = Math.max(
        safeMargin,
        viewportWidth - currentRect.width - safeMargin
      );
      const maximumTop = Math.max(
        safeMargin,
        viewportHeight - currentRect.height - safeMargin
      );
      const availableHorizontalSpace = maximumLeft - safeMargin;
      const availableVerticalSpace = maximumTop - safeMargin;
      const isExplicitMove = requestedLeft !== void 0 || requestedTop !== void 0;
      const candidateLeft = requestedLeft ?? (this.horizontalPositionRatio === null ? currentRect.left : safeMargin + availableHorizontalSpace * this.horizontalPositionRatio);
      const candidateTop = requestedTop ?? (this.verticalPositionRatio === null ? currentRect.top : safeMargin + availableVerticalSpace * this.verticalPositionRatio);
      const left = Math.min(maximumLeft, Math.max(safeMargin, candidateLeft));
      const top = Math.min(maximumTop, Math.max(safeMargin, candidateTop));
      if (isExplicitMove || this.horizontalPositionRatio === null) {
        this.horizontalPositionRatio = availableHorizontalSpace > 0 ? (left - safeMargin) / availableHorizontalSpace : 0;
      }
      if (isExplicitMove || this.verticalPositionRatio === null) {
        this.verticalPositionRatio = availableVerticalSpace > 0 ? (top - safeMargin) / availableVerticalSpace : 0;
      }
      this.host.style.right = "auto";
      this.host.style.transform = "none";
      this.host.style.left = `${left}px`;
      this.host.style.top = `${top}px`;
    }
    /** 展开或关闭文本输入层，并在展开后把键盘焦点移到文本框。 */
    toggleInputPanel() {
      this.siteToolPanel.hidden = true;
      this.inputPanel.hidden = !this.inputPanel.hidden;
      this.showInputMessage("");
      if (!this.inputPanel.hidden) {
        this.constrainInputPanelToViewport();
        this.textInput.focus();
        window.requestAnimationFrame(() => this.constrainInputPanelToViewport());
      }
    }
    /**
     * 根据移动端实际可视窗口限制文本输入层尺寸和位置。
     * visualViewport 能反映地址栏、屏幕方向及软键盘占用后的区域；通过 transform 校正
     * 绝对定位弹层，不改变浮动条自身位置和用户保存的拖动比例。
     */
    constrainInputPanelToViewport() {
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
      this.inputPanel.style.transform = `translate(${translateX}px, ${translateY}px)`;
    }
    /** 切换当前网站提供的工具面板，并关闭其他互斥弹层。 */
    toggleSiteToolPanel() {
      this.inputPanel.hidden = true;
      this.siteToolPanel.hidden = !this.siteToolPanel.hidden;
    }
    /** 关闭浮动条内所有弹层以及独立设置遮罩。 */
    closeAllPanels() {
      this.inputPanel.hidden = true;
      this.siteToolPanel.hidden = true;
      this.settingsOverlayHost.hidden = true;
    }
    /** 在网页上方打开通用设置页，绕过 Edge Android 不可用的 action.openPopup。 */
    openSettingsPanel() {
      this.inputPanel.hidden = true;
      this.siteToolPanel.hidden = true;
      this.settingsOverlayHost.hidden = false;
    }
    /**
     * 用独立 Shadow DOM 承载设置页，避免网页样式污染，同时让桌面 popup 与移动端
     * 浮动面板复用同一个 settings.html 和 settings.ts。
     */
    createSettingsOverlay() {
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
      dialog.setAttribute("aria-label", "Chrome TTS \u8BBE\u7F6E");
      const closeButton = document.createElement("button");
      closeButton.type = "button";
      closeButton.textContent = "\xD7";
      closeButton.title = "\u5173\u95ED\u8BBE\u7F6E";
      closeButton.setAttribute("aria-label", "\u5173\u95ED\u8BBE\u7F6E");
      closeButton.addEventListener("click", () => {
        overlayHost.hidden = true;
      });
      const frame = document.createElement("iframe");
      frame.src = chrome.runtime.getURL("settings.html?embedded=1");
      frame.title = "Chrome TTS \u8BBE\u7F6E";
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
    async pasteClipboardText() {
      try {
        const clipboardText = await navigator.clipboard.readText();
        if (!clipboardText) {
          this.showInputMessage("\u526A\u8D34\u677F\u4E2D\u6CA1\u6709\u6587\u672C\u3002");
          return;
        }
        this.textInput.value = clipboardText.slice(0, this.textInput.maxLength);
        this.showInputMessage("");
        this.textInput.focus();
        this.textInput.setSelectionRange(
          this.textInput.value.length,
          this.textInput.value.length
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.showInputMessage(`\u8BFB\u53D6\u526A\u8D34\u677F\u5931\u8D25\uFF1A${message}`);
      }
    }
    /** 同步主按钮的可见符号与辅助说明。 */
    setPlayButton(icon, description) {
      this.playButton.replaceChildren(this.createIcon(icon));
      this.playButton.title = description;
      this.playButton.setAttribute("aria-label", description);
    }
    /** 创建统一为 20×20 的内联 SVG，避免字体和系统 emoji 导致图标大小不一致。 */
    createIcon(icon) {
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
      const appendShape = (tagName, attributes) => {
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
          appendShape("path", {
            d: "M19.14 12.94c.04-.31.06-.63.06-.94s-.02-.63-.07-.94l2.03-1.58a.5.5 0 0 0 .12-.64l-1.92-3.32a.5.5 0 0 0-.61-.22l-2.39.96a7.1 7.1 0 0 0-1.62-.94L14.38 2.8a.49.49 0 0 0-.49-.4h-3.84a.49.49 0 0 0-.49.4L9.2 5.34c-.58.24-1.12.55-1.62.94L5.19 5.32a.49.49 0 0 0-.61.22L2.66 8.86a.49.49 0 0 0 .12.64l2.03 1.58c-.05.31-.08.64-.08.96s.03.63.08.94l-2.03 1.58a.5.5 0 0 0-.12.64l1.92 3.32c.13.23.4.32.61.22l2.39-.96c.5.39 1.04.71 1.62.94l.36 2.54c.04.24.24.4.49.4h3.84c.25 0 .45-.16.49-.4l.36-2.54c.58-.24 1.12-.55 1.62-.94l2.39.96c.23.08.49 0 .61-.22l1.92-3.32a.5.5 0 0 0-.12-.64zM12 15.5A3.5 3.5 0 1 1 12 8a3.5 3.5 0 0 1 0 7.5z",
            fill: "currentColor",
            stroke: "none"
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
    createStyles() {
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
    /** 启动图标使用独立 fixed 宿主，始终固定在窗口右下角且不继承浮动条拖动位置。 */
    createLauncher() {
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
        bottom: max(16px, env(safe-area-inset-bottom));
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
      button.title = "\u5C55\u5F00 Chrome TTS \u5FEB\u6377\u63A7\u5236\u680F";
      button.setAttribute("aria-label", "\u5C55\u5F00 Chrome TTS \u5FEB\u6377\u63A7\u5236\u680F");
      const icon = document.createElement("img");
      icon.src = chrome.runtime.getURL("assets/icons/icon-48.png");
      icon.alt = "";
      icon.setAttribute("aria-hidden", "true");
      button.append(icon);
      button.addEventListener("click", () => this.expand());
      shadow.append(style, button);
      return host;
    }
    collapse() {
      const currentRect = this.controlBarElement.getBoundingClientRect();
      this.constrainToViewport(currentRect.left, currentRect.top);
      this.isCollapsed = true;
      this.closeAllPanels();
      this.renderVisibility();
    }
    expand() {
      this.isCollapsed = false;
      this.renderVisibility();
      window.requestAnimationFrame(() => this.constrainToViewport());
    }
    renderVisibility() {
      this.host.hidden = !this.isGloballyEnabled || this.isCollapsed;
      this.launcherHost.hidden = !this.isGloballyEnabled || !this.isCollapsed;
    }
  };

  // src/content/page-highlighter.ts
  var CURRENT_CLASS = "chrome-tts-current-text";
  var STYLE_ID = "chrome-tts-page-highlight-style";
  var POSITION_HIGHLIGHT_NAME = "chrome-tts-current-position";
  var POSITION_OVERLAY_ID = "chrome-tts-position-overlay";
  var PageHighlighter = class {
    constructor(adapter) {
      this.adapter = adapter;
      const existingStyle = document.getElementById(STYLE_ID);
      this.styleElement = existingStyle instanceof HTMLStyleElement ? existingStyle : document.createElement("style");
      if (!this.styleElement.isConnected) {
        this.styleElement.id = STYLE_ID;
        document.documentElement.append(this.styleElement);
      }
      this.renderColors("#22a06b", "#e6f6ef");
      this.positionOverlay = document.createElement("div");
      this.positionOverlay.id = POSITION_OVERLAY_ID;
      Object.assign(this.positionOverlay.style, {
        position: "fixed",
        inset: "0",
        zIndex: "2147483645",
        pointerEvents: "none",
        overflow: "visible"
      });
      document.documentElement.append(this.positionOverlay);
      window.addEventListener("scroll", () => this.clearPosition(), true);
      window.addEventListener("resize", () => this.clearPosition());
    }
    currentElement = null;
    currentItemId = null;
    mappedElement = null;
    characterMap = [];
    positionOverlay;
    styleElement;
    /** 更新整段高亮配色；颜色已在 storage 归一化，仅写入本扩展专属样式节点。 */
    renderColors(borderColor, backgroundColor) {
      this.styleElement.textContent = `
        .${CURRENT_CLASS} {
          outline: 3px solid ${borderColor} !important;
          outline-offset: 4px !important;
          background: ${backgroundColor} !important;
          transition: background-color 120ms ease, outline-color 120ms ease !important;
        }
        ::highlight(${POSITION_HIGHLIGHT_NAME}) {
          color: #063c2b;
          background-color: #6ee7b7;
          text-decoration: underline 2px #16845b;
          text-underline-offset: 2px;
        }
      `;
    }
    /** 切换整段高亮；只有条目真正变化时才滚动，暂停/恢复不会反复移动页面。 */
    highlight(itemId) {
      const element = this.adapter.findTextElement(itemId);
      if (!element) {
        return;
      }
      const itemChanged = itemId !== this.currentItemId || element !== this.currentElement;
      if (itemChanged) {
        this.clearPosition();
        this.currentElement?.classList.remove(CURRENT_CLASS);
        element.classList.add(CURRENT_CLASS);
        element.scrollIntoView({ behavior: "smooth", block: "center" });
        this.currentElement = element;
        this.currentItemId = itemId;
      }
    }
    /** 按规范化文本索引高亮当前字或词；使用 Range，不插入 span，不破坏网站框架状态。 */
    highlightPosition(itemId, charIndex, length) {
      const element = this.adapter.findTextElement(itemId);
      const registry = getHighlightRegistry();
      if (!element) {
        return;
      }
      if (element !== this.mappedElement) {
        this.mappedElement = element;
        this.characterMap = createNormalizedCharacterMap(element);
      }
      const characters = this.characterMap;
      const startIndex = Math.min(
        characters.length - 1,
        Math.max(0, Math.trunc(charIndex))
      );
      if (startIndex < 0) {
        return;
      }
      const endIndex = Math.min(
        characters.length - 1,
        startIndex + Math.max(1, Math.trunc(length)) - 1
      );
      const start = characters[startIndex];
      const end = characters[endIndex];
      if (!start || !end) {
        return;
      }
      const range = new Range();
      range.setStart(start.node, start.startOffset);
      range.setEnd(end.node, end.endOffset);
      registry?.set(POSITION_HIGHLIGHT_NAME, new Highlight(range));
      this.renderPositionOverlay(range);
    }
    /** 清除当前正文高亮，同时忘记 DOM 引用，下一次播放同一条时仍会重新高亮。 */
    clear() {
      this.clearPosition();
      this.currentElement?.classList.remove(CURRENT_CLASS);
      this.currentElement = null;
      this.currentItemId = null;
      this.mappedElement = null;
      this.characterMap = [];
    }
    clearPosition() {
      getHighlightRegistry()?.delete(POSITION_HIGHLIGHT_NAME);
      this.positionOverlay.replaceChildren();
    }
    /**
     * content script 的 CSS Highlight 注册表在部分页面隔离环境中不会绘制。
     * 用 Range 的视口矩形生成透明覆盖层作为稳定回退，不包裹或拆分正文文本节点。
     */
    renderPositionOverlay(range) {
      this.positionOverlay.replaceChildren();
      for (const rect of Array.from(range.getClientRects())) {
        if (rect.width <= 0 || rect.height <= 0) {
          continue;
        }
        const marker = document.createElement("div");
        Object.assign(marker.style, {
          position: "absolute",
          left: `${rect.left}px`,
          top: `${rect.top}px`,
          width: `${rect.width}px`,
          height: `${rect.height}px`,
          boxSizing: "border-box",
          borderBottom: "2px solid #16845b",
          borderRadius: "3px",
          background: "rgb(110 231 183 / 52%)",
          mixBlendMode: "multiply"
        });
        this.positionOverlay.append(marker);
      }
    }
    /** DOM 重新扫描后用同一 ID 重新绑定可能已被替换的元素。 */
    refresh() {
      this.mappedElement = null;
      this.characterMap = [];
      if (!this.currentItemId) {
        return;
      }
      const replacement = this.adapter.findTextElement(this.currentItemId);
      if (replacement && replacement !== this.currentElement) {
        this.clearPosition();
        this.currentElement?.classList.remove(CURRENT_CLASS);
        replacement.classList.add(CURRENT_CLASS);
        this.currentElement = replacement;
      }
    }
  };
  function getHighlightRegistry() {
    if (!("highlights" in CSS)) {
      return null;
    }
    const registry = CSS.highlights;
    return typeof registry.set === "function" && typeof registry.delete === "function" ? registry : null;
  }
  function createNormalizedCharacterMap(element) {
    const characters = [];
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    let pendingWhitespace = null;
    let currentNode = walker.nextNode();
    while (currentNode) {
      const textNode = currentNode;
      const value = textNode.data;
      for (let offset = 0; offset < value.length; offset += 1) {
        const character = {
          node: textNode,
          startOffset: offset,
          endOffset: offset + 1
        };
        if (/\s/u.test(value[offset] ?? "")) {
          if (characters.length > 0 && pendingWhitespace === null) {
            pendingWhitespace = character;
          }
          continue;
        }
        if (pendingWhitespace !== null) {
          characters.push(pendingWhitespace);
          pendingWhitespace = null;
        }
        characters.push(character);
      }
      currentNode = walker.nextNode();
    }
    return characters;
  }

  // src/content/selection-jump-prompt.ts
  var SelectionJumpPrompt = class {
    constructor(onJump) {
      this.onJump = onJump;
      this.host = document.createElement("div");
      this.host.id = "chrome-tts-selection-jump-prompt";
      this.host.hidden = true;
      const shadow = this.host.attachShadow({ mode: "closed" });
      const style = document.createElement("style");
      style.textContent = `
      :host {
        position: fixed;
        z-index: 2147483647;
        display: block;
      }
      :host([hidden]) {
        display: none;
      }
      button {
        min-width: 58px;
        height: 34px;
        padding: 0 14px;
        border: 1px solid rgb(22 132 91 / 45%);
        border-radius: 17px;
        color: #fff;
        background: #16845b;
        box-shadow: 0 5px 16px rgb(0 0 0 / 22%);
        font: 600 13px/1 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        cursor: pointer;
      }
      button:hover {
        background: #116b4a;
      }
      button:focus-visible {
        outline: 3px solid rgb(52 211 153 / 45%);
        outline-offset: 2px;
      }
    `;
      this.button = document.createElement("button");
      this.button.type = "button";
      this.button.textContent = "\u8DF3\u8F6C";
      this.button.setAttribute("aria-label", "\u4ECE\u9009\u62E9\u4F4D\u7F6E\u5F00\u59CB\u64AD\u653E");
      this.button.addEventListener("pointerdown", (event) => {
        event.preventDefault();
        event.stopPropagation();
      });
      this.button.addEventListener("click", () => {
        const position = this.position;
        this.hide();
        if (position) {
          this.onJump(position);
        }
      });
      shadow.append(style, this.button);
      document.documentElement.append(this.host);
      document.addEventListener(
        "pointerdown",
        (event) => {
          if (!event.composedPath().includes(this.host)) {
            this.hide();
          }
        },
        true
      );
      window.addEventListener("scroll", () => this.hide(), true);
      window.addEventListener("resize", () => this.hide());
    }
    host;
    button;
    position = null;
    /** 根据选区矩形定位，确保按钮完整留在当前视口内。 */
    show(rect, position) {
      this.position = position;
      this.host.hidden = false;
      const margin = 8;
      const width = this.host.offsetWidth;
      const height = this.host.offsetHeight;
      const preferredLeft = rect.left + rect.width / 2 - width / 2;
      const left = Math.min(
        window.innerWidth - width - margin,
        Math.max(margin, preferredLeft)
      );
      const belowTop = rect.bottom + margin;
      const top = belowTop + height <= window.innerHeight - margin ? belowTop : Math.max(margin, rect.top - height - margin);
      this.host.style.left = `${left}px`;
      this.host.style.top = `${top}px`;
    }
    hide() {
      this.host.hidden = true;
      this.position = null;
    }
  };

  // src/content/site-tool-panel.ts
  var END_GFW_TWEET_SELECTOR = 'article[id][itemscope][itemtype="http://schema.org/SocialMediaPosting"]';
  function resolveSiteToolPanel(url, context) {
    return createEndGfwToolPanel(url, context);
  }
  function createEndGfwToolPanel(url, context) {
    const date = parseEndGfwDate(url);
    if (url.hostname !== "end-gfw.com" || url.pathname !== "/tweet-page" || !date) {
      return null;
    }
    return {
      title: "End GFW \u5DE5\u5177",
      actions: [
        {
          id: "copy-tweet-id",
          label: "\u590D\u5236\u63A8\u6587 ID",
          description: "\u590D\u5236\u5F53\u524D\u64AD\u653E\u6216\u5F53\u524D\u53EF\u89C1\u63A8\u6587\u7684 ID",
          activate: () => {
            void copyCurrentTweetId(context).catch((error) => {
              context.reportError(createSiteToolError("COPY_TWEET_ID_FAILED", error));
            });
          }
        },
        {
          id: "previous-day",
          label: "\u4E0A\u4E00\u5929",
          description: "\u8DF3\u8F6C\u5230\u4E0A\u4E00\u5929\u7684\u63A8\u6587\u9875\u9762",
          activate: () => navigateToAdjacentDay(url, date, -1)
        },
        {
          id: "next-day",
          label: "\u4E0B\u4E00\u5929",
          description: "\u8DF3\u8F6C\u5230\u4E0B\u4E00\u5929\u7684\u63A8\u6587\u9875\u9762",
          activate: () => navigateToAdjacentDay(url, date, 1)
        }
      ]
    };
  }
  function parseEndGfwDate(url) {
    const year = Number(url.searchParams.get("year"));
    const month = Number(url.searchParams.get("month"));
    const day = Number(url.searchParams.get("day"));
    if (![year, month, day].every(Number.isInteger)) {
      return null;
    }
    const date = new Date(Date.UTC(year, month - 1, day));
    return date.getUTCFullYear() === year && date.getUTCMonth() + 1 === month && date.getUTCDate() === day ? { year, month, day } : null;
  }
  function navigateToAdjacentDay(currentUrl, currentDate, offset) {
    const date = new Date(
      Date.UTC(currentDate.year, currentDate.month - 1, currentDate.day)
    );
    date.setUTCDate(date.getUTCDate() + offset);
    const targetUrl = new URL(currentUrl.href);
    targetUrl.searchParams.set("year", String(date.getUTCFullYear()));
    targetUrl.searchParams.set(
      "month",
      String(date.getUTCMonth() + 1).padStart(2, "0")
    );
    targetUrl.searchParams.set("day", String(date.getUTCDate()).padStart(2, "0"));
    window.location.assign(targetUrl.href);
  }
  async function copyCurrentTweetId(context) {
    const currentArticle = context.getCurrentTextElement()?.closest(END_GFW_TWEET_SELECTOR);
    const article = currentArticle ?? findNearestVisibleTweet();
    const tweetId = article?.id.trim() ?? "";
    if (!/^\d+$/u.test(tweetId)) {
      throw new Error("\u5F53\u524D\u9875\u9762\u6CA1\u6709\u53EF\u63D0\u53D6\u7684\u63A8\u6587 ID\u3002");
    }
    await writeClipboardText(tweetId);
  }
  function findNearestVisibleTweet() {
    const viewportCenter = (window.visualViewport?.height ?? window.innerHeight) / 2;
    let nearestArticle = null;
    let nearestDistance = Number.POSITIVE_INFINITY;
    const articles = Array.from(
      document.querySelectorAll(END_GFW_TWEET_SELECTOR)
    );
    for (const article of articles) {
      const rect = article.getBoundingClientRect();
      if (rect.bottom <= 0 || rect.top >= window.innerHeight) {
        continue;
      }
      const distance = Math.abs(rect.top + rect.height / 2 - viewportCenter);
      if (distance < nearestDistance) {
        nearestArticle = article;
        nearestDistance = distance;
      }
    }
    return nearestArticle;
  }
  async function writeClipboardText(text) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      const input = document.createElement("textarea");
      input.value = text;
      input.readOnly = true;
      Object.assign(input.style, {
        position: "fixed",
        left: "-10000px",
        top: "0"
      });
      document.documentElement.append(input);
      input.select();
      const copied = document.execCommand("copy");
      input.remove();
      if (!copied) {
        throw new Error("\u590D\u5236\u63A8\u6587 ID \u5931\u8D25\uFF0C\u8BF7\u68C0\u67E5\u6D4F\u89C8\u5668\u526A\u8D34\u677F\u6743\u9650\u3002");
      }
    }
  }
  function createSiteToolError(code, error) {
    return {
      code,
      message: error instanceof Error ? error.message : String(error),
      source: "content",
      recoverable: true
    };
  }

  // src/content/content-script.ts
  function isSupportedPage(url) {
    return url.protocol === "http:" || url.protocol === "https:";
  }
  function hasValidExtensionContext() {
    try {
      return typeof chrome.runtime.id === "string" && chrome.runtime.id.length > 0;
    } catch {
      return false;
    }
  }
  async function sendRequest(request) {
    if (!hasValidExtensionContext()) {
      throw new Error("\u6269\u5C55\u5DF2\u91CD\u65B0\u52A0\u8F7D\uFF0C\u8BF7\u5237\u65B0\u5F53\u524D\u9875\u9762\u3002");
    }
    const response = await chrome.runtime.sendMessage(
      request
    );
    if (!response.ok) {
      throw new Error(response.error);
    }
    return response.state;
  }
  if (isSupportedPage(new URL(window.location.href))) {
    initializePagePlayback(resolvePageAdapter(new URL(window.location.href)));
  }
  function initializePagePlayback(defaultAdapter) {
    const pageSessionId = crypto.randomUUID();
    const errorFeedback = new ErrorFeedback();
    const visibleTextAdapter = new VisibleTextAdapter();
    let activeAdapter = defaultAdapter;
    const adapterProxy = {
      id: "active-adapter-proxy",
      priority: 0,
      matches: (url) => activeAdapter.matches(url),
      scanTextItems: () => activeAdapter.scanTextItems(),
      findTextElement: (itemId) => activeAdapter.findTextElement(itemId),
      findSelectionPosition: (selection) => activeAdapter.findSelectionPosition(selection)
    };
    const highlighter = new PageHighlighter(adapterProxy);
    const selectionJumpPrompt = new SelectionJumpPrompt((position) => {
      void executePageCommand({
        type: "page:play-from-position",
        itemId: position.itemId,
        charIndex: position.charIndex
      });
    });
    let items = [];
    let currentItemId = null;
    let lastSelectedText = "";
    let lastAutoSelectionText = "";
    let selectionTimer = null;
    let scanTimer = null;
    let hasRegisteredPageSession = false;
    let settings = { ...DEFAULT_SETTINGS };
    let latestState = {
      status: "idle",
      source: null,
      itemId: null,
      updatedAt: Date.now()
    };
    let keepAlivePort = null;
    let keepAliveTimer = null;
    const siteToolPanel = resolveSiteToolPanel(new URL(window.location.href), {
      getCurrentTextElement: () => currentItemId === null ? null : activeAdapter.findTextElement(currentItemId),
      reportError: (error) => showError(error)
    });
    const controlBar = new FloatingControlBar({
      onTogglePlayback() {
        void executePageCommand({ type: "page:toggle" });
      },
      onPrevious() {
        void executePageCommand({ type: "page:previous" });
      },
      onNext() {
        void executePageCommand({ type: "page:next" });
      },
      onPlaySelection() {
        const text = getSelectedText() || lastSelectedText;
        if (!text) {
          showError({
            code: "NO_SELECTED_TEXT",
            message: "\u8BF7\u5148\u9009\u62E9\u7F51\u9875\u6587\u672C\u3002",
            source: "content",
            recoverable: true
          });
          return;
        }
        void executePlayerRequest({
          type: "player:play-text",
          text,
          source: "selection"
        });
      },
      onPlayText(text) {
        void executePlayerRequest({
          type: "player:play-text",
          text,
          source: "input"
        });
      }
    }, siteToolPanel, window.location.hostname === "end-gfw.com");
    async function executePlayerRequest(request) {
      try {
        renderPlaybackState(await sendRequest(request));
      } catch (error) {
        showError(createContentError("PLAYER_REQUEST_FAILED", error));
      }
    }
    async function executePageCommand(request) {
      try {
        await sendRequest({ type: "page:set-items", items, pageSessionId });
        renderPlaybackState(await sendRequest(request));
      } catch (error) {
        showError(createContentError("PAGE_COMMAND_FAILED", error));
      }
    }
    function renderPlaybackState(state) {
      latestState = state;
      updatePlayerKeepAlive(state);
      controlBar.renderState(state);
      if (!settings.globalEnabled) {
        highlighter.clear();
        return;
      }
      if (state.source === "page" && state.itemId) {
        currentItemId = state.itemId;
        if (state.status === "loading" || state.status === "playing" || state.status === "paused") {
          highlighter.highlight(state.itemId);
        } else {
          highlighter.clear();
        }
        renderNavigation();
      }
      if (state.status === "error" && state.errorMessage) {
        showError({
          code: "TTS_PLAYBACK_ERROR",
          message: state.errorMessage,
          source: "tts",
          recoverable: true
        });
      }
    }
    async function applyGlobalActivation(nextSettings) {
      controlBar.setGlobalEnabled(nextSettings.globalEnabled);
      if (nextSettings.globalEnabled) {
        return;
      }
      selectionJumpPrompt.hide();
      highlighter.clear();
      if (latestState.status === "loading" || latestState.status === "playing" || latestState.status === "paused") {
        renderPlaybackState(await sendRequest({ type: "player:stop" }));
      }
    }
    async function applyRuntimeSettings(nextSettings) {
      highlighter.renderColors(
        nextSettings.highlightBorderColor,
        nextSettings.highlightBackgroundColor
      );
      await applyGlobalActivation(nextSettings);
      await applyTextScanMode(nextSettings);
    }
    function updatePlayerKeepAlive(state) {
      const shouldKeepAlive = state.status === "loading" || state.status === "playing" || state.status === "paused";
      if (!shouldKeepAlive) {
        stopPlayerKeepAlive();
        return;
      }
      if (keepAlivePort !== null) {
        return;
      }
      if (!hasValidExtensionContext()) {
        stopPlayerKeepAlive();
        return;
      }
      try {
        keepAlivePort = chrome.runtime.connect({ name: "player-keep-alive" });
      } catch {
        keepAlivePort = null;
        stopPlayerKeepAlive();
        return;
      }
      keepAlivePort.onDisconnect.addListener(() => {
        keepAlivePort = null;
        if (keepAliveTimer !== null) {
          window.clearInterval(keepAliveTimer);
          keepAliveTimer = null;
        }
        if (hasValidExtensionContext() && (latestState.status === "loading" || latestState.status === "playing" || latestState.status === "paused")) {
          window.setTimeout(() => updatePlayerKeepAlive(latestState), 500);
        }
      });
      keepAliveTimer = window.setInterval(() => {
        try {
          keepAlivePort?.postMessage({ type: "player:keep-alive" });
        } catch {
        }
      }, 2e4);
    }
    function stopPlayerKeepAlive() {
      if (keepAliveTimer !== null) {
        window.clearInterval(keepAliveTimer);
        keepAliveTimer = null;
      }
      const port = keepAlivePort;
      keepAlivePort = null;
      try {
        port?.disconnect();
      } catch {
      }
    }
    function renderNavigation() {
      const currentIndex = currentItemId ? items.findIndex((item) => item.id === currentItemId) : 0;
      controlBar.renderNavigation(Math.max(currentIndex, 0), items.length);
    }
    async function scanPage() {
      const scanningAdapter = activeAdapter;
      const nextItems = scanningAdapter.scanTextItems();
      if (scanningAdapter !== activeAdapter) {
        return;
      }
      const previousSignature = items.map((item) => `${item.id}:${item.text}`).join("|");
      const nextSignature = nextItems.map((item) => `${item.id}:${item.text}`).join("|");
      items = nextItems;
      highlighter.refresh();
      renderNavigation();
      if (!hasRegisteredPageSession || previousSignature !== nextSignature) {
        await executePlayerRequest({
          type: "page:set-items",
          items,
          pageSessionId
        });
        hasRegisteredPageSession = true;
      }
    }
    async function applyTextScanMode(nextSettings) {
      const nextAdapter = nextSettings.playAllVisibleText ? visibleTextAdapter : defaultAdapter;
      if (nextAdapter === activeAdapter) {
        return;
      }
      if (latestState.status === "loading" || latestState.status === "playing" || latestState.status === "paused") {
        renderPlaybackState(await sendRequest({ type: "player:stop" }));
      }
      highlighter.clear();
      selectionJumpPrompt.hide();
      activeAdapter = nextAdapter;
      items = [];
      currentItemId = null;
      renderNavigation();
      await scanPage();
    }
    function scheduleSelectionAutoPlay(event) {
      if (!settings.globalEnabled) {
        selectionJumpPrompt.hide();
        return;
      }
      const target = event.target;
      if (target instanceof Element && target.closest(
        "#chrome-tts-floating-control-bar, #chrome-tts-error-feedback, #chrome-tts-selection-jump-prompt, #chrome-tts-collapsed-launcher"
      )) {
        return;
      }
      const capturedText = getSelectedText();
      const selection = window.getSelection();
      const selectionPosition = selection ? activeAdapter.findSelectionPosition(selection) : null;
      const selectionRect = getSelectionRect(selection);
      if (capturedText) {
        lastSelectedText = capturedText;
      }
      if (selectionTimer !== null) {
        window.clearTimeout(selectionTimer);
      }
      selectionTimer = window.setTimeout(() => {
        selectionTimer = null;
        if (settings.showSelectionJumpPrompt && selectionPosition && selectionRect) {
          selectionJumpPrompt.show(selectionRect, selectionPosition);
        } else {
          selectionJumpPrompt.hide();
        }
        void autoPlayCurrentSelection(capturedText);
      }, 150);
    }
    async function autoPlayCurrentSelection(capturedText) {
      const text = capturedText || getSelectedText();
      if (!text) {
        lastAutoSelectionText = "";
        return;
      }
      lastSelectedText = text;
      if (!settings.autoPlaySelection || text === lastAutoSelectionText) {
        return;
      }
      if (latestState.status === "loading" || latestState.status === "playing" || latestState.status === "paused") {
        return;
      }
      lastAutoSelectionText = text;
      await executePlayerRequest({ type: "selection:auto-play", text });
    }
    function showError(error) {
      errorFeedback.show(error);
    }
    document.addEventListener("selectionchange", () => {
      const selection = getSelectedText();
      if (selection) {
        lastSelectedText = selection;
      }
    });
    document.addEventListener("pointerup", scheduleSelectionAutoPlay);
    document.addEventListener("keyup", scheduleSelectionAutoPlay);
    chrome.runtime.onMessage.addListener((message) => {
      if (typeof message !== "object" || message === null || !("type" in message)) {
        return;
      }
      const event = message;
      if (event.type === "player:state-changed") {
        renderPlaybackState(event.state);
      } else if (event.type === "player:position-changed") {
        highlighter.highlightPosition(
          event.position.itemId,
          event.position.charIndex,
          event.position.length
        );
      } else if (event.type === "extension:error") {
        showError(event.error);
      }
    });
    chrome.storage.onChanged.addListener((changes, areaName) => {
      if (areaName === "local" && SETTINGS_KEY in changes) {
        void loadSettings().then((nextSettings) => {
          settings = nextSettings;
          if (!nextSettings.showSelectionJumpPrompt) {
            selectionJumpPrompt.hide();
          }
          void applyRuntimeSettings(nextSettings).catch((error) => {
            showError(createContentError("APPLY_SETTINGS_FAILED", error));
          });
        }).catch((error) => {
          showError(createContentError("LOAD_SETTINGS_FAILED", error));
        });
      }
    });
    const observer = new MutationObserver(() => {
      if (scanTimer !== null) {
        window.clearTimeout(scanTimer);
      }
      scanTimer = window.setTimeout(() => {
        scanTimer = null;
        void scanPage().catch((error) => {
          showError(createContentError("PAGE_SCAN_FAILED", error));
        });
      }, 300);
    });
    observer.observe(document.body, {
      childList: true,
      characterData: true,
      subtree: true
    });
    void loadSettings().then((loadedSettings) => {
      settings = loadedSettings;
      return applyRuntimeSettings(loadedSettings);
    }).catch((error) => {
      showError(createContentError("LOAD_SETTINGS_FAILED", error));
    });
    void scanPage().then(() => executePlayerRequest({ type: "player:get-state" })).catch((error) => {
      showError(createContentError("PAGE_SCAN_FAILED", error));
    });
  }
  function getSelectedText() {
    return window.getSelection()?.toString().replace(/\s+/g, " ").trim() ?? "";
  }
  function getSelectionRect(selection) {
    if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
      return null;
    }
    const range = selection.getRangeAt(0);
    const rect = range.getBoundingClientRect();
    if (rect.width > 0 || rect.height > 0) {
      return rect;
    }
    return range.getClientRects()[0] ?? null;
  }
  function getErrorMessage(error) {
    return error instanceof Error ? error.message : String(error);
  }
  function createContentError(code, error) {
    return {
      code,
      message: getErrorMessage(error),
      source: "content",
      recoverable: true
    };
  }
})();
