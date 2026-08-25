import {
  isExtensionRequest,
  type ExtensionEvent,
  type ExtensionRequest,
  type ExtensionResponse,
} from "../shared/messages";
import type {
  ExtensionError,
  PageTextItem,
  PlaybackPosition,
  PlaybackState,
} from "../shared/models";
import { loadSettings } from "../shared/settings";
import { TtsPlayer, type SpeechSnapshot } from "./player";

interface PageQueue {
  items: PageTextItem[];
  currentIndex: number;
}

interface PausedPlayback extends SpeechSnapshot {
  tabId: number;
}

interface PageQueueCursor {
  itemId: string;
  index: number;
}

const PAUSED_PLAYBACK_KEY = "pausedPlayback";
const PAGE_QUEUE_CURSORS_KEY = "pageQueueCursors";
const PLAYER_KEEP_ALIVE_PORT = "player-keep-alive";

const pageQueues = new Map<number, PageQueue>();
let activePlaybackTabId: number | null = null;
// 终态也保留最后一次话语归属，防止其他标签把它误显示为自己的播放状态。
let playbackOwnerTabId: number | null = null;

/** 发布状态到扩展页面和当前播放标签，并在页面话语完成后推进队列。 */
function publishState(state: PlaybackState): void {
  const event: ExtensionEvent = { type: "player:state-changed", state };
  void chrome.runtime.sendMessage(event).catch(() => undefined);

  const targetTabId = activePlaybackTabId;
  if (targetTabId !== null) {
    void chrome.tabs.sendMessage(targetTabId, event).catch(() => undefined);
  }

  if (state.status === "completed" && state.source === "page") {
    void continuePageQueue(state, targetTabId);
  } else if (
    state.status === "completed" ||
    state.status === "stopped" ||
    state.status === "error"
  ) {
    activePlaybackTabId = null;
    if (state.status === "completed" || state.status === "error") {
      void clearPausedPlayback();
    }
  }
}

/** 位置事件仅属于当前页面播放，不广播给 popup 或其他标签。 */
function publishPosition(position: PlaybackPosition): void {
  const targetTabId = activePlaybackTabId;
  if (targetTabId === null) {
    return;
  }
  const event: ExtensionEvent = { type: "player:position-changed", position };
  void chrome.tabs.sendMessage(targetTabId, event).catch(() => undefined);
}

const player = new TtsPlayer(publishState, publishPosition);

chrome.runtime.onInstalled.addListener(() => {
  void loadSettings().catch((error: unknown) => {
    console.error(
      "初始化扩展设置失败：",
      error instanceof Error ? error.message : String(error),
    );
  });
});

/** 关闭页面时删除其队列；如果它拥有当前话语，同时停止系统 TTS。 */
chrome.tabs.onRemoved.addListener((tabId) => {
  pageQueues.delete(tabId);
  if (tabId === playbackOwnerTabId) {
    playbackOwnerTabId = null;
  }
  if (tabId === activePlaybackTabId) {
    activePlaybackTabId = null;
    player.stop();
  }
  void clearPausedPlaybackForTab(tabId);
  void clearPageQueueCursor(tabId);
});

/** 刷新、普通导航和 URL 跳转开始时停止归属话语，避免旧页面文本继续播放。 */
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  const navigationStarted =
    changeInfo.status === "loading" || changeInfo.url !== undefined;
  if (!navigationStarted) {
    return;
  }

  pageQueues.delete(tabId);
  void clearPausedPlaybackForTab(tabId);
  void clearPageQueueCursor(tabId);
  if (tabId !== activePlaybackTabId) {
    return;
  }

  activePlaybackTabId = null;
  playbackOwnerTabId = null;
  player.stop();
});

/**
 * 播放页面每隔一段时间发送一次消息，避免长话语期间 MV3 worker 被回收而丢失 TTS end 回调。
 * 消息本身不承载业务数据，仅用于维持当前播放会话。
 */
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== PLAYER_KEEP_ALIVE_PORT) {
    return;
  }
  port.onMessage.addListener(() => undefined);
});

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

/** 将已验证命令映射到队列或播放器操作；页面命令始终使用 sender.tab.id。 */
async function handleRequest(
  request: ExtensionRequest,
  sender: chrome.runtime.MessageSender,
): Promise<ExtensionResponse> {
  switch (request.type) {
    case "page:set-items": {
      const tabId = requireSenderTabId(sender);
      await updatePageQueue(tabId, request.items);
      return { ok: true, state: getStateForTab(tabId) };
    }
    case "page:toggle": {
      const tabId = requireSenderTabId(sender);
      return { ok: true, state: await togglePagePlayback(tabId) };
    }
    case "page:previous": {
      const tabId = requireSenderTabId(sender);
      return { ok: true, state: await jumpPageItem(tabId, -1) };
    }
    case "page:next": {
      const tabId = requireSenderTabId(sender);
      return { ok: true, state: await jumpPageItem(tabId, 1) };
    }
    case "page:play-from-position": {
      const tabId = requireSenderTabId(sender);
      return {
        ok: true,
        state: await playPageItemFromPosition(
          tabId,
          request.itemId,
          request.charIndex,
        ),
      };
    }
    case "player:play-text": {
      const tabId = requireSenderTabId(sender);
      return {
        ok: true,
        state: await startPlaybackForTab(tabId, () =>
          player.playText(request.text, request.source),
        ),
      };
    }
    case "selection:auto-play": {
      const tabId = requireSenderTabId(sender);
      const state = player.getState();
      if (
        state.status === "loading" ||
        state.status === "playing" ||
        state.status === "paused"
      ) {
        return { ok: true, state: getStateForTab(tabId) };
      }

      return {
        ok: true,
        state: await startPlaybackForTab(tabId, () =>
          player.playText(request.text, "selection"),
        ),
      };
    }
    case "player:stop":
      await clearPausedPlayback();
      return { ok: true, state: player.stop() };
    case "player:get-state":
      return {
        ok: true,
        state:
          sender.tab?.id === undefined
            ? player.getState()
            : getStateForTab(sender.tab.id),
      };
    case "settings:open":
      await chrome.action.openPopup(
        sender.tab?.windowId === undefined
          ? undefined
          : { windowId: sender.tab.windowId },
      );
      return { ok: true, state: player.getState() };
    case "test:trigger-error":
      await sendTestError();
      return { ok: true, state: player.getState() };
  }
}

/** 保留当前条目 ID；动态扫描使它消失时回退到最接近的旧位置。 */
async function updatePageQueue(
  tabId: number,
  items: PageTextItem[],
): Promise<void> {
  const previousQueue = pageQueues.get(tabId);
  const storedCursor = previousQueue ? null : await loadPageQueueCursor(tabId);
  const nextNamespace = getItemNamespace(items[0]?.id);
  const previousItem = previousQueue?.items[previousQueue.currentIndex];
  const previousNamespace = getItemNamespace(
    previousItem?.id ?? storedCursor?.itemId,
  );
  const sameAdapterNamespace =
    previousNamespace === null || previousNamespace === nextNamespace;
  const currentItemId =
    sameAdapterNamespace &&
    activePlaybackTabId === tabId &&
    player.getState().source === "page"
      ? player.getState().itemId
      : sameAdapterNamespace
        ? previousItem?.id ?? storedCursor?.itemId
        : null;
  const matchingIndex = currentItemId
    ? items.findIndex((item) => item.id === currentItemId)
    : -1;
  const fallbackIndex = Math.min(
    Math.max(
      sameAdapterNamespace
        ? previousQueue?.currentIndex ?? storedCursor?.index ?? 0
        : 0,
      0,
    ),
    Math.max(items.length - 1, 0),
  );

  pageQueues.set(tabId, {
    items: items.map((item, index) => ({ ...item, index })),
    currentIndex: matchingIndex >= 0 ? matchingIndex : fallbackIndex,
  });
}

/** 条目 ID 的首段标识生成它的适配器，切换模式时不能沿用旧队列索引。 */
function getItemNamespace(itemId: string | undefined): string | null {
  if (!itemId) {
    return null;
  }
  return itemId.split(":", 1)[0] ?? null;
}

/** 同一标签正在播放时切换暂停/恢复，否则从其当前或第一条开始页面播放。 */
async function togglePagePlayback(tabId: number): Promise<PlaybackState> {
  const state = player.getState();
  if (activePlaybackTabId === tabId) {
    if (state.status === "loading") {
      return state;
    }
    if (state.status === "playing") {
      const pausedState = player.pause();
      await savePausedPlayback(tabId);
      return pausedState;
    }
    if (state.status === "paused") {
      await clearPausedPlayback();
      return player.resume();
    }
  }

  const pausedPlayback = await loadPausedPlayback();
  if (pausedPlayback?.tabId === tabId) {
    return resumePausedPlayback(pausedPlayback);
  }

  const queue = requirePageQueue(tabId);
  return playPageItem(tabId, queue.currentIndex);
}

/** 上一条/下一条始终通过新话语播放，TtsPlayer 会先让旧 token 失效并停止旧话语。 */
async function jumpPageItem(
  tabId: number,
  offset: -1 | 1,
): Promise<PlaybackState> {
  const queue = requirePageQueue(tabId);
  const targetIndex = Math.min(
    queue.items.length - 1,
    Math.max(0, queue.currentIndex + offset),
  );
  if (
    targetIndex === queue.currentIndex &&
    activePlaybackTabId === tabId &&
    player.getState().source === "page" &&
    player.getState().itemId
  ) {
    return player.getState();
  }
  return playPageItem(tabId, targetIndex);
}

async function playPageItem(
  tabId: number,
  index: number,
): Promise<PlaybackState> {
  const queue = requirePageQueue(tabId);
  const item = queue.items[index];
  if (!item) {
    throw new Error("目标文本条目不存在。");
  }

  queue.currentIndex = index;
  await savePageQueueCursor(tabId, item.id, index);
  return startPlaybackForTab(tabId, () =>
    player.playText(item.text, "page", item.id),
  );
}

/** 从指定页面条目的字符位置开始播放，并把后续自动推进起点更新为该条目。 */
async function playPageItemFromPosition(
  tabId: number,
  itemId: string,
  charIndex: number,
): Promise<PlaybackState> {
  const queue = requirePageQueue(tabId);
  const index = queue.items.findIndex((item) => item.id === itemId);
  const item = queue.items[index];
  if (!item) {
    throw new Error("选择文本所在段落已发生变化，请重新选择。");
  }

  const boundedIndex = Math.min(item.text.length - 1, Math.max(0, charIndex));
  const rawRemainingText = item.text.slice(boundedIndex);
  const remainingText = rawRemainingText.trimStart();
  const removedLeadingWhitespace = rawRemainingText.length - remainingText.length;
  const textOffset = boundedIndex + removedLeadingWhitespace;
  if (!remainingText) {
    throw new Error("选择位置之后没有可播放文本。");
  }

  queue.currentIndex = index;
  await savePageQueueCursor(tabId, item.id, index);
  return startPlaybackForTab(tabId, () =>
    player.playText(remainingText, "page", item.id, textOffset),
  );
}

/**
 * 将全局 TTS 播放权切换到目标标签。
 *
 * chrome.tts 同一时刻只有一个全局话语。跨标签播放时必须先让旧标签收到 stopped，
 * 再登记新标签并开始播放；否则旧标签会保留“播放中”的按钮和正文高亮。
 */
async function startPlaybackForTab(
  tabId: number,
  start: () => Promise<PlaybackState>,
): Promise<PlaybackState> {
  const previousTabId = activePlaybackTabId;
  await clearPausedPlayback();
  if (previousTabId !== null && previousTabId !== tabId) {
    // 此时 activePlaybackTabId 仍指向旧标签，因此 stop 发布的状态会准确送达旧页面。
    player.stop();
  }

  activePlaybackTabId = tabId;
  playbackOwnerTabId = tabId;
  await start();

  // 异步加载语音设置期间可能又发生一次跨标签接管，响应必须按请求标签隔离。
  return getStateForTab(tabId);
}

/** 原生暂停状态已丢失时，从最后一个位置事件继续朗读剩余文本。 */
async function resumePausedPlayback(
  pausedPlayback: PausedPlayback,
): Promise<PlaybackState> {
  const remainingText = pausedPlayback.text
    .slice(pausedPlayback.charIndex)
    .trimStart();
  const recoveryText = remainingText || pausedPlayback.text;
  const rawRemainingText = pausedPlayback.text.slice(pausedPlayback.charIndex);
  const removedLeadingWhitespace = rawRemainingText.length - remainingText.length;
  const recoveryOffset = remainingText
    ? pausedPlayback.textOffset +
      pausedPlayback.charIndex +
      removedLeadingWhitespace
    : pausedPlayback.textOffset;

  return startPlaybackForTab(pausedPlayback.tabId, () =>
    player.playText(
      recoveryText,
      pausedPlayback.source,
      pausedPlayback.itemId,
      recoveryOffset,
    ),
  );
}

/** 暂停时把当前标签、实际话语和最近字符位置写入仅本次浏览器会话有效的存储。 */
async function savePausedPlayback(tabId: number): Promise<void> {
  const speech = player.getSpeechSnapshot();
  if (!speech) {
    return;
  }
  const pausedPlayback: PausedPlayback = { tabId, ...speech };
  await chrome.storage.session.set({ [PAUSED_PLAYBACK_KEY]: pausedPlayback });
}

/** 读取并校验暂停恢复数据，防止损坏的 session 数据进入播放器。 */
async function loadPausedPlayback(): Promise<PausedPlayback | null> {
  const stored = await chrome.storage.session.get(PAUSED_PLAYBACK_KEY);
  const value: unknown = stored[PAUSED_PLAYBACK_KEY];
  if (typeof value !== "object" || value === null) {
    return null;
  }

  const record = value as Record<string, unknown>;
  if (
    typeof record.tabId !== "number" ||
    !Number.isInteger(record.tabId) ||
    typeof record.text !== "string" ||
    record.text.length === 0 ||
    !isSpeechSource(record.source) ||
    !(record.itemId === null || typeof record.itemId === "string") ||
    typeof record.charIndex !== "number" ||
    !Number.isFinite(record.charIndex) ||
    typeof record.textOffset !== "number" ||
    !Number.isFinite(record.textOffset)
  ) {
    await clearPausedPlayback();
    return null;
  }

  return {
    tabId: record.tabId,
    text: record.text,
    source: record.source,
    itemId: record.itemId,
    charIndex: Math.min(
      record.text.length,
      Math.max(0, Math.trunc(record.charIndex)),
    ),
    textOffset: Math.max(0, Math.trunc(record.textOffset)),
  };
}

function isSpeechSource(value: unknown): value is SpeechSnapshot["source"] {
  return value === "page" || value === "selection" || value === "input";
}

async function clearPausedPlayback(): Promise<void> {
  await chrome.storage.session.remove(PAUSED_PLAYBACK_KEY);
}

/** 关闭或刷新无关标签时不应误删另一个标签保存的暂停位置。 */
async function clearPausedPlaybackForTab(tabId: number): Promise<void> {
  const pausedPlayback = await loadPausedPlayback();
  if (pausedPlayback?.tabId === tabId) {
    await clearPausedPlayback();
  }
}

/** 保存每个标签最后播放的页面条目，使 worker 重启后仍能从正确索引继续。 */
async function savePageQueueCursor(
  tabId: number,
  itemId: string,
  index: number,
): Promise<void> {
  const stored = await chrome.storage.session.get(PAGE_QUEUE_CURSORS_KEY);
  const cursors = normalizePageQueueCursors(stored[PAGE_QUEUE_CURSORS_KEY]);
  cursors[String(tabId)] = { itemId, index };
  await chrome.storage.session.set({ [PAGE_QUEUE_CURSORS_KEY]: cursors });
}

async function loadPageQueueCursor(
  tabId: number,
): Promise<PageQueueCursor | null> {
  const stored = await chrome.storage.session.get(PAGE_QUEUE_CURSORS_KEY);
  const cursors = normalizePageQueueCursors(stored[PAGE_QUEUE_CURSORS_KEY]);
  return cursors[String(tabId)] ?? null;
}

async function clearPageQueueCursor(tabId: number): Promise<void> {
  const stored = await chrome.storage.session.get(PAGE_QUEUE_CURSORS_KEY);
  const cursors = normalizePageQueueCursors(stored[PAGE_QUEUE_CURSORS_KEY]);
  const key = String(tabId);
  if (!(key in cursors)) {
    return;
  }
  delete cursors[key];
  await chrome.storage.session.set({ [PAGE_QUEUE_CURSORS_KEY]: cursors });
}

/** session 数据必须逐项校验，避免失效标签或损坏值破坏队列恢复。 */
function normalizePageQueueCursors(
  value: unknown,
): Record<string, PageQueueCursor> {
  if (typeof value !== "object" || value === null) {
    return {};
  }
  const normalized: Record<string, PageQueueCursor> = {};
  for (const [key, cursor] of Object.entries(value)) {
    if (
      typeof cursor === "object" &&
      cursor !== null &&
      "itemId" in cursor &&
      typeof cursor.itemId === "string" &&
      "index" in cursor &&
      typeof cursor.index === "number" &&
      Number.isInteger(cursor.index) &&
      cursor.index >= 0
    ) {
      normalized[key] = { itemId: cursor.itemId, index: cursor.index };
    }
  }
  return normalized;
}

/** 非所有者页面不应把另一个标签的全局 TTS 状态渲染成自己的按钮状态。 */
function getStateForTab(tabId: number): PlaybackState {
  const state = player.getState();
  if (playbackOwnerTabId === null || playbackOwnerTabId === tabId) {
    return state;
  }
  return {
    status: "idle",
    source: null,
    itemId: null,
    updatedAt: state.updatedAt,
  };
}

/** 页面话语正常结束时播放下一条；队列末尾只清除活动标签归属。 */
async function continuePageQueue(
  completedState: PlaybackState,
  tabId: number | null,
): Promise<void> {
  if (tabId === null || tabId !== activePlaybackTabId) {
    return;
  }
  const queue = pageQueues.get(tabId);
  if (!queue) {
    activePlaybackTabId = null;
    return;
  }

  const completedIndex = completedState.itemId
    ? queue.items.findIndex((item) => item.id === completedState.itemId)
    : queue.currentIndex;
  const nextIndex = completedIndex + 1;
  if (nextIndex >= queue.items.length) {
    activePlaybackTabId = null;
    return;
  }

  await playPageItem(tabId, nextIndex);
}

function requirePageQueue(tabId: number): PageQueue {
  const queue = pageQueues.get(tabId);
  if (!queue || queue.items.length === 0) {
    throw new Error("当前页面没有可自动播放的文本。");
  }
  return queue;
}

function requireSenderTabId(sender: chrome.runtime.MessageSender): number {
  if (sender.tab?.id === undefined) {
    throw new Error("页面命令缺少来源标签页。");
  }
  return sender.tab.id;
}

async function sendTestError(): Promise<void> {
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
  const event: ExtensionEvent = { type: "extension:error", error: testError };
  await chrome.tabs.sendMessage(activeTab.id, event);
}
