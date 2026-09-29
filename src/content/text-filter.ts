import type { PageTextItem } from "../shared/models";

/**
 * 过滤后的每个字符映射回过滤前文本的字符索引。
 * null 表示整段文字由过滤器生成，不存在可用于逐字高亮的原文位置。
 */
export interface TextFilterResult {
  text: string;
  sourceCharacterIndexes: readonly number[] | null;
  removedSourceRanges: readonly SourceTextRange[];
  /** 过滤器生成提示语时可指定播放完成后的额外停顿。 */
  postPlaybackDelayMs?: number;
}

export interface SourceTextRange {
  start: number;
  end: number;
}

/** 网站文本过滤器只负责纯文本变换，不读取播放器或操作页面 DOM。 */
export interface SiteTextFilter {
  readonly id: string;
  matches(url: URL): boolean;
  filter(text: string): TextFilterResult | null;
}

export interface FilteredPageTextItems {
  items: PageTextItem[];
  sourceIndexesByItemId: Map<string, readonly number[] | null>;
  removedRangesByItemId: Map<string, readonly SourceTextRange[]>;
}

/**
 * 对适配器扫描结果统一应用网站过滤器，并重建连续 index。
 * null 结果代表过滤后没有可播放内容，因此直接从队列删除该条目。
 */
export function filterPageTextItems(
  items: readonly PageTextItem[],
  filter: SiteTextFilter | null,
): FilteredPageTextItems {
  if (filter === null) {
    return {
      items: items.map((item, index) => ({ ...item, index })),
      sourceIndexesByItemId: new Map(),
      removedRangesByItemId: new Map(),
    };
  }

  const filteredItems: PageTextItem[] = [];
  const sourceIndexesByItemId = new Map<
    string,
    readonly number[] | null
  >();
  const removedRangesByItemId = new Map<
    string,
    readonly SourceTextRange[]
  >();
  for (const item of items) {
    const result = filter.filter(item.text);
    if (result === null) {
      continue;
    }
    if (result.removedSourceRanges.length > 0) {
      removedRangesByItemId.set(item.id, result.removedSourceRanges);
    }
    if (!result.text.trim()) {
      continue;
    }
    filteredItems.push({
      ...item,
      text: result.text,
      index: filteredItems.length,
      ...(result.postPlaybackDelayMs === undefined
        ? {}
        : { postPlaybackDelayMs: result.postPlaybackDelayMs }),
    });
    sourceIndexesByItemId.set(item.id, result.sourceCharacterIndexes);
  }

  return { items: filteredItems, sourceIndexesByItemId, removedRangesByItemId };
}
