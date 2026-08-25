/** 扩展播放器所有可观察状态。 */
export type PlaybackStatus =
  | "idle"
  | "loading"
  | "playing"
  | "paused"
  | "stopped"
  | "completed"
  | "error";

/**
 * service worker 对外发布的播放器快照。
 *
 * updatedAt 用于让后来打开的界面判断状态的新旧；错误信息仅在 error 状态下存在。
 */
export interface PlaybackState {
  status: PlaybackStatus;
  updatedAt: number;
  errorMessage?: string;
}

/** 可跨运行环境传递的结构化错误，避免界面依赖任意 Error 对象。 */
export interface ExtensionError {
  code: string;
  message: string;
  source: "content" | "player" | "tts" | "settings" | "test";
  recoverable: boolean;
}

/** 持久化设置的当前结构，version 用于后续迁移旧数据。 */
export interface ExtensionSettings {
  version: 1;
  voiceName: string | null;
  voiceExtensionId: string | null;
  lang: string | null;
  rate: number;
  volume: number;
}
