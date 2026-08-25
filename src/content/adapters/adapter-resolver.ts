import { GenericPageAdapter } from "./generic-page-adapter";
import type { PageAdapter } from "./types";

/**
 * 专用网站适配器后续加入此数组并设置更高优先级；通用适配器始终最后兜底。
 * 每次页面只实例化一个适配器，避免不同适配器维护相互冲突的元素映射。
 */
export function resolvePageAdapter(url: URL): PageAdapter {
  const adapters: PageAdapter[] = [new GenericPageAdapter()];
  const matched = adapters
    .filter((adapter) => adapter.matches(url))
    .sort((first, second) => second.priority - first.priority)[0];

  if (!matched) {
    throw new Error("当前页面没有可用的文本适配器。");
  }
  return matched;
}
