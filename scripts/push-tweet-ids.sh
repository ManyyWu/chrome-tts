#!/bin/bash
set -euo pipefail

# 默认读取项目根目录 in.txt；也可传入其他文件。dry-run 不读取凭据、不发送请求。
PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
INPUT_PATH="${1:-$PROJECT_ROOT/in.txt}"
MODE="${2:-send}"
node --input-type=module - "$INPUT_PATH" "$PROJECT_ROOT/release/tweet-webhook.pem" "$MODE" <<'JS'
import { readFile } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';

const [, , inputPath, credentialPath, mode] = process.argv;
// 记录当前处理的 ID，让未预期异常也能定位到具体推文，而不泄露底层异常内容。
let currentId = null;
try {
  if (!['send', '--dry-run'].includes(mode)) throw new Error('第二个参数仅支持 --dry-run。');
  let input;
  try { input = await readFile(inputPath, 'utf8'); }
  catch { throw new Error('无法读取输入文件，请创建 in.txt，每行填写一个推文 ID。'); }

  // ID 始终作为字符串处理，避免长整数超过 JavaScript 的安全整数范围。
  const ids = new Set();
  let duplicates = 0;
  for (const [index, line] of input.split(/\r?\n/u).entries()) {
    const id = line.trim();
    if (!id) continue;
    if (!/^\d{1,30}$/u.test(id)) throw new Error(`第 ${index + 1} 行不是有效的纯数字 ID；尚未发送。`);
    if (ids.has(id)) duplicates++;
    ids.add(id);
  }
  console.log(`有效 ID：${ids.size}，已去重：${duplicates}。`);
  if (!ids.size || mode === '--dry-run') {
    if (mode === '--dry-run') console.log('预检查通过，未发送。');
  } else {
    const webhook = new URL((await readFile(credentialPath, 'utf8')).trim());
    if (webhook.origin !== 'https://discord.com' || webhook.username || webhook.password ||
        !/^\/api\/webhooks\/\d+\/[A-Za-z0-9_-]+$/u.test(webhook.pathname)) {
      throw new Error('Webhook 配置无效。');
    }
    webhook.search = '?wait=true';
    webhook.hash = '';
    let completed = 0;
    for (const id of ids) {
      currentId = id;
      let sent = false;
      for (let attempt = 0; attempt < 6; attempt++) {
        let response;
        try {
          response = await fetch(webhook, {
            method: 'POST', redirect: 'error', signal: AbortSignal.timeout(30000),
            headers: { 'Content-Type': 'application/json' },
            // 输入只有 ID，使用 X 的 ID 跳转入口；不伪造作者路径或推文发布时间。
            body: JSON.stringify({ content: `推文ID：${id}\n推文链接：https://x.com/i/status/${id}`, allowed_mentions: { parse: [] } }),
          });
        } catch {
          throw new Error(`ID ${id} 的发送结果未确认，已停止；请检查频道后再重试，避免重复发送。`);
        }
        if (response.status === 429) {
          const body = await response.json().catch(() => ({}));
          const delay = Math.max(3, Number(body.retry_after) || 0,
            Number(response.headers.get('retry-after')) || 0,
            Number(response.headers.get('x-ratelimit-reset-after')) || 0);
          console.log(`ID ${id}：Discord 限频，等待 ${Math.ceil(delay + 1)} 秒后重试。`);
          await sleep((delay + 1) * 1000);
          continue;
        }
        if (!response.ok) throw new Error(`ID ${id} 发送失败（HTTP ${response.status}），已停止。`);
        // 等待确认响应完成，再串行发送下一条；额外遵循服务端返回的桶重置时间。
        try {
          await response.arrayBuffer();
        } catch {
          throw new Error(`ID ${id} 读取响应失败，发送结果未确认，已停止；请检查频道后再重试，避免重复发送。`);
        }
        completed++;
        sent = true;
        console.log(`[${completed}/${ids.size}] 已发送 ${id}`);
        const resetDelay = response.headers.get('x-ratelimit-remaining') === '0'
          ? (Number(response.headers.get('x-ratelimit-reset-after')) || 0) + 1 : 0;
        if (completed < ids.size) await sleep(Math.max(3, resetDelay) * 1000);
        break;
      }
      if (!sent) throw new Error(`ID ${id} 连续限频，已停止。`);
    }
    console.log(`完成：发送 ${completed} 条。`);
  }
} catch (error) {
  // 不输出请求 URL、响应正文或底层异常，防止泄露 Webhook 令牌。
  const message = error instanceof Error ? error.message : '';
  const safeMessage = /^(第 |无法读取|第二个|Webhook 配置|ID )/u.test(message)
    ? message : '执行失败，请检查本地配置和网络。';
  console.error(currentId && !safeMessage.startsWith(`ID ${currentId} `)
    ? `ID ${currentId}：${safeMessage}` : safeMessage);
  process.exitCode = 1;
}
JS
