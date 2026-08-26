import type { PageTextItem } from "../../shared/models";
import type {
  PageAdapter,
  PageSelectionPosition,
} from "../adapters/types";

const TWEET_SELECTOR = 'article[data-testid="tweet"]';
const TWEET_TEXT_SELECTOR = '[data-testid="tweetText"]';
const USER_NAME_SELECTOR = '[data-testid="User-Name"]';
const SHOW_MORE_SELECTOR = '[data-testid="tweet-text-show-more-link"]';
const MAX_CACHED_TWEETS = 2000;

interface XTweetSnapshot {
  id: string;
  text: string;
  segments: readonly XTweetTextSegment[];
}

interface XTweetTextSegment {
  element: HTMLElement;
  start: number;
  length: number;
}

/**
 * X 时间线专用适配器。
 *
 * X 会回收滚动区域外的 React 节点，因此队列只保存推文 ID 和文本快照；当前 DOM
 * 映射在每次扫描时重建。所有选择器都使用 data-testid、time 和永久链接，不依赖
 * 随机 id、CSS 类名、虚拟列表下标或 translateY 像素值。
 */
export class XPageAdapter implements PageAdapter {
  public readonly id = "x";
  public readonly priority = 100;
  private readonly snapshots = new Map<string, XTweetSnapshot>();
  private readonly orderedIds: string[] = [];
  private readonly elementsById = new Map<string, HTMLElement>();
  private readonly requestedExpansions = new WeakSet<HTMLElement>();
  private baseQueueContextId = "";
  private queueContextRevision = 0;
  private topAnchorTweetId: string | null = null;
  private pendingInteractionReset = false;

  public constructor() {
    // 排序菜单关闭后不保留选中状态，必须在用户点击时记录一次队列失效信号。
    document.addEventListener("click", this.handleTimelineControlClick, true);
  }

  public matches(url: URL): boolean {
    return url.hostname === "x.com" || url.hostname.endsWith(".x.com");
  }

  public getQueueContextId(): string {
    const base = this.baseQueueContextId || createTimelineContextId();
    return `${base}:revision-${this.queueContextRevision}`;
  }

  /** 扫描当前虚拟窗口，并将新出现的推文合并进不会随 DOM 回收而缩短的队列。 */
  public scanTextItems(): PageTextItem[] {
    const nextQueueContextId = createTimelineContextId();
    if (
      (this.baseQueueContextId &&
        this.baseQueueContextId !== nextQueueContextId) ||
      this.pendingInteractionReset
    ) {
      this.resetQueue();
    }
    this.pendingInteractionReset = false;
    this.baseQueueContextId = nextQueueContextId;
    this.elementsById.clear();
    const observedIds: string[] = [];
    const visibleTimelineIds: string[] = [];
    const articles = Array.from(
      document.querySelectorAll<HTMLElement>(TWEET_SELECTOR),
    );

    for (const article of articles) {
      const visibleTweetId = extractArticleTweetId(article);
      if (visibleTweetId) {
        visibleTimelineIds.push(`x:${visibleTweetId}`);
      }
      if (this.expandTruncatedTweetContent(article)) {
        // 点击后 X 会异步替换正文；本轮不能把截断文本写入稳定队列。
        continue;
      }
      const extracted = extractTweet(article);
      if (extracted === null) {
        continue;
      }
      observedIds.push(extracted.snapshot.id);
      this.snapshots.set(extracted.snapshot.id, extracted.snapshot);
      this.elementsById.set(extracted.snapshot.id, article);
    }

    const firstObservedId = visibleTimelineIds[0] ?? null;
    const isNearTimelineTop = window.scrollY <= 600;
    if (
      isNearTimelineTop &&
      firstObservedId !== null &&
      this.topAnchorTweetId !== null &&
      firstObservedId !== this.topAnchorTweetId
    ) {
      // “显示新推文”可能在没有稳定按钮属性的情况下直接替换顶部数据。
      const currentSnapshots = observedIds.flatMap((id) => {
        const snapshot = this.snapshots.get(id);
        return snapshot ? [[id, snapshot] as const] : [];
      });
      this.resetQueue();
      for (const [id, snapshot] of currentSnapshots) {
        this.snapshots.set(id, snapshot);
      }
    }
    if (isNearTimelineTop && firstObservedId !== null) {
      this.topAnchorTweetId = firstObservedId;
    }

    this.mergeObservedOrder(observedIds);
    this.limitCache();
    return this.orderedIds.flatMap((id, index) => {
      const snapshot = this.snapshots.get(id);
      return snapshot ? [{ id, text: snapshot.text, index }] : [];
    });
  }

  /** 排序方式或新推文刷新属于同一标签内的数据源替换，需要在下一次扫描前失效队列。 */
  private readonly handleTimelineControlClick = (event: Event): void => {
    const target = event.target;
    if (!(target instanceof Element)) {
      return;
    }
    const menuItem = target.closest<HTMLElement>('[role="menuitem"]');
    const menuText = normalizeText(
      menuItem?.closest<HTMLElement>('[role="menu"]')?.innerText ?? "",
    ).toLowerCase();
    const isSortSelection =
      menuItem !== null &&
      (menuText.includes("排序方式") || menuText.includes("sort by"));

    const control = target.closest<HTMLElement>('button, [role="button"]');
    const controlText = normalizeText(
      `${control?.innerText ?? ""} ${control?.getAttribute("aria-label") ?? ""}`,
    ).toLowerCase();
    const isTimelineRefresh =
      control !== null &&
      (/新推文|刷新/u.test(controlText) ||
        controlText.includes("new posts") ||
        controlText.includes("show posts") ||
        controlText.includes("refresh"));

    if (isSortSelection || isTimelineRefresh) {
      this.pendingInteractionReset = true;
    }
  };

  private resetQueue(): void {
    this.snapshots.clear();
    this.orderedIds.splice(0);
    this.elementsById.clear();
    this.topAnchorTweetId = null;
    this.queueContextRevision += 1;
  }

  public findTextElement(itemId: string): HTMLElement | null {
    const element = this.elementsById.get(itemId) ?? null;
    return element?.isConnected === true ? element : null;
  }

  /** X 默认深色主题的浅色文字在浅绿背景上对比不足，高亮期间改为近黑色。 */
  public getHighlightTextColor(_itemId: string): string {
    return "#111111";
  }

  public getTextElementCharOffset(itemId: string): number {
    return this.snapshots.get(itemId)?.segments[0]?.start ?? 0;
  }

  /** 作者、时间和“引用内容”没有正文 DOM；正文位置则映射到主推文或引用正文。 */
  public resolveTextDomPosition(
    itemId: string,
    charIndex: number,
  ): { element: HTMLElement; charIndex: number } | null {
    const segment = this.snapshots.get(itemId)?.segments.find(
      (candidate) =>
        charIndex >= candidate.start &&
        charIndex < candidate.start + candidate.length,
    );
    return segment
      ? { element: segment.element, charIndex: charIndex - segment.start }
      : null;
  }

  /**
   * “显示更多”按钮存在时，剩余正文尚未进入 tweetText。主正文和引用正文都需要
   * 完整展开；WeakSet 防止 DOM 更新前的密集扫描重复触发同一按钮。
   */
  private expandTruncatedTweetContent(article: HTMLElement): boolean {
    const showMoreButtons = Array.from(
      article.querySelectorAll<HTMLElement>(SHOW_MORE_SELECTOR),
    );
    if (showMoreButtons.length === 0) {
      return false;
    }
    // 若正文在按钮稍后出现前曾被缓存，立即清除旧快照，避免播放截断版本。
    const time = article.querySelector<HTMLTimeElement>("time");
    const permalink = time?.closest<HTMLAnchorElement>('a[href*="/status/"]');
    const tweetId = extractTweetId(permalink?.getAttribute("href") ?? "");
    if (tweetId) {
      const itemId = `x:${tweetId}`;
      this.snapshots.delete(itemId);
      const itemIndex = this.orderedIds.indexOf(itemId);
      if (itemIndex >= 0) {
        this.orderedIds.splice(itemIndex, 1);
      }
    }
    for (const showMoreButton of showMoreButtons) {
      if (!this.requestedExpansions.has(showMoreButton)) {
        this.requestedExpansions.add(showMoreButton);
        showMoreButton.click();
      }
    }
    return true;
  }

  /** 选区位于主正文或引用正文时，转换为完整组合话语中的字符位置。 */
  public findSelectionPosition(selection: Selection): PageSelectionPosition | null {
    if (selection.rangeCount === 0 || selection.isCollapsed) {
      return null;
    }
    const range = selection.getRangeAt(0);
    for (const [itemId, snapshot] of this.snapshots) {
      for (const segment of snapshot.segments) {
        if (!segment.element.contains(range.startContainer)) {
          continue;
        }
        const prefixRange = document.createRange();
        prefixRange.selectNodeContents(segment.element);
        try {
          prefixRange.setEnd(range.startContainer, range.startOffset);
        } catch {
          return null;
        }
        const normalizedPrefix = normalizeText(prefixRange.toString());
        return {
          itemId,
          charIndex: segment.start + normalizedPrefix.length,
        };
      }
    }
    return null;
  }

  /**
   * 用已知相邻推文作为锚点合并新 ID。向下滚动时追加，向上重新加载时插回已知项
   * 之前；同一推文无论节点重建多少次都只保留一个队列条目。
   */
  private mergeObservedOrder(observedIds: readonly string[]): void {
    let previousObservedId: string | null = null;
    for (let index = 0; index < observedIds.length; index += 1) {
      const id = observedIds[index];
      if (!id) {
        continue;
      }
      if (this.orderedIds.includes(id)) {
        previousObservedId = id;
        continue;
      }

      const previousIndex = previousObservedId === null
        ? -1
        : this.orderedIds.indexOf(previousObservedId);
      if (previousIndex >= 0) {
        this.orderedIds.splice(previousIndex + 1, 0, id);
      } else {
        const nextKnownId = observedIds
          .slice(index + 1)
          .find((candidate) => this.orderedIds.includes(candidate));
        const nextKnownIndex = nextKnownId
          ? this.orderedIds.indexOf(nextKnownId)
          : -1;
        if (nextKnownIndex >= 0) {
          this.orderedIds.splice(nextKnownIndex, 0, id);
        } else {
          this.orderedIds.push(id);
        }
      }
      previousObservedId = id;
    }
  }

  /** 限制长时间滚动的内存占用；优先淘汰已经不在当前虚拟窗口中的最早条目。 */
  private limitCache(): void {
    while (this.orderedIds.length > MAX_CACHED_TWEETS) {
      const removableIndex = this.orderedIds.findIndex(
        (id) => !this.elementsById.has(id),
      );
      if (removableIndex < 0) {
        return;
      }
      const [removedId] = this.orderedIds.splice(removableIndex, 1);
      if (removedId) {
        this.snapshots.delete(removedId);
      }
    }
  }
}

function extractTweet(
  article: HTMLElement,
): { snapshot: XTweetSnapshot } | null {
  // 实际 DOM 中主推文 time 始终先于引用卡片 time；广告没有 time，因此会自然排除。
  const mainTime = article.querySelector<HTMLTimeElement>("time");
  const permalink = mainTime?.closest<HTMLAnchorElement>('a[href*="/status/"]');
  const tweetId = extractTweetId(permalink?.getAttribute("href") ?? "");
  if (!mainTime || !permalink || !tweetId) {
    return null;
  }

  // 引用推文正文位于 role=link 容器中；只选择不属于引用卡片的主正文。
  const textElement = Array.from(
    article.querySelectorAll<HTMLElement>(TWEET_TEXT_SELECTOR),
  ).find((element) => element.closest('[role="link"]') === null) ?? null;
  if (textElement === null) {
    return null;
  }

  const author = extractAuthor(article);
  const time = normalizeText(mainTime.textContent ?? "");
  const body = normalizeText(textElement.innerText);
  if (!author || !time || !body) {
    return null;
  }

  const prefix = `${author}。${time}。`;
  let speechText = `${prefix}${body}`;
  const segments: XTweetTextSegment[] = [
    { element: textElement, start: prefix.length, length: body.length },
  ];

  const quotedTextElement = Array.from(
    article.querySelectorAll<HTMLElement>(TWEET_TEXT_SELECTOR),
  ).find((element) => element.closest('[role="link"]') !== null) ?? null;
  if (quotedTextElement !== null) {
    const quotedContainer = quotedTextElement.closest<HTMLElement>('[role="link"]');
    const quotedTimeElement = quotedContainer?.querySelector<HTMLTimeElement>("time");
    const quotedAuthor = quotedContainer
      ? extractAuthor(quotedContainer)
      : "";
    const quotedTime = normalizeText(quotedTimeElement?.textContent ?? "");
    const quotedBody = normalizeText(quotedTextElement.innerText);
    if (quotedAuthor && quotedTime && quotedBody) {
      const quoteIntroduction = "。引用内容。";
      const quotedPrefix = `${quotedAuthor}。${quotedTime}。`;
      const quotedBodyStart =
        speechText.length + quoteIntroduction.length + quotedPrefix.length;
      speechText += `${quoteIntroduction}${quotedPrefix}${quotedBody}`;
      segments.push({
        element: quotedTextElement,
        start: quotedBodyStart,
        length: quotedBody.length,
      });
    }
  }

  return {
    snapshot: {
      id: `x:${tweetId}`,
      text: speechText,
      segments,
    },
  };
}

function extractAuthor(article: HTMLElement): string {
  const userName = article.querySelector<HTMLElement>(USER_NAME_SELECTOR);
  const nameLink = userName?.querySelector<HTMLElement>('a[role="link"]');
  const linkedName = normalizeText(nameLink?.innerText ?? "");
  if (linkedName) {
    return linkedName;
  }

  // 引用卡片整体已经是 role=link，内部 User-Name 不再嵌套作者链接，首行即显示名。
  return (userName?.innerText ?? "")
    .split(/\r?\n/u)
    .map(normalizeText)
    .find((line) => line && !line.startsWith("@") && line !== "·") ?? "";
}

function extractTweetId(href: string): string | null {
  return href.match(/\/status\/(\d+)(?:$|[/?#])/u)?.[1] ?? null;
}

function extractArticleTweetId(article: HTMLElement): string | null {
  const time = article.querySelector<HTMLTimeElement>("time");
  const permalink = time?.closest<HTMLAnchorElement>('a[href*="/status/"]');
  return extractTweetId(permalink?.getAttribute("href") ?? "");
}

function normalizeText(text: string): string {
  return text.replace(/\s+/gu, " ").trim();
}

/** X 首页标签共用 URL；选中标签序号和文字共同标识当前互斥时间线。 */
function createTimelineContextId(): string {
  const selectedTab = document.querySelector<HTMLElement>(
    '[data-testid="ScrollSnap-List"] [role="tab"][aria-selected="true"]',
  );
  const tabList = selectedTab?.closest<HTMLElement>('[role="tablist"]');
  const tabs = tabList
    ? Array.from(tabList.querySelectorAll<HTMLElement>('[role="tab"]'))
    : [];
  const selectedIndex = selectedTab ? tabs.indexOf(selectedTab) : -1;
  const selectedLabel = normalizeText(selectedTab?.innerText ?? "none");
  return `${window.location.pathname}:${selectedIndex}:${selectedLabel}`;
}
