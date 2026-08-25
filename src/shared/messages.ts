import type {
  ExtensionError,
  PageTextItem,
  PlaybackPosition,
  PlaybackState,
} from "./models";

/** 设置页和 content script 可以发送给 service worker 的播放器命令。 */
export type ExtensionRequest =
  | { type: "page:set-items"; items: PageTextItem[] }
  | { type: "page:toggle" }
  | { type: "page:previous" }
  | { type: "page:next" }
  | { type: "page:play-from-position"; itemId: string; charIndex: number }
  | { type: "player:play-text"; text: string; source: "selection" | "input" }
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
  | { ok: true; state: PlaybackState }
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
  if (type === "page:set-items") {
    return "items" in value && isPageTextItemArray(value.items);
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
        item.index >= 0,
    )
  );
}

function isSpeakableText(text: string): boolean {
  const length = text.trim().length;
  return length > 0 && length <= 32768;
}
