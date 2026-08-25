import {
  isExtensionRequest,
  type ExtensionEvent,
  type ExtensionRequest,
  type ExtensionResponse,
} from "../shared/messages";
import type { ExtensionError, PlaybackState } from "../shared/models";
import { loadSettings } from "../shared/settings";
import { TtsPlayer } from "./player";

/**
 * 第一阶段只记录播放器状态；第二阶段加入 content script 后会在这里广播给页面控制栏。
 * 保留独立回调可避免播放器直接依赖某种 UI。
 */
function publishState(state: PlaybackState): void {
  const event: ExtensionEvent = { type: "player:state-changed", state };

  // popup 关闭时没有接收端属于正常情况，不能把它升级为播放错误。
  void chrome.runtime.sendMessage(event).catch(() => undefined);

  // content script 不接收 runtime.sendMessage 的扩展页广播，需要按标签页单独发送。
  if (activePlaybackTabId !== null) {
    void chrome.tabs
      .sendMessage(activePlaybackTabId, event)
      .catch(() => undefined);
  }

  // 最终状态之后不再把后续标签关闭误判为仍在播放的话语。
  if (
    state.status === "completed" ||
    state.status === "stopped" ||
    state.status === "error"
  ) {
    activePlaybackTabId = null;
  }
}

// 记录最后发起播放的页面，使 TTS 的异步事件能回到正确的 FloatingControlBar。
let activePlaybackTabId: number | null = null;
const player = new TtsPlayer(publishState);

/** 发起当前播放的标签一旦关闭，立即停止 TTS 并清空播放归属。 */
chrome.tabs.onRemoved.addListener((tabId) => {
  if (tabId !== activePlaybackTabId) {
    return;
  }

  activePlaybackTabId = null;
  player.stop();
});

// 安装或更新后创建并规范化默认设置；失败会在实际播放请求中再次被捕获并返回。
chrome.runtime.onInstalled.addListener(() => {
  void loadSettings().catch((error: unknown) => {
    console.error(
      "初始化扩展设置失败：",
      error instanceof Error ? error.message : String(error),
    );
  });
});

/**
 * 作为所有界面的播放器命令入口。
 * 返回 true 表示响应会异步发送，避免消息通道在 Promise 完成前关闭。
 */
chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
  if (!isExtensionRequest(message)) {
    return false;
  }

  void handleRequest(message, sender)
    .then(sendResponse)
    .catch((error: unknown) => {
      const response: ExtensionResponse = {
        ok: false,
        state: player.getState(),
        error: error instanceof Error ? error.message : String(error),
      };
      sendResponse(response);
    });

  return true;
});

/** 将已经校验过的消息映射到唯一的播放器操作。 */
async function handleRequest(
  request: ExtensionRequest,
  sender: chrome.runtime.MessageSender,
): Promise<ExtensionResponse> {
  switch (request.type) {
    case "player:toggle-demo":
      activePlaybackTabId = sender.tab?.id ?? null;
      return { ok: true, state: await player.toggleDemo() };
    case "player:play-text":
      activePlaybackTabId = sender.tab?.id ?? null;
      return { ok: true, state: await player.playText(request.text) };
    case "player:stop":
      return { ok: true, state: player.stop() };
    case "player:get-state":
      return { ok: true, state: player.getState() };
    case "settings:open":
      await chrome.action.openPopup(
        sender.tab?.windowId === undefined
          ? undefined
          : { windowId: sender.tab.windowId },
      );
      return { ok: true, state: player.getState() };
    case "test:trigger-error": {
      const [activeTab] = await chrome.tabs.query({
        active: true,
        lastFocusedWindow: true,
      });
      if (activeTab?.id === undefined) {
        throw new Error("没有可接收测试错误的活动页面。");
      }

      const testError: ExtensionError = {
        code: "TEST_ERROR",
        message: "这是一条 Chrome TTS 测试错误。",
        source: "test",
        recoverable: true,
      };
      const event: ExtensionEvent = {
        type: "extension:error",
        error: testError,
      };
      await chrome.tabs.sendMessage(activeTab.id, event);
      return { ok: true, state: player.getState() };
    }
  }
}
