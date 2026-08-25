import type {
  ExtensionSettings,
  PlaybackPosition,
  PlaybackSource,
  PlaybackState,
} from "../shared/models";
import { loadSettings } from "../shared/settings";

type StateListener = (state: PlaybackState) => void;
type PositionListener = (position: PlaybackPosition) => void;

/** 暂停恢复所需的最小话语快照；文本与索引都基于实际传给 chrome.tts 的字符串。 */
export interface SpeechSnapshot {
  text: string;
  source: Exclude<PlaybackSource, null>;
  itemId: string | null;
  charIndex: number;
  textOffset: number;
}

/**
 * 集中管理 chrome.tts 和播放器状态。
 *
 * 设置页只发送命令，不直接调用 TTS，因此设置面板关闭后不会丢失话语事件回调。
 * playbackToken 会使旧话语迟到的事件失效，避免新播放被旧的 interrupted 或 end 覆盖。
 */
export class TtsPlayer {
  private state: PlaybackState = {
    status: "idle",
    source: null,
    itemId: null,
    updatedAt: Date.now(),
  };

  private playbackToken = 0;
  private currentSpeech: SpeechSnapshot | null = null;

  public constructor(
    private readonly onStateChange: StateListener,
    private readonly onPositionChange: PositionListener,
  ) {}

  /** 返回不可被调用方修改的状态副本。 */
  public getState(): PlaybackState {
    return { ...this.state };
  }

  /** 返回当前话语及最近的位置事件，用于原生暂停失效后的文本位置恢复。 */
  public getSpeechSnapshot(): SpeechSnapshot | null {
    return this.currentSpeech === null ? null : { ...this.currentSpeech };
  }

  /** 暂停当前话语；loading 状态尚未开始合成，因此保持不变。 */
  public pause(): PlaybackState {
    if (this.state.status === "playing") {
      chrome.tts.pause();
      this.setState("paused");
    }
    return this.getState();
  }

  /** 恢复被暂停的话语。 */
  public resume(): PlaybackState {
    if (this.state.status === "paused") {
      chrome.tts.resume();
      this.setState("playing");
    }
    return this.getState();
  }

  /** 播放标准化文本，并记录来源和可选页面条目 ID。 */
  public async playText(
    text: string,
    source: Exclude<PlaybackSource, null>,
    itemId: string | null = null,
    textOffset = 0,
  ): Promise<PlaybackState> {
    const normalizedText = text.trim();
    if (!normalizedText) {
      this.setState("error", "没有可播放的文本。");
      return this.getState();
    }

    this.currentSpeech = {
      text: normalizedText,
      source,
      itemId,
      charIndex: 0,
      textOffset,
    };
    return this.play(normalizedText, source, itemId);
  }

  /** 停止当前话语，并让旧话语的后续事件全部失效。 */
  public stop(): PlaybackState {
    this.playbackToken += 1;
    chrome.tts.stop();
    this.setState("stopped");
    return this.getState();
  }

  /** 使用持久化声音参数开始一次独立话语。 */
  private async play(
    text: string,
    source: Exclude<PlaybackSource, null>,
    itemId: string | null,
  ): Promise<PlaybackState> {
    this.playbackToken += 1;
    const token = this.playbackToken;

    // 先使旧 token 失效再停止，避免旧话语的 interrupted 事件覆盖 loading。
    chrome.tts.stop();
    this.state = {
      status: "loading",
      source,
      itemId,
      updatedAt: Date.now(),
    };
    this.onStateChange(this.getState());

    try {
      const settings = await loadSettings();
      if (token !== this.playbackToken) {
        return this.getState();
      }

      const options = this.createOptions(settings, token);
      await chrome.tts.speak(text, options);
    } catch (error: unknown) {
      if (token === this.playbackToken) {
        this.setState("error", getErrorMessage(error));
      }
    }

    return this.getState();
  }

  /** 根据已校验设置生成 TTS 参数，并只监听当前 token 对应的话语事件。 */
  private createOptions(
    settings: ExtensionSettings,
    token: number,
  ): chrome.tts.TtsOptions {
    const options: chrome.tts.TtsOptions = {
      enqueue: false,
      rate: settings.rate,
      volume: settings.volume,
      pitch: 1,
      // 明确请求文本边界事件；具体能否返回以及粒度仍由当前语音引擎决定。
      desiredEventTypes: [
        "start",
        "end",
        "word",
        "sentence",
        "interrupted",
        "cancelled",
        "error",
        "pause",
        "resume",
      ],
      onEvent: (event) => {
        if (token !== this.playbackToken) {
          return;
        }

        this.handleTtsEvent(event);
      },
    };

    if (settings.voiceName) {
      options.voiceName = settings.voiceName;
    }
    if (settings.voiceExtensionId) {
      options.extensionId = settings.voiceExtensionId;
    }
    if (settings.lang) {
      options.lang = settings.lang;
    }

    return options;
  }

  /** 将 Chrome TTS 事件归一化为项目定义的有限状态。 */
  private handleTtsEvent(event: chrome.tts.TtsEvent): void {
    // charIndex 由语音引擎提供；word 事件通常指向下一个即将朗读的词。
    if (
      this.currentSpeech !== null &&
      typeof event.charIndex === "number" &&
      Number.isFinite(event.charIndex)
    ) {
      this.currentSpeech.charIndex = Math.min(
        this.currentSpeech.text.length,
        Math.max(0, Math.trunc(event.charIndex)),
      );

      if (
        this.currentSpeech.source === "page" &&
        this.currentSpeech.itemId !== null &&
        (event.type === "word" || event.type === "sentence")
      ) {
        const reportedLength =
          event.type === "word" &&
          typeof event.length === "number" &&
          event.length > 0
            ? Math.trunc(event.length)
            : 1;
        this.onPositionChange({
          itemId: this.currentSpeech.itemId,
          charIndex:
            this.currentSpeech.textOffset + this.currentSpeech.charIndex,
          length: reportedLength,
          granularity: event.type,
        });
      }
    }

    switch (event.type) {
      case "start":
      case "resume":
        this.setState("playing");
        break;
      case "pause":
        this.setState("paused");
        break;
      case "end":
        this.setState("completed");
        break;
      case "interrupted":
      case "cancelled":
        this.setState("stopped");
        break;
      case "error":
        this.setState("error", event.errorMessage ?? "TTS 播放失败。");
        break;
      default:
        // word、sentence 和 marker 只描述播放位置，第一阶段无需改变状态。
        break;
    }
  }

  /** 更新状态并发布完整快照，确保所有界面观察到一致结果。 */
  private setState(
    status: PlaybackState["status"],
    errorMessage?: string,
  ): void {
    this.state = {
      status,
      source: this.state.source,
      itemId: this.state.itemId,
      updatedAt: Date.now(),
      ...(errorMessage ? { errorMessage } : {}),
    };
    this.onStateChange(this.getState());
  }
}

/** 将 JavaScript 可抛出的任意值转换为可展示错误文本。 */
function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
