import type { PageTextItem } from "../../shared/models";
import type { PageAdapter, PageSelectionPosition } from "./types";

const EXCLUDED_SELECTOR =
  "script, style, noscript, template, [hidden], [aria-hidden='true'], " +
  "input, textarea, select, option, " +
  "#chrome-tts-floating-control-bar, #chrome-tts-error-feedback, " +
  "#chrome-tts-selection-jump-prompt, #chrome-tts-position-overlay, " +
  "#chrome-tts-collapsed-launcher";

/**
 * “播放所有可见文本”模式的独立适配器。
 * 文本节点按最近的可视块级容器合并，避免行内 span、strong、a 被拆成大量短话语。
 */
export class VisibleTextAdapter implements PageAdapter {
  public readonly id = "visible-text";
  public readonly priority = 0;
  private readonly elementsById = new Map<string, HTMLElement>();

  public matches(_url: URL): boolean {
    return true;
  }

  /** 遍历普通 DOM 中已渲染的文本节点，并按文档顺序生成播放条目。 */
  public scanTextItems(): PageTextItem[] {
    this.elementsById.clear();
    const textNodesByGroup = new Map<HTMLElement, Text[]>();
    const walker = document.createTreeWalker(
      document.body,
      NodeFilter.SHOW_TEXT,
      {
        acceptNode: (node) =>
          this.isVisibleTextNode(node as Text)
            ? NodeFilter.FILTER_ACCEPT
            : NodeFilter.FILTER_REJECT,
      },
    );

    let node = walker.nextNode();
    while (node) {
      const group = this.findTextGroup(node as Text);
      if (group) {
        const groupedNodes = textNodesByGroup.get(group) ?? [];
        groupedNodes.push(node as Text);
        textNodesByGroup.set(group, groupedNodes);
      }
      node = walker.nextNode();
    }

    // 父容器含有独立子分组时，只朗读直接归属于父容器的节点，避免子文本重复播放。
    const groupsWithNestedGroups = new Set<HTMLElement>();
    for (const group of textNodesByGroup.keys()) {
      let ancestor = group.parentElement;
      while (ancestor && ancestor !== document.body) {
        if (textNodesByGroup.has(ancestor)) {
          groupsWithNestedGroups.add(ancestor);
        }
        ancestor = ancestor.parentElement;
      }
    }

    const items: PageTextItem[] = [];
    for (const [element, groupedNodes] of textNodesByGroup) {
      const text = groupsWithNestedGroups.has(element)
        ? normalizeText(groupedNodes.map((node) => node.data).join(" "))
        : normalizeText(element.innerText);
      if (!text || text.length > 32768) {
        continue;
      }
      const id = `visible:${createDomPath(element)}:${hashText(text)}`;
      items.push({ id, text, index: items.length });
      this.elementsById.set(id, element);
    }
    return items;
  }

  public findTextElement(itemId: string): HTMLElement | null {
    const element = this.elementsById.get(itemId) ?? null;
    return element?.isConnected === true ? element : null;
  }

  /** 将选区起点映射到当前可见文本条目的规范化字符索引。 */
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

  /** 文本节点及其父元素必须实际渲染，隐藏区域和扩展自身界面全部排除。 */
  private isVisibleTextNode(node: Text): boolean {
    if (!node.data.trim()) {
      return false;
    }
    const parent = node.parentElement;
    if (!parent || parent.closest(EXCLUDED_SELECTOR)) {
      return false;
    }
    let element: HTMLElement | null = parent;
    while (element) {
      const style = window.getComputedStyle(element);
      if (
        style.display === "none" ||
        style.visibility === "hidden" ||
        style.opacity === "0" ||
        style.contentVisibility === "hidden"
      ) {
        return false;
      }
      element = element.parentElement;
    }
    return parent.getClientRects().length > 0;
  }

  /** 优先最近的块级或可交互容器，使朗读分段接近页面视觉分组。 */
  private findTextGroup(node: Text): HTMLElement | null {
    let element = node.parentElement;
    while (element && element !== document.body) {
      const display = window.getComputedStyle(element).display;
      if (
        element.matches(
          "button, label, summary, h1, h2, h3, h4, h5, h6, p, li, " +
            "blockquote, figcaption, td, th, dt, dd, pre",
        ) ||
        display === "block" ||
        display === "flex" ||
        display === "grid" ||
        display === "list-item" ||
        display === "table-cell"
      ) {
        return element;
      }
      element = element.parentElement;
    }
    return node.parentElement;
  }
}

function normalizeText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

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

function hashText(text: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}
