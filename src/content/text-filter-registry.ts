import { endGfwTextFilter } from "./sites/end-gfw-text-filter";
import type { SiteTextFilter } from "./text-filter";

/**
 * 网站过滤器的唯一注册表。后续适配新网站时新增独立过滤器，并在数组中注册即可；
 * 未匹配的网站返回 null，保持原有通用播放逻辑完全不变。
 */
export function resolveSiteTextFilter(url: URL): SiteTextFilter | null {
  const filters: readonly SiteTextFilter[] = [endGfwTextFilter];
  return filters.find((filter) => filter.matches(url)) ?? null;
}
