import type { ExtensionRequest } from "../shared/messages";

const STORAGE_KEY = "endGfwDiscordWebhook";
let sending = false;

/** 只允许 Discord HTTPS Webhook，错误信息不包含用户填写的凭据。 */
function parseWebhook(value: string): URL {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error("请输入有效的 Discord Webhook 链接。"); }
  if (url.origin !== "https://discord.com" || url.username || url.password ||
      !/^\/api\/webhooks\/\d+\/[A-Za-z0-9_-]+$/u.test(url.pathname)) {
    throw new Error("请输入有效的 Discord Webhook 链接。");
  }
  url.search = "";
  url.hash = "";
  return url;
}

/** 后台负责持久化和跨域发送，推文配置与打包发布通知相互独立。 */
export async function handleEndGfwWebhook(
  request: Extract<ExtensionRequest, { type: "end-gfw:get-webhook" | "end-gfw:save-webhook" | "end-gfw:push-tweet" }>,
  sender: chrome.runtime.MessageSender,
): Promise<string | void> {
  const page = new URL(sender.url ?? "about:blank");
  if (sender.id !== chrome.runtime.id ||
      !["https://end-gfw.com", "https://v1.end-gfw.com"].includes(page.origin) ||
      page.pathname !== "/tweet-page") {
    throw new Error("此功能仅支持 End GFW 推文页面。");
  }
  if (request.type === "end-gfw:get-webhook") {
    const stored = await chrome.storage.local.get(STORAGE_KEY);
    return typeof stored[STORAGE_KEY] === "string" ? stored[STORAGE_KEY] : "";
  }
  if (request.type === "end-gfw:save-webhook") {
    if (!request.url.trim()) await chrome.storage.local.remove(STORAGE_KEY);
    else await chrome.storage.local.set({ [STORAGE_KEY]: parseWebhook(request.url.trim()).href });
    return;
  }
  // 校验卡片 ID 和链接一致，阻止无关地址和消息注入。
  let tweet: URL;
  try { tweet = new URL(request.url); } catch { throw new Error("推文原始链接无效。"); }
  const match = /^\/[^/]+\/status\/(\d+)\/?$/u.exec(tweet.pathname);
  if (tweet.protocol !== "https:" || !["x.com", "www.x.com"].includes(tweet.hostname) ||
      tweet.username || tweet.password || match?.[1] !== request.tweetId) {
    throw new Error("推文原始链接与 ID 不匹配。");
  }
  if (sending) throw new Error("正在推送，请勿重复点击。");
  sending = true;
  try {
    const stored = await chrome.storage.local.get(STORAGE_KEY);
    if (typeof stored[STORAGE_KEY] !== "string") throw new Error("请先设置推文推送 Webhook。");
    const webhook = parseWebhook(stored[STORAGE_KEY]);
    webhook.searchParams.set("wait", "true");
    let response: Response;
    try {
      response = await fetch(webhook.href, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          content: `时间：${request.time}\n推文ID：${request.tweetId}\n推文链接：${tweet.href}`,
          allowed_mentions: { parse: [] },
        }),
        redirect: "error",
        signal: AbortSignal.timeout(15000),
      });
    } catch {
      // 不回传底层异常，防止泄露凭据；不自动重试以免重复发出。
      throw new Error("推送未确认，请检查 Discord 和网络后再重试。");
    }
    if (!response.ok) throw new Error(`Discord 推送失败（HTTP ${response.status}）。`);
  } finally {
    sending = false;
  }
}
