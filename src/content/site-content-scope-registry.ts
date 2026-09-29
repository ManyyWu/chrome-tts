import { endGfwContentScope } from "./sites/end-gfw-content-scope";
import type { SiteContentScope } from "./site-content-scope";

/** 新网站只需新增独立范围文件并在此注册；未匹配时不介入现有扫描逻辑。 */
export function resolveSiteContentScope(url: URL): SiteContentScope | null {
  const scopes: readonly SiteContentScope[] = [endGfwContentScope];
  return scopes.find((scope) => scope.matches(url)) ?? null;
}
