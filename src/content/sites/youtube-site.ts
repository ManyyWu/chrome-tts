import type { ExtensionError, PlaybackState } from "../../shared/models";
import type {
  SiteIntegration,
  SiteIntegrationContext,
  SiteToolPanelConfig,
} from "../site-tool-panel";

const CAPTION_SEGMENT_SELECTOR =
  ".ytp-caption-window-container .ytp-caption-segment";
const YOUTUBE_NAVIGATION_START_EVENT = "yt-navigate-start";

/**
 * YouTube 使用单页路由，字幕节点也会持续替换。本适配只监听播放器已经显示的字幕，
 * 不读取页面内部变量、不调用字幕接口，也不依赖界面语言。
 */
export const youtubeSiteIntegration: SiteIntegration = {
  id: "youtube",
  matches: (url) => isYoutubeHost(url.hostname),
  create(_url, context) {
    const reader = new YoutubeCaptionReader(context);
    return {
      // YouTube 的单页路由不会重新注入 content script，工具入口需在整个站点保持可用。
      toolPanel: createToolPanel(reader),
      start: () => reader.start(),
      stop: () => reader.stop(),
    };
  },
};

function createToolPanel(reader: YoutubeCaptionReader): SiteToolPanelConfig {
  return {
    title: "YouTube 字幕工具",
    actions: [
      {
        id: "start-caption-reading",
        label: "开启字幕朗读",
        description: "朗读播放器中当前及后续显示的字幕",
        activate: () => reader.enable(),
      },
      {
        id: "stop-caption-reading",
        label: "停止字幕朗读",
        description: "停止监听字幕并停止当前字幕语音",
        activate: () => reader.disable(),
      },
      {
        id: "select-simplified-chinese-captions",
        label: "切换简体中文字幕",
        description: "自动选择字幕、自动翻译、中文（简体）",
        isAvailable: () => reader.hasAvailableCaptions(),
        activate: () => {
          void reader.selectSimplifiedChineseCaptions();
        },
      },
    ],
  };
}

class YoutubeCaptionReader {
  private observer: MutationObserver | null = null;
  private captionReadTimer: number | null = null;
  private enabled = false;
  private previousCaption = "";
  private pendingCaption = "";
  private captionSpeechActive = false;
  private unsubscribePlaybackState: (() => void) | null = null;

  public constructor(private readonly context: SiteIntegrationContext) {}

  /** 单页导航事件负责重新绑定播放器，避免长期观察整个 YouTube 文档。 */
  public start(): void {
    this.unsubscribePlaybackState = this.context.subscribePlaybackState(
      (state) => this.handlePlaybackState(state),
    );
    document.addEventListener(
      YOUTUBE_NAVIGATION_START_EVENT,
      this.handleNavigationStart,
    );
  }

  public stop(): void {
    this.disable();
    this.unsubscribePlaybackState?.();
    this.unsubscribePlaybackState = null;
    this.observer?.disconnect();
    this.observer = null;
    document.removeEventListener(
      YOUTUBE_NAVIGATION_START_EVENT,
      this.handleNavigationStart,
    );
  }

  /** 开启时要求播放器已经启用字幕，避免按钮成功但页面实际上没有字幕来源。 */
  public enable(): void {
    if (!isWatchPage(new URL(window.location.href))) {
      this.report("YOUTUBE_NOT_WATCH_PAGE", "请先打开 YouTube 视频播放页。");
      return;
    }
    if (document.querySelector(CAPTION_SEGMENT_SELECTOR) === null) {
      this.report(
        "YOUTUBE_CAPTION_NOT_VISIBLE",
        "没有检测到字幕，请先在 YouTube 播放器中开启字幕。",
      );
      return;
    }

    this.enabled = true;
    this.previousCaption = "";
    this.pendingCaption = "";
    this.captionSpeechActive = false;
    this.connectCaptionObserver();
    this.scheduleCaptionRead();
  }

  public disable(): void {
    const wasEnabled = this.enabled;
    this.enabled = false;
    this.previousCaption = "";
    this.pendingCaption = "";
    this.captionSpeechActive = false;
    this.observer?.disconnect();
    this.observer = null;
    if (this.captionReadTimer !== null) {
      window.clearTimeout(this.captionReadTimer);
      this.captionReadTimer = null;
    }
    if (wasEnabled) {
      this.context.stopPlayback();
    }
  }

  /** 仅当当前播放器公开可用的 CC 按钮时显示翻译入口。 */
  public hasAvailableCaptions(): boolean {
    const button = document.querySelector<HTMLButtonElement>(
      ".ytp-subtitles-button",
    );
    return (
      button !== null &&
      !button.disabled &&
      button.getAttribute("aria-disabled") !== "true"
    );
  }

  /**
   * 依次操作播放器的设置、字幕和自动翻译菜单。YouTube 没有公开字幕翻译 API，
   * 因此这里使用可见菜单结构；标签匹配同时兼容中英文界面和全角/半角括号。
   */
  public async selectSimplifiedChineseCaptions(): Promise<void> {
    try {
      if (!isWatchPage(new URL(window.location.href))) {
        throw new Error("请先打开 YouTube 视频播放页。");
      }

      const captionButton = document.querySelector<HTMLButtonElement>(
        ".ytp-subtitles-button",
      );
      if (
        captionButton === null ||
        captionButton.disabled ||
        captionButton.getAttribute("aria-disabled") === "true"
      ) {
        throw new Error("当前视频没有可用字幕。");
      }

      // 自动翻译依赖一个已启用的原始字幕轨道；未启用时先点击 CC。
      if (captionButton.getAttribute("aria-pressed") !== "true") {
        captionButton.click();
        await waitForCondition(
          () => captionButton.getAttribute("aria-pressed") === "true",
          "字幕未能开启，请先手动点击播放器的 CC 按钮。",
        );
      }

      const settingsButton = document.querySelector<HTMLButtonElement>(
        ".ytp-settings-button",
      );
      if (settingsButton === null) {
        throw new Error("没有找到 YouTube 播放器设置按钮。");
      }
      settingsButton.click();

      const subtitleItem = await waitForMenuItem(
        isSubtitleMenuLabel,
        "设置菜单中没有找到字幕选项。",
      );
      subtitleItem.click();

      // 等子菜单实际完成替换，再在同一批选项中优先判断原生简体中文轨道。
      const subtitleChoices = await waitForValue(
        () => {
          const items = getVisibleMenuItems();
          return items.some((item) => {
            const label = getMenuItemLabel(item);
            return isSimplifiedChineseLabel(label) || isAutoTranslateLabel(label);
          })
            ? items
            : null;
        },
        3000,
      );
      if (subtitleChoices === null) {
        throw new Error("字幕列表没有展开，或其中没有自动翻译选项。");
      }
      const directChineseItem = subtitleChoices.find((item) =>
        isSimplifiedChineseLabel(getMenuItemLabel(item))
      ) ?? null;
      if (directChineseItem !== null) {
        directChineseItem.click();
        return;
      }

      const autoTranslateItem = subtitleChoices.find((item) =>
        isAutoTranslateLabel(getMenuItemLabel(item))
      );
      if (!autoTranslateItem) {
        throw new Error("字幕菜单中没有自动翻译选项。");
      }
      autoTranslateItem.click();

      const simplifiedChineseItem = await waitForMenuItem(
        isSimplifiedChineseLabel,
        "自动翻译语言列表中没有找到中文（简体）。",
        true,
      );
      simplifiedChineseItem.click();
    } catch (error: unknown) {
      this.report(
        "YOUTUBE_SELECT_CHINESE_CAPTION_FAILED",
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  private readonly handleNavigationStart = (): void => {
    const wasEnabled = this.enabled;
    this.enabled = false;
    this.previousCaption = "";
    this.pendingCaption = "";
    this.captionSpeechActive = false;
    this.observer?.disconnect();
    this.observer = null;
    if (this.captionReadTimer !== null) {
      window.clearTimeout(this.captionReadTimer);
      this.captionReadTimer = null;
    }
    if (wasEnabled) {
      this.context.stopPlayback();
    }
  };

  /** 字幕容器会随视频切换而销毁，因此每次启用或导航完成后重新建立观察器。 */
  private connectCaptionObserver(): void {
    this.observer?.disconnect();
    this.observer = null;
    const captionContainer = document.querySelector<HTMLElement>(
      ".ytp-caption-window-container",
    );
    if (captionContainer === null) {
      return;
    }
    this.observer = new MutationObserver(() => this.scheduleCaptionRead());
    this.observer.observe(captionContainer, {
      childList: true,
      characterData: true,
      subtree: true,
    });
  }

  /** 短延迟防抖可合并实时字幕的逐字符更新，避免每个字符都重启一次 TTS。 */
  private scheduleCaptionRead(): void {
    if (!this.enabled) {
      return;
    }
    if (this.captionReadTimer !== null) {
      window.clearTimeout(this.captionReadTimer);
    }
    this.captionReadTimer = window.setTimeout(() => {
      this.captionReadTimer = null;
      this.readCurrentCaption();
    }, 120);
  }

  private readCurrentCaption(): void {
    if (!this.enabled) {
      return;
    }
    const video = document.querySelector<HTMLVideoElement>("video.html5-main-video");
    if (video?.paused === true || video?.ended === true) {
      return;
    }

    const caption = Array.from(
      document.querySelectorAll<HTMLElement>(CAPTION_SEGMENT_SELECTOR),
    )
      .map((segment) => normalizeCaption(segment.textContent ?? ""))
      .filter(Boolean)
      .join(" ")
      .trim();
    if (!caption || caption === this.previousCaption) {
      return;
    }

    // YouTube 常通过“旧字幕 + 新字幕”逐步扩展同一窗口，只朗读新增后缀可避免重复。
    const newText = removeRepeatedPrefix(this.previousCaption, caption);
    this.previousCaption = caption;
    if (newText) {
      this.pendingCaption = appendCaption(this.pendingCaption, newText);
      this.flushCaptionQueue();
    }
  }

  /** 同一时刻只提交一个字幕话语；后续 DOM 更新先进入缓冲，等待 completed。 */
  private flushCaptionQueue(): void {
    if (!this.enabled || this.captionSpeechActive || !this.pendingCaption) {
      return;
    }
    const text = this.pendingCaption;
    this.pendingCaption = "";
    this.captionSpeechActive = true;
    this.context.playCaption(text);
  }

  private handlePlaybackState(state: PlaybackState): void {
    if (state.source !== "caption") {
      return;
    }
    if (
      state.status === "loading" ||
      state.status === "playing" ||
      state.status === "paused"
    ) {
      this.captionSpeechActive = true;
      return;
    }
    if (state.status === "completed") {
      this.captionSpeechActive = false;
      this.flushCaptionQueue();
      return;
    }
    if (state.status === "stopped" || state.status === "error") {
      // 外部标签接管或用户停止后不自动抢回全局 TTS，需再次点击开启。
      this.enabled = false;
      this.captionSpeechActive = false;
      this.pendingCaption = "";
    }
  }

  private report(code: string, message: string): void {
    const error: ExtensionError = {
      code,
      message,
      source: "content",
      recoverable: true,
    };
    this.context.reportError(error);
  }
}

function isYoutubeHost(hostname: string): boolean {
  return hostname === "youtube.com" || hostname.endsWith(".youtube.com");
}

function isWatchPage(url: URL): boolean {
  return isYoutubeHost(url.hostname) && url.pathname === "/watch";
}

function normalizeCaption(text: string): string {
  return text.replace(/\s+/gu, " ").trim();
}

function appendCaption(buffer: string, text: string): string {
  return buffer ? `${buffer} ${text}` : text;
}

/** 菜单标签归一化后，全角“（ ）”和半角“( )”会得到相同结果。 */
function normalizeMenuLabel(text: string): string {
  return text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\s\-_/]+/gu, "")
    .trim();
}

function getMenuItemLabel(item: HTMLElement): string {
  const label = item.querySelector<HTMLElement>(".ytp-menuitem-label");
  return normalizeMenuLabel(label?.textContent ?? item.textContent ?? "");
}

function isSubtitleMenuLabel(label: string): boolean {
  return (
    label.includes("字幕") ||
    label.includes("subtitles") ||
    label.includes("captions")
  );
}

function isAutoTranslateLabel(label: string): boolean {
  return label.includes("自动翻译") || label.includes("autotranslate");
}

function isSimplifiedChineseLabel(label: string): boolean {
  const targets = new Set([
    "中文(简体)",
    "简体中文",
    "chinese(simplified)",
    "chinese(simplifiedchinese)",
  ]);
  return targets.has(label);
}

function getVisibleMenuItems(): HTMLElement[] {
  const player = document.querySelector<HTMLElement>(".html5-video-player");
  if (player === null) {
    return [];
  }
  const candidates = Array.from(
    player.querySelectorAll<HTMLElement>(
      ".ytp-menuitem, [role='menuitem'], .ytp-menuitem-label",
    ),
  );
  const clickableItems = candidates.map((candidate) =>
    candidate.closest<HTMLElement>(".ytp-menuitem, [role='menuitem']") ??
      candidate
  );
  return Array.from(new Set(clickableItems))
    .filter((item) => {
      const style = window.getComputedStyle(item);
      const rect = item.getBoundingClientRect();
      return (
        style.display !== "none" &&
        style.visibility !== "hidden" &&
        rect.width > 0 &&
        rect.height > 0
      );
    });
}

async function waitForMenuItem(
  matches: (label: string) => boolean,
  errorMessage: string,
  scrollToEnd = false,
): Promise<HTMLElement> {
  const item = await waitForValue(
    () => {
      const matched = getVisibleMenuItems().find((candidate) =>
        matches(getMenuItemLabel(candidate))
      ) ?? null;
      if (matched === null && scrollToEnd) {
        scrollOpenMenuToEnd();
      }
      return matched;
    },
    3000,
  );
  if (item === null) {
    throw new Error(errorMessage);
  }
  return item;
}

/** 移动端语言列表具有独立滚动区，简体中文通常位于末尾。 */
function scrollOpenMenuToEnd(): void {
  const player = document.querySelector<HTMLElement>(".html5-video-player");
  const panels = player === null
    ? []
    : Array.from(
        player.querySelectorAll<HTMLElement>(
          ".ytp-panel-menu, [role='menu']",
        ),
      );
  for (const panel of panels) {
    if (panel.scrollHeight > panel.clientHeight) {
      panel.scrollTop = panel.scrollHeight;
    }
  }
}

async function waitForCondition(
  condition: () => boolean,
  errorMessage: string,
): Promise<void> {
  const matched = await waitForValue(() => condition() ? true : null, 2000);
  if (matched === null) {
    throw new Error(errorMessage);
  }
}

/** 轮询等待 YouTube 异步菜单动画和 DOM 替换，不依赖固定的动画时长。 */
async function waitForValue<T>(
  read: () => T | null,
  timeout: number,
): Promise<T | null> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = read();
    if (value !== null) {
      return value;
    }
    await new Promise<void>((resolve) => window.setTimeout(resolve, 50));
  }
  return read();
}

/** 返回当前字幕相对上一帧真正新增的部分，兼容按字符增长和整行滚动两种更新方式。 */
function removeRepeatedPrefix(previous: string, current: string): string {
  if (!previous) {
    return current;
  }
  const maximumOverlap = Math.min(previous.length, current.length);
  for (let length = maximumOverlap; length > 0; length -= 1) {
    if (previous.slice(-length) === current.slice(0, length)) {
      return current.slice(length).trim();
    }
  }
  return current;
}
