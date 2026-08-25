import type { ExtensionError } from "../shared/models";

/**
 * 在网页顶部显示非阻塞错误 toast，并尽力播放短提示音。
 * Web Audio 可能受页面自动播放策略限制；声音失败不会产生第二个错误或影响 toast。
 */
export class ErrorFeedback {
  private readonly host: HTMLDivElement;
  private readonly messageElement: HTMLDivElement;
  private hideTimer: number | null = null;
  private lastErrorKey = "";
  private lastShownAt = 0;

  public constructor() {
    this.host = document.createElement("div");
    this.host.id = "chrome-tts-error-feedback";
    this.host.hidden = true;

    const shadowRoot = this.host.attachShadow({ mode: "closed" });
    const style = document.createElement("style");
    style.textContent = `
      :host {
        all: initial;
        position: fixed;
        top: 18px;
        left: 50%;
        z-index: 2147483647;
        transform: translateX(-50%);
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }

      .toast {
        box-sizing: border-box;
        max-width: min(560px, calc(100vw - 32px));
        padding: 11px 16px;
        border: 1px solid rgb(179 38 30 / 35%);
        border-radius: 9px;
        color: #7d1b16;
        background: #fce8e6;
        box-shadow: 0 5px 20px rgb(0 0 0 / 20%);
        font-size: 14px;
        font-weight: 600;
        line-height: 1.45;
        word-break: break-word;
      }
    `;

    this.messageElement = document.createElement("div");
    this.messageElement.className = "toast";
    this.messageElement.setAttribute("role", "alert");
    shadowRoot.append(style, this.messageElement);
    document.documentElement.append(this.host);

    // 鼠标悬停时保持错误可见，移出后重新开始 5 秒倒计时。
    this.host.addEventListener("mouseenter", () => this.clearHideTimer());
    this.host.addEventListener("mouseleave", () => this.scheduleHide());
  }

  /** 显示错误；一秒内完全相同的错误只刷新倒计时，不重复播放提示音。 */
  public show(error: ExtensionError): void {
    const now = Date.now();
    const errorKey = `${error.code}:${error.message}`;
    const isDuplicate = errorKey === this.lastErrorKey && now - this.lastShownAt < 1000;

    this.lastErrorKey = errorKey;
    this.lastShownAt = now;
    this.messageElement.textContent = error.message;
    this.host.hidden = false;
    this.scheduleHide();

    if (!isDuplicate) {
      void this.playErrorTone();
    }
  }

  /** 使用两个短振荡器音调生成提示音，不依赖远程或二进制音频资源。 */
  private async playErrorTone(): Promise<void> {
    try {
      const audioContext = new AudioContext();
      await audioContext.resume();
      const gain = audioContext.createGain();
      gain.gain.setValueAtTime(0.0001, audioContext.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.12, audioContext.currentTime + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, audioContext.currentTime + 0.22);
      gain.connect(audioContext.destination);

      const oscillator = audioContext.createOscillator();
      oscillator.type = "sine";
      oscillator.frequency.setValueAtTime(520, audioContext.currentTime);
      oscillator.frequency.setValueAtTime(390, audioContext.currentTime + 0.1);
      oscillator.connect(gain);
      oscillator.start();
      oscillator.stop(audioContext.currentTime + 0.23);
      oscillator.addEventListener("ended", () => {
        void audioContext.close();
      });
    } catch {
      // 自动播放策略或设备问题不应遮蔽原始错误，也不能触发递归提示。
    }
  }

  /** 重新安排自动隐藏，保证最新错误拥有完整阅读时间。 */
  private scheduleHide(): void {
    this.clearHideTimer();
    this.hideTimer = window.setTimeout(() => {
      this.host.hidden = true;
      this.hideTimer = null;
    }, 5000);
  }

  private clearHideTimer(): void {
    if (this.hideTimer !== null) {
      window.clearTimeout(this.hideTimer);
      this.hideTimer = null;
    }
  }
}
