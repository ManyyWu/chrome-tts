import type { PageTextItem } from "../../shared/models";

export interface PageSelectionPosition {
  itemId: string;
  charIndex: number;
}

/** 网站适配器只负责把 DOM 转换成有序文本条目，并保留条目到元素的本地映射。 */
export interface PageAdapter {
  readonly id: string;
  readonly priority: number;
  matches(url: URL): boolean;
  scanTextItems(): PageTextItem[];
  findTextElement(itemId: string): HTMLElement | null;
  findSelectionPosition(selection: Selection): PageSelectionPosition | null;
}
