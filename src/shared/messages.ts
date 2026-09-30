import type {
  ExtensionError,
  PageTextItem,
  PlaybackPosition,
  PlaybackState,
} from "./models";

/** 设置页和 content script 可以发送给 service worker 的播放器命令。 */
export type ExtensionRequest =
  | { type: "end-gfw:get-webhook" }
  | { type: "end-gfw:save-webhook"; url: string }
  | { type: "end-gfw:push-tweet"; tweetId: string; url: string; time: string }
  | { type: "page:set-items"; items: PageTextItem[]; pageSessionId: string }
  | { type: "page:toggle" }
  | { type: "page:previous" }
  | { type: "page:next" }
  | { type: "page:play-from-position"; itemId: string; charIndex: number }
  | { type: "player:play-text"; text: string; source: "selection" | "input" }
  | { type: "site:play-caption"; text: string }
  | { type: "selection:auto-play"; text: string }
  | { type: "player:stop" }
  | { type: "player:get-state" }
  | { type: "test:trigger-error" };

/** service worker 主动发送给已打开界面的状态事件。 */
export type ExtensionEvent =
  | { type: "player:state-changed"; state: PlaybackState }
  | { type: "player:position-changed"; position: PlaybackPosition }
  | { type: "extension:error"; error: ExtensionError };

/** 播放器命令的统一响应，避免调用方分别猜测错误返回结构。 */
export type ExtensionResponse =
  | { ok: true; state: PlaybackState; webhookUrl?: string }
  | { ok: false; state: PlaybackState; error: string };

/**
 * 对跨运行环境传入的数据做最小运行时校验。
 * TypeScript 类型在打包后不存在，因此消息不能只依靠静态类型保证安全。
 */
export function isExtensionRequest(value: unknown): value is ExtensionRequest {
  if (typeof value !== "object" || value === null || !("type" in value)) {
    return false;
  }

  const type = value.type;
  if (type === "end-gfw:get-webhook") return true;
  if (type === "end-gfw:save-webhook") {
    return "url" in value && typeof value.url === "string" && value.url.length <= 2048;
  }
  if (type === "end-gfw:push-tweet") {
    return "url" in value && typeof value.url === "string" && value.url.length <= 2048 &&
      "tweetId" in value && typeof value.tweetId === "string" && /^\d{1,30}$/u.test(value.tweetId) &&
      "time" in value && isEndGfwTweetTime(value.time);
  }
  if (type === "page:set-items") {
    return (
      "items" in value &&
      isPageTextItemArray(value.items) &&
      "pageSessionId" in value &&
      typeof value.pageSessionId === "string" &&
      value.pageSessionId.length >= 16 &&
      value.pageSessionId.length <= 128
    );
  }

  if (type === "player:play-text") {
    return (
      "text" in value &&
      typeof value.text === "string" &&
      isSpeakableText(value.text) &&
      "source" in value &&
      (value.source === "selection" || value.source === "input")
    );
  }

  if (type === "selection:auto-play") {
    return (
      "text" in value &&
      typeof value.text === "string" &&
      isSpeakableText(value.text)
    );
  }

  if (type === "site:play-caption") {
    return (
      "text" in value &&
      typeof value.text === "string" &&
      isSpeakableText(value.text)
    );
  }

  if (type === "page:play-from-position") {
    return (
      "itemId" in value &&
      typeof value.itemId === "string" &&
      value.itemId.length > 0 &&
      "charIndex" in value &&
      typeof value.charIndex === "number" &&
      Number.isInteger(value.charIndex) &&
      value.charIndex >= 0 &&
      value.charIndex <= 32768
    );
  }

  return (
    type === "page:toggle" ||
    type === "page:previous" ||
    type === "page:next" ||
    type === "player:stop" ||
    type === "player:get-state" ||
    type === "test:trigger-error"
  );
}

/** 页面队列可能来自不受信任的网页 DOM，因此逐项验证所有可序列化字段。 */
function isPageTextItemArray(value: unknown): value is PageTextItem[] {
  return (
    Array.isArray(value) &&
    value.length <= 10000 &&
    value.every(
      (item: unknown) =>
        typeof item === "object" &&
        item !== null &&
        "id" in item &&
        typeof item.id === "string" &&
        item.id.length > 0 &&
        "text" in item &&
        typeof item.text === "string" &&
        isSpeakableText(item.text) &&
        "index" in item &&
        typeof item.index === "number" &&
        Number.isInteger(item.index) &&
        item.index >= 0 &&
        (!("postPlaybackDelayMs" in item) ||
          (typeof item.postPlaybackDelayMs === "number" &&
            Number.isInteger(item.postPlaybackDelayMs) &&
            item.postPlaybackDelayMs >= 0 &&
            item.postPlaybackDelayMs <= 5000)),
    )
  );
}

/** 校验卡片时间格式及真实日期；UTC 仅用于验证，不转换页面展示的时区。 */
export function isEndGfwTweetTime(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/u.test(value)) return false;
  const iso = value.replace(" ", "T") + ".000Z";
  const date = new Date(iso);
  return Number.isFinite(date.getTime()) && date.toISOString() === iso;
}

function isSpeakableText(text: string): boolean {
  const length = text.trim().length;
  return length > 0 && length <= 32768;
}
