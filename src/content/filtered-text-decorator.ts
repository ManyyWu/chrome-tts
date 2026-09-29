import type { PageAdapter } from "./adapters/types";
import { createNormalizedCharacterMap } from "./dom-text-mapping";
import type { SourceTextRange } from "./text-filter";

const FILTERED_TEXT_HIGHLIGHT_NAME = "chrome-tts-filtered-text";
const FILTERED_TEXT_STYLE_ID = "chrome-tts-filtered-text-style";

/** TypeScript DOM 类型没有暴露 HighlightRegistry 的完整写接口，因此局部收窄。 */
interface WritableHighlightRegistry {
  set(name: string, highlight: Highlight): void;
  delete(name: string): boolean;
}

/** 用非侵入式 CSS Highlight 标记不会被朗读的原文，不插入 span 或改变网站 DOM。 */
export class FilteredTextDecorator {
  private readonly styleElement: HTMLStyleElement;

  public constructor(private readonly adapter: PageAdapter) {
    const existingStyle = document.getElementById(FILTERED_TEXT_STYLE_ID);
    this.styleElement = existingStyle instanceof HTMLStyleElement
      ? existingStyle
      : document.createElement("style");
    if (!this.styleElement.isConnected) {
      this.styleElement.id = FILTERED_TEXT_STYLE_ID;
      document.documentElement.append(this.styleElement);
    }
    // 浅红背景与深红删除线符合“已排除”语义，同时保留足够的正文对比度。
    this.styleElement.textContent = `
      ::highlight(${FILTERED_TEXT_HIGHLIGHT_NAME}) {
        color: #7f1d1d;
        background-color: rgb(255 228 230 / 88%);
        text-decoration-line: line-through;
        text-decoration-color: #b42318;
        text-decoration-thickness: 2px;
      }
    `;
  }

  /** 每次扫描重建全部 Range，兼容页面动态替换文章节点。 */
  public render(
    removedRangesByItemId: ReadonlyMap<
      string,
      readonly SourceTextRange[]
    >,
  ): void {
    const registry = getHighlightRegistry();
    if (!registry) {
      return;
    }

    const ranges: Range[] = [];
    for (const [itemId, sourceRanges] of removedRangesByItemId) {
      const element = this.adapter.findTextElement(itemId);
      if (!element) {
        continue;
      }
      const characters = createNormalizedCharacterMap(element);
      for (const sourceRange of sourceRanges) {
        const range = createDomRange(characters, sourceRange);
        if (range) {
          ranges.push(range);
        }
      }
    }

    if (ranges.length === 0) {
      registry.delete(FILTERED_TEXT_HIGHLIGHT_NAME);
      return;
    }
    registry.set(FILTERED_TEXT_HIGHLIGHT_NAME, new Highlight(...ranges));
  }
}

function createDomRange(
  characters: ReturnType<typeof createNormalizedCharacterMap>,
  sourceRange: SourceTextRange,
): Range | null {
  if (characters.length === 0 || sourceRange.end <= sourceRange.start) {
    return null;
  }
  const startIndex = Math.min(
    characters.length - 1,
    Math.max(0, Math.trunc(sourceRange.start)),
  );
  const endIndex = Math.min(
    characters.length - 1,
    Math.max(startIndex, Math.trunc(sourceRange.end) - 1),
  );
  const start = characters[startIndex];
  const end = characters[endIndex];
  if (!start || !end) {
    return null;
  }

  const range = new Range();
  range.setStart(start.node, start.startOffset);
  range.setEnd(end.node, end.endOffset);
  return range;
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
