import type { PageTextItem } from "../../shared/models";
import type { PageAdapter, PageSelectionPosition } from "./types";

const CANDIDATE_SELECTOR =
  "h1, h2, h3, h4, h5, h6, p, li, blockquote, figcaption, td, th";
const EXCLUDED_ANCESTOR_SELECTOR =
  "nav, header, footer, aside, form, dialog, button, input, textarea, select, " +
  "script, style, noscript, template, [hidden], [aria-hidden='true'], " +
  "#chrome-tts-floating-control-bar, #chrome-tts-error-feedback, " +
  "#chrome-tts-selection-jump-prompt, #chrome-tts-position-overlay, " +
  "#chrome-tts-collapsed-launcher";

/**
 * 所有已授权网站的保底适配器。
 * 它不包含网站名称或专用选择器，专用适配器可通过更高 priority 覆盖它。
 */
export class GenericPageAdapter implements PageAdapter {
  public readonly id = "generic";
  public readonly priority = 0;
  private readonly elementsById = new Map<string, HTMLElement>();

  public matches(_url: URL): boolean {
    return true;
  }

  /** 扫描可见块级文本，过滤页面框架、重复父子内容和无意义短文本。 */
  public scanTextItems(): PageTextItem[] {
    this.elementsById.clear();
    const root = this.findContentRoot();
    const candidates = Array.from(
      root.querySelectorAll<HTMLElement>(CANDIDATE_SELECTOR),
    );
    const acceptedElements = candidates.filter((element) =>
      this.isAcceptedElement(element),
    );
    const acceptedSet = new Set(acceptedElements);
    const seenText = new Set<string>();
    const items: PageTextItem[] = [];

    for (const element of acceptedElements) {
      // 父候选包含已接受的更细子候选时只保留子元素，避免同一正文朗读两次。
      if (
        Array.from(element.querySelectorAll<HTMLElement>(CANDIDATE_SELECTOR)).some(
          (child) => child !== element && acceptedSet.has(child),
        )
      ) {
        continue;
      }

      const text = normalizeText(element.innerText);
      if (seenText.has(text)) {
        continue;
      }
      seenText.add(text);

      const id = `generic:${createDomPath(element)}:${hashText(text)}`;
      const item: PageTextItem = { id, text, index: items.length };
      items.push(item);
      this.elementsById.set(id, element);
    }

    return items;
  }

  public findTextElement(itemId: string): HTMLElement | null {
    const element = this.elementsById.get(itemId) ?? null;
    return element?.isConnected === true ? element : null;
  }

  /** 把选区起点转换为规范化段落文本中的字符位置，供“跳转”从该处开始播放。 */
  public findSelectionPosition(
    selection: Selection,
  ): PageSelectionPosition | null {
    if (selection.rangeCount === 0 || selection.isCollapsed) {
      return null;
    }
    const selectedRange = selection.getRangeAt(0);
    for (const [itemId, element] of this.elementsById) {
      if (!element.contains(selectedRange.startContainer)) {
        continue;
      }

      const prefixRange = document.createRange();
      prefixRange.selectNodeContents(element);
      try {
        prefixRange.setEnd(
          selectedRange.startContainer,
          selectedRange.startOffset,
        );
      } catch {
        return null;
      }
      const fullText = normalizeText(element.innerText);
      const normalizedPrefix = prefixRange
        .toString()
        .replace(/\s+/g, " ")
        .trimStart();
      return {
        itemId,
        charIndex: Math.min(fullText.length, normalizedPrefix.length),
      };
    }
    return null;
  }

  /** 优先正文语义容器；没有时才扫描 body，减少导航和侧栏进入队列的概率。 */
  private findContentRoot(): HTMLElement {
    const main = document.querySelector<HTMLElement>("main");
    if (main) {
      return main;
    }
    const roleMain = document.querySelector<HTMLElement>("[role='main']");
    if (roleMain) {
      return roleMain;
    }

    // 单篇文章页可直接使用 article；列表页有多个 article 时回退 body 扫描全部内容。
    const articles = document.querySelectorAll<HTMLElement>("article");
    return articles.length === 1 ? articles[0] ?? document.body : document.body;
  }

  private isAcceptedElement(element: HTMLElement): boolean {
    if (element.closest(EXCLUDED_ANCESTOR_SELECTOR)) {
      return false;
    }

    const style = window.getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    if (
      style.display === "none" ||
      style.visibility === "hidden" ||
      rect.width <= 0 ||
      rect.height <= 0
    ) {
      return false;
    }

    const text = normalizeText(element.innerText);
    const isHeading = /^H[1-6]$/.test(element.tagName);
    const minimumLength = isHeading ? 2 : 5;
    return (
      text.length >= minimumLength &&
      text.length <= 32768 &&
      /[\p{L}\p{N}]/u.test(text)
    );
  }
}

function normalizeText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** DOM 路径只用于当前页面会话的稳定定位，不承诺跨页面版本永久不变。 */
function createDomPath(element: HTMLElement): string {
  const segments: string[] = [];
  let current: HTMLElement | null = element;
  while (current && current !== document.body) {
    const parent: HTMLElement | null = current.parentElement;
    const siblings = parent
      ? Array.from(parent.children).filter(
          (sibling) => sibling.tagName === current?.tagName,
        )
      : [];
    const position = Math.max(0, siblings.indexOf(current)) + 1;
    segments.push(`${current.tagName.toLowerCase()}[${position}]`);
    current = parent;
  }
  return segments.reverse().join("/");
}

/** 32 位 FNV-1a 足以在单页队列内区分文本，同时避免把正文复制进 ID。 */
function hashText(text: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}
