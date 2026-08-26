import type { PageTextItem } from "../../shared/models";

export interface PageSelectionPosition {
  itemId: string;
  charIndex: number;
}

export interface PageTextDomPosition {
  element: HTMLElement;
  charIndex: number;
}

/** 网站适配器只负责把 DOM 转换成有序文本条目，并保留条目到元素的本地映射。 */
export interface PageAdapter {
  readonly id: string;
  readonly priority: number;
  matches(url: URL): boolean;
  scanTextItems(): PageTextItem[];
  /** 单页应用内部切换互斥内容源时，用于识别需要重置的独立队列。 */
  getQueueContextId?(): string;
  findTextElement(itemId: string): HTMLElement | null;
  /** 个别网站的深色主题需要在浅色高亮背景上临时覆盖文字颜色。 */
  getHighlightTextColor?(itemId: string): string | null;
  /** 朗读文本包含 DOM 外前缀时，返回正文在完整话语中的字符起点。 */
  getTextElementCharOffset?(itemId: string): number;
  /** 一个话语映射多个正文元素时，将完整话语位置转换到对应 DOM 元素。 */
  resolveTextDomPosition?(
    itemId: string,
    charIndex: number,
  ): PageTextDomPosition | null;
  findSelectionPosition(selection: Selection): PageSelectionPosition | null;
}
