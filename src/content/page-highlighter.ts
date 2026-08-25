import type { PageAdapter } from "./adapters/types";

const CURRENT_CLASS = "chrome-tts-current-text";
const STYLE_ID = "chrome-tts-page-highlight-style";
const POSITION_HIGHLIGHT_NAME = "chrome-tts-current-position";
const POSITION_OVERLAY_ID = "chrome-tts-position-overlay";

interface CharacterRange {
  node: Text;
  startOffset: number;
  endOffset: number;
}

/** TypeScript 现有 DOM 声明缺少 HighlightRegistry 的 Map 写操作，按实际 Chrome API 局部补齐。 */
interface WritableHighlightRegistry {
  set(name: string, highlight: Highlight): void;
  delete(name: string): boolean;
}

/** 管理网页正文高亮；适配器负责把稳定 itemId 映射回当前 DOM 元素。 */
export class PageHighlighter {
  private currentElement: HTMLElement | null = null;
  private currentItemId: string | null = null;
  private mappedElement: HTMLElement | null = null;
  private characterMap: CharacterRange[] = [];
  private readonly positionOverlay: HTMLDivElement;

  public constructor(private readonly adapter: PageAdapter) {
    if (!document.getElementById(STYLE_ID)) {
      const style = document.createElement("style");
      style.id = STYLE_ID;
      style.textContent = `
        .${CURRENT_CLASS} {
          outline: 3px solid #22a06b !important;
          outline-offset: 4px !important;
          background: rgb(34 160 107 / 9%) !important;
          transition: background-color 120ms ease, outline-color 120ms ease !important;
        }
        ::highlight(${POSITION_HIGHLIGHT_NAME}) {
          color: #063c2b;
          background-color: #6ee7b7;
          text-decoration: underline 2px #16845b;
          text-underline-offset: 2px;
        }
      `;
      document.documentElement.append(style);
    }

    this.positionOverlay = document.createElement("div");
    this.positionOverlay.id = POSITION_OVERLAY_ID;
    Object.assign(this.positionOverlay.style, {
      position: "fixed",
      inset: "0",
      zIndex: "2147483645",
      pointerEvents: "none",
      overflow: "visible",
    });
    document.documentElement.append(this.positionOverlay);
    window.addEventListener("scroll", () => this.clearPosition(), true);
    window.addEventListener("resize", () => this.clearPosition());
  }

  /** 切换整段高亮；只有条目真正变化时才滚动，暂停/恢复不会反复移动页面。 */
  public highlight(itemId: string): void {
    const element = this.adapter.findTextElement(itemId);
    if (!element) {
      return;
    }

    const itemChanged = itemId !== this.currentItemId || element !== this.currentElement;
    if (itemChanged) {
      this.clearPosition();
      this.currentElement?.classList.remove(CURRENT_CLASS);
      element.classList.add(CURRENT_CLASS);
      element.scrollIntoView({ behavior: "smooth", block: "center" });
      this.currentElement = element;
      this.currentItemId = itemId;
    }
  }

  /** 按规范化文本索引高亮当前字或词；使用 Range，不插入 span，不破坏网站框架状态。 */
  public highlightPosition(itemId: string, charIndex: number, length: number): void {
    const element = this.adapter.findTextElement(itemId);
    const registry = getHighlightRegistry();
    if (!element) {
      return;
    }
    if (element !== this.mappedElement) {
      this.mappedElement = element;
      this.characterMap = createNormalizedCharacterMap(element);
    }
    const characters = this.characterMap;
    const startIndex = Math.min(
      characters.length - 1,
      Math.max(0, Math.trunc(charIndex)),
    );
    if (startIndex < 0) {
      return;
    }
    const endIndex = Math.min(
      characters.length - 1,
      startIndex + Math.max(1, Math.trunc(length)) - 1,
    );
    const start = characters[startIndex];
    const end = characters[endIndex];
    if (!start || !end) {
      return;
    }

    const range = new Range();
    range.setStart(start.node, start.startOffset);
    range.setEnd(end.node, end.endOffset);
    registry?.set(POSITION_HIGHLIGHT_NAME, new Highlight(range));
    this.renderPositionOverlay(range);
  }

  /** 清除当前正文高亮，同时忘记 DOM 引用，下一次播放同一条时仍会重新高亮。 */
  public clear(): void {
    this.clearPosition();
    this.currentElement?.classList.remove(CURRENT_CLASS);
    this.currentElement = null;
    this.currentItemId = null;
    this.mappedElement = null;
    this.characterMap = [];
  }

  private clearPosition(): void {
    getHighlightRegistry()?.delete(POSITION_HIGHLIGHT_NAME);
    this.positionOverlay.replaceChildren();
  }

  /**
   * content script 的 CSS Highlight 注册表在部分页面隔离环境中不会绘制。
   * 用 Range 的视口矩形生成透明覆盖层作为稳定回退，不包裹或拆分正文文本节点。
   */
  private renderPositionOverlay(range: Range): void {
    this.positionOverlay.replaceChildren();
    for (const rect of Array.from(range.getClientRects())) {
      if (rect.width <= 0 || rect.height <= 0) {
        continue;
      }
      const marker = document.createElement("div");
      Object.assign(marker.style, {
        position: "absolute",
        left: `${rect.left}px`,
        top: `${rect.top}px`,
        width: `${rect.width}px`,
        height: `${rect.height}px`,
        boxSizing: "border-box",
        borderBottom: "2px solid #16845b",
        borderRadius: "3px",
        background: "rgb(110 231 183 / 52%)",
        mixBlendMode: "multiply",
      });
      this.positionOverlay.append(marker);
    }
  }

  /** DOM 重新扫描后用同一 ID 重新绑定可能已被替换的元素。 */
  public refresh(): void {
    // 即使外层元素未替换，其内部文本节点也可能被前端框架重建。
    this.mappedElement = null;
    this.characterMap = [];
    if (!this.currentItemId) {
      return;
    }
    const replacement = this.adapter.findTextElement(this.currentItemId);
    if (replacement && replacement !== this.currentElement) {
      this.clearPosition();
      this.currentElement?.classList.remove(CURRENT_CLASS);
      replacement.classList.add(CURRENT_CLASS);
      this.currentElement = replacement;
    }
  }
}

function getHighlightRegistry(): WritableHighlightRegistry | null {
  if (!("highlights" in CSS)) {
    return null;
  }
  const registry = CSS.highlights as unknown as WritableHighlightRegistry;
  return typeof registry.set === "function" && typeof registry.delete === "function"
    ? registry
    : null;
}

/**
 * 把 DOM 文本节点映射为与通用适配器一致的“连续空白折叠为一个空格”字符序列。
 * 每个规范化字符保留原文本节点边界，供 CSS Highlight Range 精确定位。
 */
function createNormalizedCharacterMap(element: HTMLElement): CharacterRange[] {
  const characters: CharacterRange[] = [];
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
  let pendingWhitespace: CharacterRange | null = null;
  let currentNode = walker.nextNode();

  while (currentNode) {
    const textNode = currentNode as Text;
    const value = textNode.data;
    for (let offset = 0; offset < value.length; offset += 1) {
      const character: CharacterRange = {
        node: textNode,
        startOffset: offset,
        endOffset: offset + 1,
      };
      if (/\s/u.test(value[offset] ?? "")) {
        if (characters.length > 0 && pendingWhitespace === null) {
          pendingWhitespace = character;
        }
        continue;
      }

      if (pendingWhitespace !== null) {
        characters.push(pendingWhitespace);
        pendingWhitespace = null;
      }
      characters.push(character);
    }
    currentNode = walker.nextNode();
  }

  return characters;
}
