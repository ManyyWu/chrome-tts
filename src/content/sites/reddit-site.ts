import type {
  SiteIntegration,
  SiteToolPanelConfig,
} from "../site-tool-panel";

const REDDIT_POST_PATH_PATTERN =
  /^\/r\/[^/]+\/comments\/[a-z0-9]+(?:\/|$)/iu;
const SIMPLIFIED_CHINESE_LOCALE = "zh-hans";

/**
 * Reddit 目前只在帖子详情页识别 tl 翻译参数，列表页不注册该工具。
 * 路径判断不依赖帖子标题，因此标题缺失、变化或包含非英文字符时仍能工作。
 */
export const redditSiteIntegration: SiteIntegration = {
  id: "reddit",
  matches: (url) =>
    isRedditHost(url.hostname) && REDDIT_POST_PATH_PATTERN.test(url.pathname),
  create() {
    return {
      // Reddit 帖子页与 End GFW 一致，首次进入时直接显示完整浮动条。
      startExpanded: true,
      toolPanel: createRedditToolPanel(),
    };
  },
};

function createRedditToolPanel(): SiteToolPanelConfig {
  return {
    title: "Reddit 工具",
    actions: [
      {
        id: "open-simplified-chinese-translation",
        label: "简体中文翻译",
        description: "使用 Reddit 的简体中文翻译页面打开当前帖子",
        activate: navigateToSimplifiedChineseTranslation,
      },
    ],
  };
}

/** 保留当前帖子已有参数和锚点，只更新 Reddit 使用的 tl 参数。 */
function navigateToSimplifiedChineseTranslation(): void {
  const targetUrl = new URL(window.location.href);
  if (targetUrl.searchParams.get("tl") === SIMPLIFIED_CHINESE_LOCALE) {
    return;
  }
  targetUrl.searchParams.set("tl", SIMPLIFIED_CHINESE_LOCALE);
  window.location.assign(targetUrl.href);
}

/** 同时兼容 www、old、new 等 Reddit 官方子域名。 */
function isRedditHost(hostname: string): boolean {
  const normalizedHostname = hostname.toLowerCase();
  return normalizedHostname === "reddit.com" ||
    normalizedHostname.endsWith(".reddit.com");
}
