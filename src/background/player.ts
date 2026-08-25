import type { ExtensionSettings, PlaybackState } from "../shared/models";
import { loadSettings } from "../shared/settings";

/** 第一阶段使用固定内容验证完整播放链路，后续由网页适配器提供文本。 */
export const DEMO_TEXT =
  "你好，这是一段 Chrome TTS 固定测试文本。它用于验证播放、暂停、恢复和停止功能。";

type StateListener = (state: PlaybackState) => void;

/**
 * 集中管理 chrome.tts 和播放器状态。
 *
 * popup 只发送命令，不直接调用 TTS，因此 popup 关闭后不会丢失本次话语的事件回调。
 * playbackToken 会使旧话语迟到的事件失效，避免新播放被旧的 interrupted 或 end 覆盖。
 */
export class TtsPlayer {
  private state: PlaybackState = {
    status: "idle",
    updatedAt: Date.now(),
  };

  private playbackToken = 0;

  public constructor(private readonly onStateChange: StateListener) {}

  /** 返回不可被调用方修改的状态副本。 */
  public getState(): PlaybackState {
    return { ...this.state };
  }

  /** 根据当前状态执行暂停、恢复或开始播放固定文本。 */
  public async toggleDemo(): Promise<PlaybackState> {
    // 设置仍在加载时尚无可暂停的话语；界面会临时禁用按钮，重复消息也安全忽略。
    if (this.state.status === "loading") {
      return this.getState();
    }

    if (this.state.status === "playing") {
      chrome.tts.pause();
      this.setState("paused");
      return this.getState();
    }

    if (this.state.status === "paused") {
      chrome.tts.resume();
      this.setState("playing");
      return this.getState();
    }

    return this.play(DEMO_TEXT);
  }

  /** 播放由兼容页面提供的非空文本，并中断此前的话语。 */
  public async playText(text: string): Promise<PlaybackState> {
    const normalizedText = text.trim();
    if (!normalizedText) {
      this.setState("error", "没有可播放的文本。");
      return this.getState();
    }

    return this.play(normalizedText);
  }

  /** 停止当前话语，并让旧话语的后续事件全部失效。 */
  public stop(): PlaybackState {
    this.playbackToken += 1;
    chrome.tts.stop();
    this.setState("stopped");
    return this.getState();
  }

  /** 使用持久化声音参数开始一次独立话语。 */
  private async play(text: string): Promise<PlaybackState> {
    this.playbackToken += 1;
    const token = this.playbackToken;

    // 先使旧 token 失效再停止，避免旧话语的 interrupted 事件覆盖 loading。
    chrome.tts.stop();
    this.setState("loading");

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
