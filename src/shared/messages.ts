import type { ExtensionError, PlaybackState } from "./models";

/** popup 和后续 content script 可以发送给 service worker 的播放器命令。 */
export type ExtensionRequest =
  | { type: "player:toggle-demo" }
  | { type: "player:play-text"; text: string }
  | { type: "player:stop" }
  | { type: "player:get-state" }
  | { type: "settings:open" }
  | { type: "test:trigger-error" };

/** service worker 主动发送给已打开界面的状态事件。 */
export type ExtensionEvent =
  | { type: "player:state-changed"; state: PlaybackState }
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
  if (type === "player:play-text") {
    return (
      "text" in value &&
      typeof value.text === "string" &&
      value.text.trim().length > 0
    );
  }

  return (
    type === "player:toggle-demo" ||
    type === "player:stop" ||
    type === "player:get-state" ||
    type === "settings:open" ||
    type === "test:trigger-error"
  );
}
