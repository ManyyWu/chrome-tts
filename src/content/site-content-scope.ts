import type { PageTextItem } from "../shared/models";
import type { PageAdapter } from "./adapters/types";

/** 网站正文范围只判断现有适配器找到的元素，不参与文本提取或 DOM 修改。 */
export interface SiteContentScope {
  readonly id: string;
  matches(url: URL): boolean;
  contains(element: HTMLElement): boolean;
}

/**
 * 未注册范围的网站原样返回扫描结果，确保现有通用适配器和专用适配器行为不变。
 * 注册范围的网站采用正向白名单；元素无法映射时不进入播放队列，避免退回整页扫描。
 */
export function applySiteContentScope(
  items: readonly PageTextItem[],
  adapter: PageAdapter,
  scope: SiteContentScope | null,
): PageTextItem[] {
  if (scope === null) {
    return [...items];
  }

  return items.filter((item) => {
    const element = adapter.findTextElement(item.id);
    return element !== null && scope.contains(element);
  });
}
