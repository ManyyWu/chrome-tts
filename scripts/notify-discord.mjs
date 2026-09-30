import { readFile } from "node:fs/promises";
import { basename, resolve } from "node:path";

// 凭据沿用项目已忽略的 release/**/*.pem 存储范围；该文件是 URL 文本，不是签名密钥。
// 仅上传明确指定的 CRX，凭据和签名密钥都不会进入附件。
export async function notifyDiscord(version, crxPath, credentialPath, send = fetch) {
  const webhook = new URL((await readFile(credentialPath, "utf8")).trim());
  if (webhook.protocol !== "https:" || webhook.hostname !== "discord.com" ||
      !/^\/api\/webhooks\/\d+\/[^/]+$/u.test(webhook.pathname)) {
    throw new Error("Webhook 配置无效");
  }
  webhook.searchParams.set("wait", "true");
  const form = new FormData();
  form.set("payload_json", JSON.stringify({
    // 直接发送 Discord 可渲染的 Markdown，不包裹代码块。
    content: [
      `## Chrome TTS v${version}`,
      "",
      `- **版本号**：\`${version}\``,
      "- **类型检查**：✅ 通过",
      "- **构建**：✅ 通过",
      `- **CRX 文件**：\`${basename(crxPath)}\`（见附件）`,
    ].join("\n"),
    allowed_mentions: { parse: [] },
  }));
  form.set("files[0]", new Blob([await readFile(crxPath)], {
    type: "application/x-chrome-extension",
  }), basename(crxPath));
  // 不自动重试，避免超时后重复发出附件；错误输出不包含 URL 或服务器响应正文。
  const response = await send(webhook, {
    method: "POST", body: form, signal: AbortSignal.timeout(120000),
  });
  if (!response.ok) throw new Error(`Discord HTTP ${response.status}`);
}

if (process.argv[1] && resolve(process.argv[1]) === new URL(import.meta.url).pathname) {
  const [, , version, crxPath, credentialPath] = process.argv;
  try {
    if (!version || !crxPath || !credentialPath) throw new Error("参数缺失");
    await notifyDiscord(version, crxPath, credentialPath);
    console.log("Discord：版本号、CRX、类型检查和构建结果已发送。");
  } catch {
    console.error("Discord 通知失败：请检查凭据、网络及附件大小。本地发布包已保留。");
    process.exitCode = 1;
  }
}
