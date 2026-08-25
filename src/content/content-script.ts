import { resolvePageAdapter } from "./adapters/adapter-resolver";
import type { PageAdapter } from "./adapters/types";
import { VisibleTextAdapter } from "./adapters/visible-text-adapter";
import {
  type ExtensionEvent,
  type ExtensionRequest,
  type ExtensionResponse,
} from "../shared/messages";
import type {
  ExtensionError,
  ExtensionSettings,
  PageTextItem,
  PlaybackState,
} from "../shared/models";
import {
  DEFAULT_SETTINGS,
  loadSettings,
  SETTINGS_KEY,
  updateSettings,
} from "../shared/settings";
import { ErrorFeedback } from "./error-feedback";
import { FloatingControlBar } from "./floating-control-bar";
import { PageHighlighter } from "./page-highlighter";
import { SelectionJumpPrompt } from "./selection-jump-prompt";

/** 通用模式支持所有普通 HTTP/HTTPS 页面；浏览器内部页面不允许注入 content script。 */
function isSupportedPage(url: URL): boolean {
  return url.protocol === "http:" || url.protocol === "https:";
}

/** 扩展重新加载后旧 content script 仍留在页面中，但其 runtime 上下文已经不可调用。 */
function hasValidExtensionContext(): boolean {
  try {
    return typeof chrome.runtime.id === "string" && chrome.runtime.id.length > 0;
  } catch {
    return false;
  }
}

async function sendRequest(request: ExtensionRequest): Promise<PlaybackState> {
  if (!hasValidExtensionContext()) {
    throw new Error("扩展已重新加载，请刷新当前页面。");
  }
  const response = (await chrome.runtime.sendMessage(
    request,
  )) as ExtensionResponse;
  if (!response.ok) {
    throw new Error(response.error);
  }
  return response.state;
}

if (isSupportedPage(new URL(window.location.href))) {
  initializePagePlayback(resolvePageAdapter(new URL(window.location.href)));
}

/** 初始化通用页面队列、QuickPanel、高亮、动态扫描和自动选择播放。 */
function initializePagePlayback(defaultAdapter: PageAdapter): void {
  const errorFeedback = new ErrorFeedback();
  const visibleTextAdapter = new VisibleTextAdapter();
  let activeAdapter: PageAdapter = defaultAdapter;
  // 高亮器始终通过代理访问当前模式，避免修改其既有生命周期和 DOM 映射逻辑。
  const adapterProxy: PageAdapter = {
    id: "active-adapter-proxy",
    priority: 0,
    matches: (url) => activeAdapter.matches(url),
    scanTextItems: () => activeAdapter.scanTextItems(),
    findTextElement: (itemId) => activeAdapter.findTextElement(itemId),
    findSelectionPosition: (selection) =>
      activeAdapter.findSelectionPosition(selection),
  };
  const highlighter = new PageHighlighter(adapterProxy);
  const selectionJumpPrompt = new SelectionJumpPrompt((position) => {
    void executePageCommand({
      type: "page:play-from-position",
      itemId: position.itemId,
      charIndex: position.charIndex,
    });
  });
  let items: PageTextItem[] = [];
  let currentItemId: string | null = null;
  let lastSelectedText = "";
  let lastAutoSelectionText = "";
  let selectionTimer: number | null = null;
  let scanTimer: number | null = null;
  let settings: ExtensionSettings = { ...DEFAULT_SETTINGS };
  let latestState: PlaybackState = {
    status: "idle",
    source: null,
    itemId: null,
    updatedAt: Date.now(),
  };
  let keepAlivePort: chrome.runtime.Port | null = null;
  let keepAliveTimer: number | null = null;

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
          message: "请先选择网页文本。",
          source: "content",
          recoverable: true,
        });
        return;
      }
      void executePlayerRequest({
        type: "player:play-text",
        text,
        source: "selection",
      });
    },
    onPlayText(text) {
      void executePlayerRequest({
        type: "player:play-text",
        text,
        source: "input",
      });
    },
    onRateChange(rate) {
      void saveSettings({ rate });
    },
    onVolumeChange(volume) {
      void saveSettings({ volume });
    },
    onOpenSettings() {
      void sendRequest({ type: "settings:open" }).catch((error: unknown) => {
        showError(createContentError("OPEN_SETTINGS_FAILED", error));
      });
    },
  });

  /** 统一渲染同步响应；异步 TTS 事件随后由 onMessage 继续更新。 */
  async function executePlayerRequest(request: ExtensionRequest): Promise<void> {
    try {
      renderPlaybackState(await sendRequest(request));
    } catch (error: unknown) {
      showError(createContentError("PLAYER_REQUEST_FAILED", error));
    }
  }

  /**
   * 页面命令前重发当前队列。
   * MV3 service worker 空闲回收后内存 Map 会清空，这一步保证首次点击即可恢复队列。
   */
  async function executePageCommand(
    request:
      | { type: "page:toggle" }
      | { type: "page:previous" }
      | { type: "page:next" }
      | {
          type: "page:play-from-position";
          itemId: string;
          charIndex: number;
        },
  ): Promise<void> {
    try {
      await sendRequest({ type: "page:set-items", items });
      renderPlaybackState(await sendRequest(request));
    } catch (error: unknown) {
      showError(createContentError("PAGE_COMMAND_FAILED", error));
    }
  }

  function renderPlaybackState(state: PlaybackState): void {
    latestState = state;
    updatePlayerKeepAlive(state);
    controlBar.renderState(state);
    if (!settings.globalEnabled) {
      highlighter.clear();
      return;
    }
    if (state.source === "page" && state.itemId) {
      currentItemId = state.itemId;
      if (
        state.status === "loading" ||
        state.status === "playing" ||
        state.status === "paused"
      ) {
        highlighter.highlight(state.itemId);
      } else {
        // 停止、完成或出错后保留队列位置，但正文不再显示为正在朗读。
        highlighter.clear();
      }
      renderNavigation();
    }
    if (state.status === "error" && state.errorMessage) {
      showError({
        code: "TTS_PLAYBACK_ERROR",
        message: state.errorMessage,
        source: "tts",
        recoverable: true,
      });
    }
  }

  /** 全局关闭会隐藏全部入口并停止当前页面拥有的话语，重新开启只恢复界面。 */
  async function applyGlobalActivation(
    nextSettings: ExtensionSettings,
  ): Promise<void> {
    controlBar.setGlobalEnabled(nextSettings.globalEnabled);
    if (nextSettings.globalEnabled) {
      return;
    }

    selectionJumpPrompt.hide();
    highlighter.clear();
    if (
      latestState.status === "loading" ||
      latestState.status === "playing" ||
      latestState.status === "paused"
    ) {
      renderPlaybackState(await sendRequest({ type: "player:stop" }));
    }
  }

  /** 按固定顺序应用会影响页面运行状态的设置，避免模式切换与全局关闭并发。 */
  async function applyRuntimeSettings(
    nextSettings: ExtensionSettings,
  ): Promise<void> {
    controlBar.renderSettings(nextSettings);
    await applyGlobalActivation(nextSettings);
    await applyTextScanMode(nextSettings);
  }

  /** 播放和暂停期间定时向 service worker 发消息，保护长话语的 TTS 事件监听。 */
  function updatePlayerKeepAlive(state: PlaybackState): void {
    const shouldKeepAlive =
      state.status === "loading" ||
      state.status === "playing" ||
      state.status === "paused";
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
      // 扩展重新加载会同步使旧 content script 的 runtime 失效，停止后不再重连。
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
      if (
        hasValidExtensionContext() &&
        (latestState.status === "loading" ||
          latestState.status === "playing" ||
          latestState.status === "paused")
      ) {
        window.setTimeout(() => updatePlayerKeepAlive(latestState), 500);
      }
    });
    keepAliveTimer = window.setInterval(() => {
      try {
        keepAlivePort?.postMessage({ type: "player:keep-alive" });
      } catch {
        // 断开事件负责重新连接；这里避免页面控制逻辑被瞬时端口错误中断。
      }
    }, 20_000);
  }

  function stopPlayerKeepAlive(): void {
    if (keepAliveTimer !== null) {
      window.clearInterval(keepAliveTimer);
      keepAliveTimer = null;
    }
    const port = keepAlivePort;
    keepAlivePort = null;
    try {
      port?.disconnect();
    } catch {
      // 上下文已经失效时端口无需再次处理。
    }
  }

  function renderNavigation(): void {
    const currentIndex = currentItemId
      ? items.findIndex((item) => item.id === currentItemId)
      : 0;
    controlBar.renderNavigation(Math.max(currentIndex, 0), items.length);
  }

  /** 扫描结果只有发生实质变化时才发送，避免 MutationObserver 产生无效队列更新。 */
  async function scanPage(): Promise<void> {
    const scanningAdapter = activeAdapter;
    const nextItems = scanningAdapter.scanTextItems();
    // 设置切换可能与延迟扫描并发，旧适配器结果不得覆盖新模式队列。
    if (scanningAdapter !== activeAdapter) {
      return;
    }
    const previousSignature = items
      .map((item) => `${item.id}:${item.text}`)
      .join("|");
    const nextSignature = nextItems
      .map((item) => `${item.id}:${item.text}`)
      .join("|");
    items = nextItems;
    highlighter.refresh();
    renderNavigation();

    if (previousSignature !== nextSignature) {
      await executePlayerRequest({ type: "page:set-items", items });
    }
  }

  /** 切换扫描模式时停止旧队列并重新扫描；相同模式不做任何操作。 */
  async function applyTextScanMode(nextSettings: ExtensionSettings): Promise<void> {
    const nextAdapter = nextSettings.playAllVisibleText
      ? visibleTextAdapter
      : defaultAdapter;
    if (nextAdapter === activeAdapter) {
      return;
    }

    if (
      latestState.status === "loading" ||
      latestState.status === "playing" ||
      latestState.status === "paused"
    ) {
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

  async function saveSettings(
    changes: Partial<Pick<ExtensionSettings, "rate" | "volume">>,
  ): Promise<void> {
    try {
      settings = await updateSettings(changes);
      controlBar.renderSettings(settings);
    } catch (error: unknown) {
      showError(createContentError("SAVE_SETTINGS_FAILED", error));
    }
  }

  function scheduleSelectionAutoPlay(event: Event): void {
    if (!settings.globalEnabled) {
      selectionJumpPrompt.hide();
      return;
    }
    const target = event.target;
    if (
      target instanceof Element &&
      target.closest(
        "#chrome-tts-floating-control-bar, #chrome-tts-error-feedback, " +
          "#chrome-tts-selection-jump-prompt, " +
          "#chrome-tts-collapsed-launcher",
      )
    ) {
      return;
    }
    // 部分网站会在 pointerup 后立即清除 Selection，因此必须在事件当下保存最终文本。
    const capturedText = getSelectedText();
    const selection = window.getSelection();
    const selectionPosition = selection
      ? activeAdapter.findSelectionPosition(selection)
      : null;
    const selectionRect = getSelectionRect(selection);
    if (capturedText) {
      lastSelectedText = capturedText;
    }
    if (selectionTimer !== null) {
      window.clearTimeout(selectionTimer);
    }
    selectionTimer = window.setTimeout(() => {
      selectionTimer = null;
      if (
        settings.showSelectionJumpPrompt &&
        selectionPosition &&
        selectionRect
      ) {
        selectionJumpPrompt.show(selectionRect, selectionPosition);
      } else {
        selectionJumpPrompt.hide();
      }
      void autoPlayCurrentSelection(capturedText);
    }, 150);
  }

  async function autoPlayCurrentSelection(capturedText: string): Promise<void> {
    const text = capturedText || getSelectedText();
    if (!text) {
      lastAutoSelectionText = "";
      return;
    }
    lastSelectedText = text;
    if (!settings.autoPlaySelection || text === lastAutoSelectionText) {
      return;
    }
    if (
      latestState.status === "loading" ||
      latestState.status === "playing" ||
      latestState.status === "paused"
    ) {
      return;
    }

    lastAutoSelectionText = text;
    await executePlayerRequest({ type: "selection:auto-play", text });
  }

  function showError(error: ExtensionError): void {
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

  chrome.runtime.onMessage.addListener((message: unknown) => {
    if (typeof message !== "object" || message === null || !("type" in message)) {
      return;
    }
    const event = message as ExtensionEvent;
    if (event.type === "player:state-changed") {
      renderPlaybackState(event.state);
    } else if (event.type === "player:position-changed") {
      highlighter.highlightPosition(
        event.position.itemId,
        event.position.charIndex,
        event.position.length,
      );
    } else if (event.type === "extension:error") {
      showError(event.error);
    }
  });

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName === "local" && SETTINGS_KEY in changes) {
      void loadSettings()
        .then((nextSettings) => {
          settings = nextSettings;
          if (!nextSettings.showSelectionJumpPrompt) {
            selectionJumpPrompt.hide();
          }
          void applyRuntimeSettings(nextSettings).catch((error: unknown) => {
            showError(createContentError("APPLY_SETTINGS_FAILED", error));
          });
        })
        .catch((error: unknown) => {
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
      void scanPage().catch((error: unknown) => {
        showError(createContentError("PAGE_SCAN_FAILED", error));
      });
    }, 300);
  });
  observer.observe(document.body, {
    childList: true,
    characterData: true,
    subtree: true,
  });

  void loadSettings()
    .then((loadedSettings) => {
      settings = loadedSettings;
      return applyRuntimeSettings(loadedSettings);
    })
    .catch((error: unknown) => {
      showError(createContentError("LOAD_SETTINGS_FAILED", error));
    });
  void scanPage().catch((error: unknown) => {
    showError(createContentError("PAGE_SCAN_FAILED", error));
  });
  void executePlayerRequest({ type: "player:get-state" });
}

function getSelectedText(): string {
  return window.getSelection()?.toString().replace(/\s+/g, " ").trim() ?? "";
}

/** 返回当前选区在视口中的可见矩形；无有效范围时不显示跳转按钮。 */
function getSelectionRect(selection: Selection | null): DOMRect | null {
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

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function createContentError(code: string, error: unknown): ExtensionError {
  return {
    code,
    message: getErrorMessage(error),
    source: "content",
    recoverable: true,
  };
}
