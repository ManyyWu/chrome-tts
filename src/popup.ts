import { ENABLE_ERROR_TEST_BUTTON } from "./shared/feature-flags";
import type { ExtensionRequest, ExtensionResponse } from "./shared/messages";
import type { ExtensionSettings } from "./shared/models";
import {
  loadSettings,
  SETTINGS_KEY,
  updateSettings,
} from "./shared/settings";

/** popup 必需元素缺失时立即抛错，防止 HTML 与脚本结构悄悄失配。 */
function requireElement<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) {
    throw new Error(`缺少页面元素：${selector}`);
  }
  return element;
}

const voiceSelect = requireElement<HTMLSelectElement>("#voice");
const globalEnabledInput = requireElement<HTMLInputElement>("#global-enabled");
const rateInput = requireElement<HTMLInputElement>("#rate");
const rateValue = requireElement<HTMLOutputElement>("#rate-value");
const volumeInput = requireElement<HTMLInputElement>("#volume");
const volumeValue = requireElement<HTMLOutputElement>("#volume-value");
const autoPlaySelectionInput =
  requireElement<HTMLInputElement>("#auto-play-selection");
const showSelectionJumpPromptInput = requireElement<HTMLInputElement>(
  "#show-selection-jump-prompt",
);
const playAllVisibleTextInput = requireElement<HTMLInputElement>(
  "#play-all-visible-text",
);
const errorElement = requireElement<HTMLDivElement>("#popup-error");
const testActions = requireElement<HTMLDivElement>("#test-actions");

let voices: chrome.tts.TtsVoice[] = [];
const languagePriority = ["zh-CN", "zh-TW", "en-US", "ja-JP"] as const;

/** 常用语言优先，同语言内按声音名称稳定排序。 */
function compareVoices(
  firstVoice: chrome.tts.TtsVoice,
  secondVoice: chrome.tts.TtsVoice,
): number {
  const firstLanguage = firstVoice.lang ?? "";
  const secondLanguage = secondVoice.lang ?? "";
  const firstIndex = languagePriority.indexOf(
    firstLanguage as (typeof languagePriority)[number],
  );
  const secondIndex = languagePriority.indexOf(
    secondLanguage as (typeof languagePriority)[number],
  );
  const priorityDifference =
    (firstIndex < 0 ? languagePriority.length : firstIndex) -
    (secondIndex < 0 ? languagePriority.length : secondIndex);

  return (
    priorityDifference ||
    firstLanguage.localeCompare(secondLanguage) ||
    (firstVoice.voiceName ?? "").localeCompare(secondVoice.voiceName ?? "")
  );
}

/** 没有有效持久化声音时，优先选择本地中文声音。 */
function findPreferredVoiceIndex(
  availableVoices: readonly chrome.tts.TtsVoice[],
): number {
  const priorities = [
    (voice: chrome.tts.TtsVoice) =>
      voice.remote !== true && voice.lang === "zh-CN",
    (voice: chrome.tts.TtsVoice) =>
      voice.remote !== true && voice.lang === "zh-TW",
    (voice: chrome.tts.TtsVoice) =>
      voice.remote !== true && voice.lang?.startsWith("zh") === true,
  ];

  for (const matches of priorities) {
    const index = availableVoices.findIndex(matches);
    if (index >= 0) {
      return index;
    }
  }
  return availableVoices.length > 0 ? 0 : -1;
}

/** 先精确匹配声音及引擎，再回退到同名声音和默认声音。 */
function findStoredVoiceIndex(
  availableVoices: readonly chrome.tts.TtsVoice[],
  settings: ExtensionSettings,
): number {
  const exactIndex = availableVoices.findIndex(
    (voice) =>
      voice.voiceName === settings.voiceName &&
      (voice.extensionId ?? null) === settings.voiceExtensionId,
  );
  if (exactIndex >= 0) {
    return exactIndex;
  }

  const sameNameIndex = availableVoices.findIndex(
    (voice) => voice.voiceName === settings.voiceName,
  );
  return sameNameIndex >= 0
    ? sameNameIndex
    : findPreferredVoiceIndex(availableVoices);
}

/** 读取声音并恢复选择；已删除的声音会降级到当前可用默认项。 */
async function loadVoices(): Promise<void> {
  voices = [...(await chrome.tts.getVoices())].sort(compareVoices);
  voiceSelect.replaceChildren();
  if (voices.length === 0) {
    throw new Error("Chrome 没有返回可用声音。");
  }

  const languageGroups = new Map<string, HTMLOptGroupElement>();
  for (const [index, voice] of voices.entries()) {
    const language = voice.lang ?? "未知语言";
    let group = languageGroups.get(language);
    if (!group) {
      group = document.createElement("optgroup");
      group.label = language;
      languageGroups.set(language, group);
      voiceSelect.append(group);
    }

    const option = document.createElement("option");
    option.value = String(index);
    option.textContent =
      `${voice.lang === "zh-CN" ? "★ " : ""}` +
      `${voice.remote ? "远程 | " : "本地 | "}` +
      `${voice.voiceName ?? "未命名声音"}`;
    group.append(option);
  }

  const settings = await loadSettings();
  const selectedIndex = findStoredVoiceIndex(voices, settings);
  if (selectedIndex >= 0) {
    voiceSelect.value = String(selectedIndex);
    await saveSelectedVoice(selectedIndex);
  }
}

/** 保存指定索引的完整声音标识，确保同名引擎仍能区分。 */
async function saveSelectedVoice(index: number): Promise<void> {
  const voice = voices[index];
  if (!voice) {
    throw new Error("选中的声音已经不可用。");
  }

  await updateSettings({
    voiceName: voice.voiceName ?? null,
    voiceExtensionId: voice.extensionId ?? null,
    lang: voice.lang ?? null,
  });
}

/** 把设置同步到表单，不触发 change 事件或重复写入 storage。 */
function renderSettings(settings: ExtensionSettings): void {
  globalEnabledInput.checked = settings.globalEnabled;
  rateInput.value = String(settings.rate);
  rateValue.textContent = `${formatRate(settings.rate)}×`;
  volumeInput.value = String(settings.volume);
  volumeValue.textContent = `${Math.round(settings.volume * 100)}%`;
  autoPlaySelectionInput.checked = settings.autoPlaySelection;
  showSelectionJumpPromptInput.checked = settings.showSelectionJumpPrompt;
  playAllVisibleTextInput.checked = settings.playAllVisibleText;
}

globalEnabledInput.addEventListener("change", () => {
  clearPopupError();
  void updateSettings({ globalEnabled: globalEnabledInput.checked }).catch(
    showPopupError,
  );
});

/** popup 自身错误只在实际发生时显示，不保留常驻 statusElement。 */
function showPopupError(error: unknown): void {
  errorElement.textContent = error instanceof Error ? error.message : String(error);
  errorElement.hidden = false;
}

function clearPopupError(): void {
  errorElement.hidden = true;
  errorElement.textContent = "";
}

voiceSelect.addEventListener("change", () => {
  clearPopupError();
  void saveSelectedVoice(Number(voiceSelect.value)).catch(showPopupError);
});

rateInput.addEventListener("input", () => {
  rateValue.textContent = `${formatRate(Number(rateInput.value))}×`;
});
rateInput.addEventListener("change", () => {
  clearPopupError();
  void updateSettings({ rate: Number(rateInput.value) }).catch(showPopupError);
});

volumeInput.addEventListener("input", () => {
  volumeValue.textContent = `${Math.round(Number(volumeInput.value) * 100)}%`;
});
volumeInput.addEventListener("change", () => {
  clearPopupError();
  void updateSettings({ volume: Number(volumeInput.value) }).catch(showPopupError);
});

autoPlaySelectionInput.addEventListener("change", () => {
  clearPopupError();
  void updateSettings({
    autoPlaySelection: autoPlaySelectionInput.checked,
  }).catch(showPopupError);
});

showSelectionJumpPromptInput.addEventListener("change", () => {
  clearPopupError();
  void updateSettings({
    showSelectionJumpPrompt: showSelectionJumpPromptInput.checked,
  }).catch(showPopupError);
});

playAllVisibleTextInput.addEventListener("change", () => {
  clearPopupError();
  void updateSettings({
    playAllVisibleText: playAllVisibleTextInput.checked,
  }).catch(showPopupError);
});

chrome.tts.onVoicesChanged.addListener(() => {
  void loadVoices().catch(showPopupError);
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === "local" && SETTINGS_KEY in changes) {
    void loadSettings().then(renderSettings).catch(showPopupError);
  }
});

if (ENABLE_ERROR_TEST_BUTTON) {
  const testButton = document.createElement("button");
  testButton.type = "button";
  testButton.className = "test-button";
  testButton.textContent = "触发测试错误";
  testButton.addEventListener("click", () => {
    clearPopupError();
    const request: ExtensionRequest = { type: "test:trigger-error" };
    void chrome.runtime
      .sendMessage(request)
      .then((response: ExtensionResponse) => {
        if (!response.ok) {
          throw new Error(response.error);
        }
      })
      .catch(showPopupError);
  });
  testActions.append(testButton);
}

void Promise.all([loadSettings(), loadVoices()])
  .then(([settings]) => renderSettings(settings))
  .catch(showPopupError);

function formatRate(rate: number): string {
  return Number(rate.toFixed(2)).toString();
}
