#!/bin/bash
set -euo pipefail

# 检查、构建、签名、同步依次执行；仅在全部成功后发送发布通知。
PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$PROJECT_ROOT"
VERSION="$(node -p "require('./package.json').version")"
MANIFEST_VERSION="$(node -p "require('./manifest.json').version")"
if [[ "$VERSION" != "$MANIFEST_VERSION" ]]; then
  echo "package.json 与 manifest.json 版本不一致" >&2
  exit 1
fi
CHROME_BINARY="${CHROME_TTS_CHROME_BINARY:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}"
SIGNING_KEY="${CHROME_TTS_SIGNING_KEY:-$PROJECT_ROOT/release/chrome-tts-1.5.0/chrome-tts.pem}"
DEPLOY_ROOT="${CHROME_TTS_DEPLOY_ROOT:-/Volumes/Softwares/Applications/Chrome本地插件/chrome-tts}"
RELEASE_ROOT="$PROJECT_ROOT/release/chrome-tts-$VERSION"
UNPACKED_ROOT="$RELEASE_ROOT/unpacked"
CRX_PATH="$RELEASE_ROOT/chrome-tts-$VERSION.crx"
if [[ ! -x "$CHROME_BINARY" || ! -f "$SIGNING_KEY" ]]; then
  echo "Chrome 或既有签名密钥不可用。" >&2
  exit 1
fi
npm run check
npm run build
mkdir -p "$UNPACKED_ROOT/assets/icons" "$UNPACKED_ROOT/dist/background" "$UNPACKED_ROOT/dist/content"
cp manifest.json settings.html "$UNPACKED_ROOT/"
cp dist/settings.js "$UNPACKED_ROOT/dist/settings.js"
cp dist/background/service-worker.js "$UNPACKED_ROOT/dist/background/service-worker.js"
cp dist/content/content-script.js "$UNPACKED_ROOT/dist/content/content-script.js"
cp -R assets/icons/. "$UNPACKED_ROOT/assets/icons/"
# Chrome 使用固定的中间文件名，清理范围仅限本次版本产物。
rm -f "$RELEASE_ROOT/unpacked.crx"
"$CHROME_BINARY" --pack-extension="$UNPACKED_ROOT" --pack-extension-key="$SIGNING_KEY"
mv -f "$RELEASE_ROOT/unpacked.crx" "$CRX_PATH"
mkdir -p "$DEPLOY_ROOT/assets/icons" "$DEPLOY_ROOT/dist/background" "$DEPLOY_ROOT/dist/content"
cp "$UNPACKED_ROOT/manifest.json" "$UNPACKED_ROOT/settings.html" "$DEPLOY_ROOT/"
cp "$UNPACKED_ROOT/dist/settings.js" "$DEPLOY_ROOT/dist/settings.js"
cp "$UNPACKED_ROOT/dist/background/service-worker.js" "$DEPLOY_ROOT/dist/background/service-worker.js"
cp "$UNPACKED_ROOT/dist/content/content-script.js" "$DEPLOY_ROOT/dist/content/content-script.js"
cp -R "$UNPACKED_ROOT/assets/icons/." "$DEPLOY_ROOT/assets/icons/"
cp "$CRX_PATH" "$DEPLOY_ROOT/chrome-tts-$VERSION.crx"
echo "发布包：$CRX_PATH"
echo "本地插件目录：$DEPLOY_ROOT"
node scripts/notify-discord.mjs "$VERSION" "$CRX_PATH" "${CHROME_TTS_DISCORD_CONFIG:-$PROJECT_ROOT/release/discord-webhook.pem}"
