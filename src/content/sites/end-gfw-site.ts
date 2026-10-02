import type { ExtensionError } from "../../shared/models";
import { isEndGfwTweetTime, type ExtensionRequest, type ExtensionResponse } from "../../shared/messages";
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
  // 旧站已迁移到 v1 子域名，同时保留原域名入口。
  matches: (url) => ["end-gfw.com", "v1.end-gfw.com"].includes(url.hostname),
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
        id: "push-tweet",
        label: "推送至Discord",
        description: "将当前推文时间、ID 和原始链接发送到 Discord",
        activate: () => {
          void pushCurrentTweet(context).catch((error: unknown) => {
            context.reportError({ ...createSiteToolError("PUSH_TWEET_FAILED", error), requiresConfirmation: true });
          });
        },
      },
      {
        id: "open-x-tweet",
        label: "跳转 X",
        description: "在新标签页打开当前播放或当前可见的推文",
        activate: () => {
          void openCurrentTweetOnX(context).catch((error: unknown) => {
            context.reportError(createSiteToolError("OPEN_X_TWEET_FAILED", error));
          });
        },
      },
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
  await writeClipboardText(getCurrentTweetId(context));
}

/** 请求后台创建新标签页，避免 content script 的 window.open 被网页弹窗策略拦截。 */
async function openCurrentTweetOnX(
  context: SiteIntegrationContext,
): Promise<void> {
  const response = (await chrome.runtime.sendMessage({
    type: "site:open-x-tweet",
    tweetId: getCurrentTweetId(context),
  })) as ExtensionResponse;
  if (!response.ok) {
    throw new Error(response.error ?? "无法打开 X 推文页面。");
  }
}

/** 复制、跳转和推送共享文章定位，保持当前播放优先、视口中心兜底。 */
function getCurrentTweetArticle(context: SiteIntegrationContext): HTMLElement {
  const currentArticle = context
    .getCurrentTextElement()
    ?.closest<HTMLElement>(END_GFW_TWEET_SELECTOR);
  const article = currentArticle ?? findNearestVisibleTweet();
  if (!article) throw new Error("当前页面没有可识别的推文。");
  return article;
}

function getCurrentTweetId(context: SiteIntegrationContext): string {
  const article = getCurrentTweetArticle(context);
  const tweetId = article?.id.trim() ?? "";
  if (!/^\d+$/u.test(tweetId)) {
    throw new Error("当前页面没有可提取的推文 ID。");
  }
  return tweetId;
}

/** 回填已有链接；取消不修改，空字符串保存表示清除。 */
async function configureTweetWebhook(context: SiteIntegrationContext): Promise<void> {
  const current = await sendWebhookRequest({ type: "end-gfw:get-webhook" });
  const url = window.prompt("请输入推文推送的 Discord Webhook。留空并确定可清除；取消保留原配置。", current.webhookUrl ?? "");
  if (url === null) return;
  await sendWebhookRequest({ type: "end-gfw:save-webhook", url: url.trim() });
  context.showNotice(url.trim() ? "Webhook 已保存，浏览器重启后仍有效。" : "Webhook 已清除。");
}

/** 旧页面时间来自 time[datetime]；原文链接须对应当前 ID，不能误取引用推文。 */
async function pushCurrentTweet(context: SiteIntegrationContext): Promise<void> {
  const article = getCurrentTweetArticle(context);
  const tweetId = article.id.trim();
  if (!/^\d{1,30}$/u.test(tweetId)) throw new Error("当前页面没有可提取的推文 ID。");
  const timeElement = article.querySelector("time[datetime]");
  const time = timeElement?.getAttribute("datetime")?.trim().replace("T", " ") ?? "";
  if (!isEndGfwTweetTime(time)) throw new Error("当前推文卡片中没有有效时间，无法推送。");
  let url = "";
  for (const link of Array.from(article.querySelectorAll<HTMLAnchorElement>('a[href*="/status/"]'))) {
    const target = new URL(link.href, window.location.href);
    if (target.protocol === "https:" && ["x.com", "www.x.com"].includes(target.hostname) &&
        /^\/[^/]+\/status\/(\d+)\/?$/u.exec(target.pathname)?.[1] === tweetId) {
      url = target.href;
      break;
    }
  }
  // 旧卡片可能没有原文超链接，此时由页面已有作者参数和文章 ID 还原原始地址。
  if (!url) {
    const author = new URL(window.location.href).searchParams.get("id") ?? "";
    if (!/^[A-Za-z0-9_]{1,15}$/u.test(author)) throw new Error("无法识别推文作者，无法生成原始链接。");
    url = `https://x.com/${author}/status/${tweetId}`;
  }
  await sendWebhookRequest({ type: "end-gfw:push-tweet", tweetId, url, time });
  context.showNotice(`推送成功，ID：${tweetId}`);
}

/** 消息失败仅显示安全文案，不把 Webhook 写入日志。 */
async function sendWebhookRequest(request: ExtensionRequest): Promise<Extract<ExtensionResponse, { ok: true }>> {
  let response: ExtensionResponse;
  try { response = await chrome.runtime.sendMessage(request) as ExtensionResponse; }
  catch { throw new Error("无法连接扩展后台，请重新加载扩展并刷新页面。"); }
  if (!response?.ok) throw new Error(response?.error ?? "推文推送操作失败。");
  return response;
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
