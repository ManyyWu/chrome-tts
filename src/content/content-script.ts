import {
  type ExtensionEvent,
  type ExtensionRequest,
  type ExtensionResponse,
} from "../shared/messages";
import type {
  ExtensionError,
  ExtensionSettings,
  PlaybackState,
} from "../shared/models";
import {
  loadSettings,
  SETTINGS_KEY,
  updateSettings,
} from "../shared/settings";
import { ErrorFeedback } from "./error-feedback";
import { FloatingControlBar } from "./floating-control-bar";

/**
 * 首版只允许 End GFW 推文页，并要求四个基础查询参数存在。
 * 参数值保持可变；页面适配器阶段再补充更严格的日期和账号校验。
 */
function isSupportedPage(url: URL): boolean {
  return (
    url.origin === "https://end-gfw.com" &&
    url.pathname === "/tweet-page" &&
    ["year", "month", "day", "id"].every((name) =>
      url.searchParams.has(name),
    )
  );
}

/** 向 service worker 发送命令，并把统一失败响应转换为异常。 */
async function sendRequest(request: ExtensionRequest): Promise<PlaybackState> {
  const response = (await chrome.runtime.sendMessage(
    request,
  )) as ExtensionResponse;
  if (!response.ok) {
    throw new Error(response.error);
  }
  return response.state;
}

if (isSupportedPage(new URL(window.location.href))) {
  let lastSelectedText = "";
  const errorFeedback = new ErrorFeedback();

  const controlBar = new FloatingControlBar({
    onTogglePlayback() {
      void executePlayerRequest({ type: "player:toggle-demo" });
    },
    onPlaySelection() {
      const currentSelection = window.getSelection()?.toString().trim() ?? "";
      const text = currentSelection || lastSelectedText;
      if (!text) {
        showError({
          code: "NO_SELECTED_TEXT",
          message: "请先选择网页文本。",
          source: "content",
          recoverable: true,
        });
        return;
      }

      void executePlayerRequest({ type: "player:play-text", text });
    },
    onPlayText(text) {
      void executePlayerRequest({ type: "player:play-text", text });
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

  /** 执行播放器命令并立即渲染响应，异步 TTS 事件随后由消息监听器继续更新。 */
  async function executePlayerRequest(request: ExtensionRequest): Promise<void> {
    try {
      const state = await sendRequest(request);
      controlBar.renderState(state);
      showPlaybackError(state);
    } catch (error: unknown) {
      showError(createContentError("PLAYER_REQUEST_FAILED", error));
    }
  }

  /** 持久化 QuickPanel 设置，并立即以规范化后的结果刷新显示。 */
  async function saveSettings(
    changes: Partial<Pick<ExtensionSettings, "rate" | "volume">>,
  ): Promise<void> {
    try {
      controlBar.renderSettings(await updateSettings(changes));
    } catch (error: unknown) {
      showError(createContentError("SAVE_SETTINGS_FAILED", error));
    }
  }

  function showPlaybackError(state: PlaybackState): void {
    if (state.status === "error" && state.errorMessage) {
      showError({
        code: "TTS_PLAYBACK_ERROR",
        message: state.errorMessage,
        source: "tts",
        recoverable: true,
      });
    }
  }

  function showError(error: ExtensionError): void {
    errorFeedback.show(error);
  }

  // 缓存最近一次非空网页选区，防止点击控制栏时目标网站主动清除 Selection。
  document.addEventListener("selectionchange", () => {
    const selection = window.getSelection()?.toString().trim() ?? "";
    if (selection) {
      lastSelectedText = selection;
    }
  });

  chrome.runtime.onMessage.addListener((message: unknown) => {
    if (typeof message !== "object" || message === null || !("type" in message)) {
      return;
    }

    const event = message as ExtensionEvent;
    if (event.type === "player:state-changed") {
      controlBar.renderState(event.state);
      showPlaybackError(event.state);
    } else if (event.type === "extension:error") {
      showError(event.error);
    }
  });

  // popup 或其他扩展页面修改设置后，QuickPanel 读取完整规范化数据保持同步。
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName === "local" && SETTINGS_KEY in changes) {
      void loadSettings()
        .then((settings) => controlBar.renderSettings(settings))
        .catch((error: unknown) => {
          showError(createContentError("LOAD_SETTINGS_FAILED", error));
        });
    }
  });

  void executePlayerRequest({ type: "player:get-state" });
  void loadSettings()
    .then((settings) => controlBar.renderSettings(settings))
    .catch((error: unknown) => {
      showError(createContentError("LOAD_SETTINGS_FAILED", error));
    });
}

/** 将跨环境异常安全转换为临时界面提示。 */
function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 将 content script 的任意异常包装为可跨模块处理的结构化错误。 */
function createContentError(code: string, error: unknown): ExtensionError {
  return {
    code,
    message: getErrorMessage(error),
    source: "content",
    recoverable: true,
  };
}
