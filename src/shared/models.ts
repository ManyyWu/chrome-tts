/** 扩展播放器所有可观察状态。 */
export type PlaybackStatus =
  | "idle"
  | "loading"
  | "playing"
  | "paused"
  | "stopped"
  | "completed"
  | "error";

/** 当前话语的来源决定播放完成后是否继续页面队列。 */
export type PlaybackSource = "page" | "selection" | "input" | "caption" | null;

/**
 * service worker 对外发布的播放器快照。
 *
 * updatedAt 用于让后来打开的界面判断状态的新旧；错误信息仅在 error 状态下存在。
 */
export interface PlaybackState {
  status: PlaybackStatus;
  source: PlaybackSource;
  itemId: string | null;
  updatedAt: number;
  errorMessage?: string;
}

/** TTS 引擎报告的当前文本位置；索引基于页面条目的规范化文本。 */
export interface PlaybackPosition {
  itemId: string;
  charIndex: number;
  length: number;
  granularity: "word" | "sentence";
}

/** content script 扫描后发送给 service worker 的可序列化文本条目。 */
export interface PageTextItem {
  id: string;
  text: string;
  index: number;
}

/** 可跨运行环境传递的结构化错误，避免界面依赖任意 Error 对象。 */
export interface ExtensionError {
  /** 关键操作失败时保留通知，等待用户确认后关闭。 */
  requiresConfirmation?: boolean;
  code: string;
  message: string;
  source: "content" | "player" | "tts" | "settings" | "test";
  recoverable: boolean;
}

/** 持久化设置的当前结构，version 用于后续迁移旧数据。 */
export interface ExtensionSettings {
  version: 6;
  voiceName: string | null;
  voiceExtensionId: string | null;
  lang: string | null;
  rate: number;
  volume: number;
  highlightBorderColor: string;
  highlightBackgroundColor: string;
  autoPlaySelection: boolean;
  showSelectionJumpPrompt: boolean;
  playAllVisibleText: boolean;
  globalEnabled: boolean;
}
