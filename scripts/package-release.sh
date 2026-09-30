#!/bin/bash

set -euo pipefail

# 统一完成检查、构建、CRX 签名和本地加载目录同步，避免手工复制遗漏文件。
PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$PROJECT_ROOT"

VERSION="$(node -p "require('./package.json').version")"
MANIFEST_VERSION="$(node -p "require('./manifest.json').version")"
if [[ "$VERSION" != "$MANIFEST_VERSION" ]]; then
  echo "版本不一致：package.json=$VERSION，manifest.json=$MANIFEST_VERSION" >&2
  exit 1
fi

CHROME_BINARY="${CHROME_TTS_CHROME_BINARY:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}"
SIGNING_KEY="${CHROME_TTS_SIGNING_KEY:-$PROJECT_ROOT/release/chrome-tts-1.5.0/chrome-tts.pem}"
DEPLOY_ROOT="${CHROME_TTS_DEPLOY_ROOT:-/Volumes/Softwares/Applications/Chrome本地插件/chrome-tts}"
RELEASE_ROOT="$PROJECT_ROOT/release/chrome-tts-$VERSION"
UNPACKED_ROOT="$RELEASE_ROOT/unpacked"
CRX_PATH="$RELEASE_ROOT/chrome-tts-$VERSION.crx"

if [[ ! -x "$CHROME_BINARY" ]]; then
  echo "找不到可执行的 Chrome：$CHROME_BINARY" >&2
  exit 1
fi
if [[ ! -f "$SIGNING_KEY" ]]; then
  echo "找不到签名密钥：$SIGNING_KEY" >&2
  exit 1
fi

npm run check
npm run build

mkdir -p \
  "$UNPACKED_ROOT/assets/icons" \
  "$UNPACKED_ROOT/dist/background" \
  "$UNPACKED_ROOT/dist/content"
cp manifest.json "$UNPACKED_ROOT/manifest.json"
cp settings.html "$UNPACKED_ROOT/settings.html"
cp dist/settings.js "$UNPACKED_ROOT/dist/settings.js"
cp dist/background/service-worker.js "$UNPACKED_ROOT/dist/background/service-worker.js"
cp dist/content/content-script.js "$UNPACKED_ROOT/dist/content/content-script.js"
cp -R assets/icons/. "$UNPACKED_ROOT/assets/icons/"
if [[ "$SIGNING_KEY" != "$RELEASE_ROOT/chrome-tts.pem" ]]; then
  cp "$SIGNING_KEY" "$RELEASE_ROOT/chrome-tts.pem"
fi

# Chrome 固定输出 unpacked.crx；仅清理本版本的两个明确产物，支持同版本重新打包。
rm -f "$RELEASE_ROOT/unpacked.crx" "$CRX_PATH"
"$CHROME_BINARY" \
  --pack-extension="$UNPACKED_ROOT" \
  --pack-extension-key="$RELEASE_ROOT/chrome-tts.pem"
mv "$RELEASE_ROOT/unpacked.crx" "$CRX_PATH"

# 同步 Chrome 直接加载的解压文件；历史 CRX 和用户放入目标目录的其他文件保持不动。
mkdir -p \
  "$DEPLOY_ROOT/assets/icons" \
  "$DEPLOY_ROOT/dist/background" \
  "$DEPLOY_ROOT/dist/content"
cp "$UNPACKED_ROOT/manifest.json" "$DEPLOY_ROOT/manifest.json"
cp "$UNPACKED_ROOT/settings.html" "$DEPLOY_ROOT/settings.html"
cp "$UNPACKED_ROOT/dist/settings.js" "$DEPLOY_ROOT/dist/settings.js"
cp "$UNPACKED_ROOT/dist/background/service-worker.js" "$DEPLOY_ROOT/dist/background/service-worker.js"
cp "$UNPACKED_ROOT/dist/content/content-script.js" "$DEPLOY_ROOT/dist/content/content-script.js"
cp -R "$UNPACKED_ROOT/assets/icons/." "$DEPLOY_ROOT/assets/icons/"
cp "$CRX_PATH" "$DEPLOY_ROOT/chrome-tts-$VERSION.crx"

echo "发布包：$CRX_PATH"
echo "本地插件目录：$DEPLOY_ROOT"

# 只有上述检查、构建、打包和本地同步全部成功后才发送成功通知。
# 通知失败返回非零退出码，但保留已经生成和同步的发布文件。
node scripts/notify-discord.mjs "$VERSION" "$CRX_PATH" \
  "${CHROME_TTS_DISCORD_CONFIG:-$PROJECT_ROOT/release/discord-webhook.pem}"
