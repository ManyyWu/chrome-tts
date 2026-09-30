import type { ExtensionError } from "../../shared/models";
import type { ExtensionRequest, ExtensionResponse } from "../../shared/messages";
import { isEndGfwTweetTime } from "../../shared/messages";
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

const END_GFW_TWEET_SELECTOR = "main article";
const X_STATUS_LINK_SELECTOR = 'a[href*="/status/"]';

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

/** 工具仅在具有合法 date 参数的 tweets 打印页面启用。 */
function createTweetPageToolPanel(
  url: URL,
  context: SiteIntegrationContext,
): SiteToolPanelConfig | null {
  const date = parseEndGfwDate(url);
  if (
    url.pathname !== "/tweets" ||
    url.searchParams.get("view") !== "print" ||
    !date
  ) {
    return null;
  }

  return {
    title: "End GFW 工具",
    actions: [
      {
        id: "push-tweet",
        label: "推送至Discord",
        description: "将当前推文时间、ID 和原始链接发送到 Discord",
        activate: () => {
          void pushCurrentTweet(context).catch((error: unknown) => {
            context.reportError({
              ...createSiteToolError("PUSH_TWEET_FAILED", error),
              requiresConfirmation: true,
            });
          });
        },
      },
      {
        id: "copy-tweet-id",
        label: "复制推文 ID",
        description: "复制当前播放或当前可见推文链接中的 ID",
        activate: () => {
          void copyCurrentTweetId(context).catch((error: unknown) => {
            context.reportError(createSiteToolError("COPY_TWEET_ID_FAILED", error));
          });
        },
      },
      {
        id: "configure-tweet-webhook",
        label: "设置 Webhook",
        description: "保存推文推送的 Discord Webhook，留空保存可清除",
        activate: () => {
          void configureTweetWebhook(context).catch((error: unknown) => {
            context.reportError(createSiteToolError("SAVE_WEBHOOK_FAILED", error));
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

/** 严格解析 YYYY-MM-DD，避免 Date 自动把 2 月 30 日归一化成其他日期。 */
function parseEndGfwDate(url: URL): EndGfwDate | null {
  const rawDate = url.searchParams.get("date") ?? "";
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(rawDate);
  if (!match) {
    return null;
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);

  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year &&
    date.getUTCMonth() + 1 === month &&
    date.getUTCDate() === day
    ? { year, month, day }
    : null;
}

/** 保留 view 等其他查询参数，只替换 date，并正确处理跨月、跨年和闰年。 */
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
  const nextDate = [
    String(date.getUTCFullYear()).padStart(4, "0"),
    String(date.getUTCMonth() + 1).padStart(2, "0"),
    String(date.getUTCDate()).padStart(2, "0"),
  ].join("-");
  targetUrl.searchParams.set("date", nextDate);
  window.location.assign(targetUrl.href);
}

/** 优先当前朗读段落所属 article；未播放时选择离视口中心最近的可见推文。 */
async function copyCurrentTweetId(
  context: SiteIntegrationContext,
): Promise<void> {
  await writeClipboardText(getCurrentTweet(context).tweetId);
}

/** 打开时读取最新配置并回填；取消不更改，空值清除，不在日志中输出链接。 */
async function configureTweetWebhook(context: SiteIntegrationContext): Promise<void> {
  const current = await sendWebhookRequest({ type: "end-gfw:get-webhook" });
  const url = window.prompt("请输入推文推送的 Discord Webhook。留空并确定可清除；取消保留原配置。", current.webhookUrl ?? "");
  if (url === null) return;
  await sendWebhookRequest({ type: "end-gfw:save-webhook", url: url.trim() });
  context.showNotice(url.trim() ? "Webhook 已保存，浏览器重启后仍有效。" : "Webhook 已清除。");
}

/** 使用与复制按钮相同的文章定位，在点击时确定 ID 和原始链接。 */
async function pushCurrentTweet(context: SiteIntegrationContext): Promise<void> {
  const tweet = getCurrentTweet(context);
  if (!tweet.time) throw new Error("当前推文卡片中没有有效时间，无法推送。");
  await sendWebhookRequest({ type: "end-gfw:push-tweet", ...tweet, time: tweet.time });
  context.showNotice(`推送成功，ID：${tweet.tweetId}`);
}

/** 将后台的安全错误信息交给现有页面错误提示，不输出请求内容或 Webhook。 */
async function sendWebhookRequest(request: ExtensionRequest): Promise<Extract<ExtensionResponse, { ok: true }>> {
  let response: ExtensionResponse;
  try {
    response = await chrome.runtime.sendMessage(request) as ExtensionResponse;
  } catch {
    throw new Error("无法连接扩展后台，请重新加载扩展并刷新页面。");
  }
  if (!response?.ok) throw new Error(response?.error ?? "推文推送操作失败。");
  return response;
}

/**
 * 新版页面不再把推文 ID 放在 article.id 中，因此从文章内的 X status 链接提取。
 * “查看原文”对应当前推文，优先级高于“查看引用原文”，避免复制到被引用推文的 ID。
 */
function getCurrentTweet(context: SiteIntegrationContext): { tweetId: string; url: string; time: string | null } {
  const currentArticle = context
    .getCurrentTextElement()
    ?.closest<HTMLElement>(END_GFW_TWEET_SELECTOR);
  const article = currentArticle ?? findNearestVisibleTweet();
  if (!article) {
    throw new Error("当前页面没有可识别的推文。");
  }

  // 只读取同一卡片顶部元数据中的时间，避免误用正文日期、浏览量或其他卡片时间。
  // 缺失时间只阻止推送，复制 ID 功能仍按原有规则工作。
  const time = Array.from(article.querySelectorAll(":scope > .item-meta span"))
    .map((element) => element.textContent?.trim() ?? "")
    .find(isEndGfwTweetTime) ?? null;

  const links = Array.from(
    article.querySelectorAll<HTMLAnchorElement>(X_STATUS_LINK_SELECTOR),
  );
  const primaryLink = links.find(
    (link) => link.textContent?.replace(/\s+/gu, "") === "查看原文",
  );
  const orderedLinks = primaryLink
    ? [primaryLink, ...links.filter((link) => link !== primaryLink)]
    : links;

  for (const link of orderedLinks) {
    const tweetId = extractTweetIdFromStatusLink(link);
    if (tweetId) {
      return { tweetId, url: link.href, time };
    }
  }

  throw new Error("当前推文没有可提取 ID 的 X 链接。");
}

/** 只接受 x.com 的 status 链接，避免从页面中的无关链接提取数字。 */
function extractTweetIdFromStatusLink(link: HTMLAnchorElement): string | null {
  try {
    const url = new URL(link.href, window.location.href);
    const hostname = url.hostname.toLowerCase();
    if (hostname !== "x.com" && hostname !== "www.x.com") {
      return null;
    }
    return /\/status\/(\d+)(?:\/|$)/u.exec(url.pathname)?.[1] ?? null;
  } catch {
    return null;
  }
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
