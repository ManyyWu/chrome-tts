import type { ExtensionError } from "../../shared/models";
import type {
  SiteIntegration,
  SiteIntegrationContext,
  SiteToolPanelConfig,
} from "../site-tool-panel";

interface EndGfwDate {
  year: number;
  month: number;
  day: number;
}

const END_GFW_TWEET_SELECTOR =
  'article[id][itemscope][itemtype="http://schema.org/SocialMediaPosting"]';

/** End GFW 的全部特殊行为集中于此，注册入口只负责匹配和调度。 */
export const endGfwSiteIntegration: SiteIntegration = {
  id: "end-gfw",
  matches: (url) => url.hostname === "end-gfw.com",
  create(url, context) {
    const toolPanel = createTweetPageToolPanel(url, context);
    return {
      // 该站点明确要求进入页面时直接展示浮动条。
      startExpanded: true,
      ...(toolPanel ? { toolPanel } : {}),
    };
  },
};

/** 工具仅在具有合法年月日参数的 tweet-page 页面启用。 */
function createTweetPageToolPanel(
  url: URL,
  context: SiteIntegrationContext,
): SiteToolPanelConfig | null {
  const date = parseEndGfwDate(url);
  if (url.pathname !== "/tweet-page" || !date) {
    return null;
  }

  return {
    title: "End GFW 工具",
    actions: [
      {
        id: "copy-tweet-id",
        label: "复制推文 ID",
        description: "复制当前播放或当前可见推文的 ID",
        activate: () => {
          void copyCurrentTweetId(context).catch((error: unknown) => {
            context.reportError(createSiteToolError("COPY_TWEET_ID_FAILED", error));
          });
        },
      },
      {
        id: "previous-day",
        label: "上一天",
        description: "跳转到上一天的推文页面",
        activate: () => navigateToAdjacentDay(url, date, -1),
      },
      {
        id: "next-day",
        label: "下一天",
        description: "跳转到下一天的推文页面",
        activate: () => navigateToAdjacentDay(url, date, 1),
      },
    ],
  };
}

/** 严格校验年月日，避免 Date 自动把 2 月 30 日归一化成其他日期。 */
function parseEndGfwDate(url: URL): EndGfwDate | null {
  const year = Number(url.searchParams.get("year"));
  const month = Number(url.searchParams.get("month"));
  const day = Number(url.searchParams.get("day"));
  if (![year, month, day].every(Number.isInteger)) {
    return null;
  }

  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year &&
    date.getUTCMonth() + 1 === month &&
    date.getUTCDate() === day
    ? { year, month, day }
    : null;
}

/** 保留 id 等其他查询参数，只替换日期，并正确处理跨月、跨年和闰年。 */
function navigateToAdjacentDay(
  currentUrl: URL,
  currentDate: EndGfwDate,
  offset: -1 | 1,
): void {
  const date = new Date(
    Date.UTC(currentDate.year, currentDate.month - 1, currentDate.day),
  );
  date.setUTCDate(date.getUTCDate() + offset);
  const targetUrl = new URL(currentUrl.href);
  targetUrl.searchParams.set("year", String(date.getUTCFullYear()));
  targetUrl.searchParams.set(
    "month",
    String(date.getUTCMonth() + 1).padStart(2, "0"),
  );
  targetUrl.searchParams.set("day", String(date.getUTCDate()).padStart(2, "0"));
  window.location.assign(targetUrl.href);
}

/** 优先当前朗读段落所属 article；未播放时选择离视口中心最近的可见推文。 */
async function copyCurrentTweetId(
  context: SiteIntegrationContext,
): Promise<void> {
  const currentArticle = context
    .getCurrentTextElement()
    ?.closest<HTMLElement>(END_GFW_TWEET_SELECTOR);
  const article = currentArticle ?? findNearestVisibleTweet();
  const tweetId = article?.id.trim() ?? "";
  if (!/^\d+$/u.test(tweetId)) {
    throw new Error("当前页面没有可提取的推文 ID。");
  }
  await writeClipboardText(tweetId);
}

function findNearestVisibleTweet(): HTMLElement | null {
  const viewportCenter = (window.visualViewport?.height ?? window.innerHeight) / 2;
  let nearestArticle: HTMLElement | null = null;
  let nearestDistance = Number.POSITIVE_INFINITY;
  const articles = Array.from(
    document.querySelectorAll<HTMLElement>(END_GFW_TWEET_SELECTOR),
  );
  for (const article of articles) {
    const rect = article.getBoundingClientRect();
    if (rect.bottom <= 0 || rect.top >= window.innerHeight) {
      continue;
    }
    const distance = Math.abs(rect.top + rect.height / 2 - viewportCenter);
    if (distance < nearestDistance) {
      nearestArticle = article;
      nearestDistance = distance;
    }
  }
  return nearestArticle;
}

/** Clipboard API 失败时使用用户手势下的 DOM 复制回退，不新增 clipboardWrite 权限。 */
async function writeClipboardText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    return;
  } catch {
    const input = document.createElement("textarea");
    input.value = text;
    input.readOnly = true;
    Object.assign(input.style, {
      position: "fixed",
      left: "-10000px",
      top: "0",
    });
    document.documentElement.append(input);
    input.select();
    const copied = document.execCommand("copy");
    input.remove();
    if (!copied) {
      throw new Error("复制推文 ID 失败，请检查浏览器剪贴板权限。");
    }
  }
}

function createSiteToolError(code: string, error: unknown): ExtensionError {
  return {
    code,
    message: error instanceof Error ? error.message : String(error),
    source: "content",
    recoverable: true,
  };
}
