import type { SiteContentScope } from "../site-content-scope";

/**
 * 新打印页只播放 main 中语义化 article 的内容。
 * 使用正文白名单，不依赖 page-head、section-head 等页面装饰区域的具体类名。
 */
export const endGfwContentScope: SiteContentScope = {
  id: "end-gfw-print-articles",
  matches: (url) =>
    url.hostname === "end-gfw.com" &&
    url.pathname === "/tweets" &&
    url.searchParams.get("view") === "print",
  contains: (element) => element.closest("main article") !== null,
};
