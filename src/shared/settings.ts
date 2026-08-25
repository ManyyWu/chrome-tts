import type { ExtensionSettings } from "./models";

/** 导出键名，使各界面只监听本扩展设置项的 storage 变化。 */
export const SETTINGS_KEY = "extensionSettings";

/** 首次安装或存储数据不可用时采用的安全默认设置。 */
export const DEFAULT_SETTINGS: ExtensionSettings = {
  version: 3,
  voiceName: null,
  voiceExtensionId: null,
  lang: null,
  rate: 1,
  volume: 1,
  autoPlaySelection: false,
  showSelectionJumpPrompt: false,
};

/** 将数值限制在 chrome.tts 允许且本项目支持的范围内。 */
function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

/** 判断未知值是否为字符串或 null，用于校验 storage 中的可选标识。 */
function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

/**
 * 将 storage 中的未知数据收窄为当前版本设置。
 * 字段缺失或类型错误时只回退对应字段，避免一项损坏导致全部偏好丢失。
 */
function normalizeSettings(value: unknown): ExtensionSettings {
  if (typeof value !== "object" || value === null) {
    return { ...DEFAULT_SETTINGS };
  }

  const stored = value as Record<string, unknown>;
  const rate =
    typeof stored.rate === "number" && Number.isFinite(stored.rate)
      ? clamp(Math.round(stored.rate * 10) / 10, 0.5, 1.5)
      : DEFAULT_SETTINGS.rate;
  const volume =
    typeof stored.volume === "number" && Number.isFinite(stored.volume)
      ? clamp(stored.volume, 0, 1)
      : DEFAULT_SETTINGS.volume;

  return {
    version: 3,
    voiceName: isNullableString(stored.voiceName)
      ? stored.voiceName
      : DEFAULT_SETTINGS.voiceName,
    voiceExtensionId: isNullableString(stored.voiceExtensionId)
      ? stored.voiceExtensionId
      : DEFAULT_SETTINGS.voiceExtensionId,
    lang: isNullableString(stored.lang)
      ? stored.lang
      : DEFAULT_SETTINGS.lang,
    rate,
    volume,
    autoPlaySelection:
      typeof stored.autoPlaySelection === "boolean"
        ? stored.autoPlaySelection
        : DEFAULT_SETTINGS.autoPlaySelection,
    showSelectionJumpPrompt:
      typeof stored.showSelectionJumpPrompt === "boolean"
        ? stored.showSelectionJumpPrompt
        : DEFAULT_SETTINGS.showSelectionJumpPrompt,
  };
}

/** 读取并校验持久化设置；规范化后的结构会覆盖旧版或损坏数据。 */
export async function loadSettings(): Promise<ExtensionSettings> {
  const result = await chrome.storage.local.get(SETTINGS_KEY);
  const storedValue: unknown = result[SETTINGS_KEY];
  const settings = normalizeSettings(storedValue);

  // 只在首次创建、旧版迁移或损坏修复时写回，避免监听器读取时产生通知循环。
  if (JSON.stringify(storedValue) !== JSON.stringify(settings)) {
    await chrome.storage.local.set({ [SETTINGS_KEY]: settings });
  }
  return settings;
}

/** 合并部分更新，并保证写回 storage 的始终是完整、合法的当前版本结构。 */
export async function updateSettings(
  changes: Partial<Omit<ExtensionSettings, "version">>,
): Promise<ExtensionSettings> {
  const current = await loadSettings();
  const settings = normalizeSettings({ ...current, ...changes, version: 3 });

  await chrome.storage.local.set({ [SETTINGS_KEY]: settings });
  return settings;
}
