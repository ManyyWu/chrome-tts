import { readFile } from "node:fs/promises";
import { basename } from "node:path";

// 只上传指定 CRX，凭据保存在被忽略的本地文件中，不进入附件或日志。
try {
  const [, , version, crxPath, credentialPath] = process.argv;
  if (!version || !crxPath || !credentialPath) throw new Error("参数缺失");
  const webhook = new URL((await readFile(credentialPath, "utf8")).trim());
  if (webhook.origin !== "https://discord.com" || webhook.username || webhook.password ||
      !/^\/api\/webhooks\/\d+\/[A-Za-z0-9_-]+$/u.test(webhook.pathname)) throw new Error("配置无效");
  webhook.searchParams.set("wait", "true");
  const form = new FormData();
  form.set("payload_json", JSON.stringify({
    content: [
      `## Chrome TTS v${version}`, "",
      `- **版本号**：\`${version}\``,
      "- **类型检查**：✅ 通过",
      "- **构建**：✅ 通过",
      `- **CRX 文件**：\`${basename(crxPath)}\`（见附件）`,
    ].join("\n"),
    allowed_mentions: { parse: [] },
  }));
  form.set("files[0]", new Blob([await readFile(crxPath)], { type: "application/x-chrome-extension" }), basename(crxPath));
  // 超时不自动重发，避免消息已经送达时造成重复上传。
  const response = await fetch(webhook, { method: "POST", body: form, redirect: "error", signal: AbortSignal.timeout(120000) });
  if (!response.ok) throw new Error("发送失败");
  console.log("Discord：Markdown 发布通知及 CRX 已发送。");
} catch {
  console.error("Discord 通知失败，请检查配置、网络和附件大小。本地发布包已保留。");
  process.exitCode = 1;
}
