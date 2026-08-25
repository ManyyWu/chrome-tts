"use strict";
(() => {
  // src/shared/feature-flags.ts
  var ENABLE_ERROR_TEST_BUTTON = false;

  // src/shared/settings.ts
  var SETTINGS_KEY = "extensionSettings";
  var DEFAULT_SETTINGS = {
    version: 5,
    voiceName: null,
    voiceExtensionId: null,
    lang: null,
    rate: 1,
    volume: 1,
    autoPlaySelection: false,
    showSelectionJumpPrompt: false,
    playAllVisibleText: false,
    globalEnabled: true
  };
  function clamp(value, minimum, maximum) {
    return Math.min(maximum, Math.max(minimum, value));
  }
  function isNullableString(value) {
    return value === null || typeof value === "string";
  }
  function normalizeSettings(value) {
    if (typeof value !== "object" || value === null) {
      return { ...DEFAULT_SETTINGS };
    }
    const stored = value;
    const rate = typeof stored.rate === "number" && Number.isFinite(stored.rate) ? clamp(Math.round(stored.rate * 10) / 10, 0.5, 1.5) : DEFAULT_SETTINGS.rate;
    const volume = typeof stored.volume === "number" && Number.isFinite(stored.volume) ? clamp(stored.volume, 0, 1) : DEFAULT_SETTINGS.volume;
    return {
      version: 5,
      voiceName: isNullableString(stored.voiceName) ? stored.voiceName : DEFAULT_SETTINGS.voiceName,
      voiceExtensionId: isNullableString(stored.voiceExtensionId) ? stored.voiceExtensionId : DEFAULT_SETTINGS.voiceExtensionId,
      lang: isNullableString(stored.lang) ? stored.lang : DEFAULT_SETTINGS.lang,
      rate,
      volume,
      autoPlaySelection: typeof stored.autoPlaySelection === "boolean" ? stored.autoPlaySelection : DEFAULT_SETTINGS.autoPlaySelection,
      showSelectionJumpPrompt: typeof stored.showSelectionJumpPrompt === "boolean" ? stored.showSelectionJumpPrompt : DEFAULT_SETTINGS.showSelectionJumpPrompt,
      playAllVisibleText: typeof stored.playAllVisibleText === "boolean" ? stored.playAllVisibleText : DEFAULT_SETTINGS.playAllVisibleText,
      globalEnabled: typeof stored.globalEnabled === "boolean" ? stored.globalEnabled : DEFAULT_SETTINGS.globalEnabled
    };
  }
  async function loadSettings() {
    const result = await chrome.storage.local.get(SETTINGS_KEY);
    const storedValue = result[SETTINGS_KEY];
    const settings = normalizeSettings(storedValue);
    if (JSON.stringify(storedValue) !== JSON.stringify(settings)) {
      await chrome.storage.local.set({ [SETTINGS_KEY]: settings });
    }
    return settings;
  }
  async function updateSettings(changes) {
    const current = await loadSettings();
    const settings = normalizeSettings({ ...current, ...changes, version: 5 });
    await chrome.storage.local.set({ [SETTINGS_KEY]: settings });
    return settings;
  }

  // src/settings.ts
  function requireElement(selector) {
    const element = document.querySelector(selector);
    if (!element) {
      throw new Error(`\u7F3A\u5C11\u9875\u9762\u5143\u7D20\uFF1A${selector}`);
    }
    return element;
  }
  var voiceSelect = requireElement("#voice");
  var globalEnabledInput = requireElement("#global-enabled");
  var rateInput = requireElement("#rate");
  var rateValue = requireElement("#rate-value");
  var volumeInput = requireElement("#volume");
  var volumeValue = requireElement("#volume-value");
  var autoPlaySelectionInput = requireElement("#auto-play-selection");
  var showSelectionJumpPromptInput = requireElement(
    "#show-selection-jump-prompt"
  );
  var playAllVisibleTextInput = requireElement(
    "#play-all-visible-text"
  );
  var errorElement = requireElement("#settings-error");
  var testActions = requireElement("#test-actions");
  var voices = [];
  var languagePriority = ["zh-CN", "zh-TW", "en-US", "ja-JP"];
  function compareVoices(firstVoice, secondVoice) {
    const firstLanguage = firstVoice.lang ?? "";
    const secondLanguage = secondVoice.lang ?? "";
    const firstIndex = languagePriority.indexOf(
      firstLanguage
    );
    const secondIndex = languagePriority.indexOf(
      secondLanguage
    );
    const priorityDifference = (firstIndex < 0 ? languagePriority.length : firstIndex) - (secondIndex < 0 ? languagePriority.length : secondIndex);
    return priorityDifference || firstLanguage.localeCompare(secondLanguage) || (firstVoice.voiceName ?? "").localeCompare(secondVoice.voiceName ?? "");
  }
  function findPreferredVoiceIndex(availableVoices) {
    const priorities = [
      (voice) => voice.remote !== true && voice.lang === "zh-CN",
      (voice) => voice.remote !== true && voice.lang === "zh-TW",
      (voice) => voice.remote !== true && voice.lang?.startsWith("zh") === true
    ];
    for (const matches of priorities) {
      const index = availableVoices.findIndex(matches);
      if (index >= 0) {
        return index;
      }
    }
    return availableVoices.length > 0 ? 0 : -1;
  }
  function findStoredVoiceIndex(availableVoices, settings) {
    const exactIndex = availableVoices.findIndex(
      (voice) => voice.voiceName === settings.voiceName && (voice.extensionId ?? null) === settings.voiceExtensionId
    );
    if (exactIndex >= 0) {
      return exactIndex;
    }
    const sameNameIndex = availableVoices.findIndex(
      (voice) => voice.voiceName === settings.voiceName
    );
    return sameNameIndex >= 0 ? sameNameIndex : findPreferredVoiceIndex(availableVoices);
  }
  async function loadVoices() {
    voices = [...await chrome.tts.getVoices()].sort(compareVoices);
    voiceSelect.replaceChildren();
    if (voices.length === 0) {
      const defaultVoiceOption = document.createElement("option");
      defaultVoiceOption.value = "";
      defaultVoiceOption.textContent = "\u9ED8\u8BA4\u4F7F\u7528\u672C\u5730 TTS";
      defaultVoiceOption.selected = true;
      voiceSelect.append(defaultVoiceOption);
      voiceSelect.disabled = true;
      voiceSelect.title = "\u5F53\u524D\u6D4F\u89C8\u5668\u4E0D\u63D0\u4F9B\u58F0\u97F3\u5217\u8868\uFF0C\u64AD\u653E\u65F6\u5C06\u8C03\u7528\u7CFB\u7EDF\u9ED8\u8BA4\u7684\u672C\u5730 TTS\u3002";
      return;
    }
    voiceSelect.disabled = false;
    voiceSelect.title = "";
    const languageGroups = /* @__PURE__ */ new Map();
    for (const [index, voice] of voices.entries()) {
      const language = voice.lang ?? "\u672A\u77E5\u8BED\u8A00";
      let group = languageGroups.get(language);
      if (!group) {
        group = document.createElement("optgroup");
        group.label = language;
        languageGroups.set(language, group);
        voiceSelect.append(group);
      }
      const option = document.createElement("option");
      option.value = String(index);
      option.textContent = `${voice.lang === "zh-CN" ? "\u2605 " : ""}${voice.remote ? "\u8FDC\u7A0B | " : "\u672C\u5730 | "}${voice.voiceName ?? "\u672A\u547D\u540D\u58F0\u97F3"}`;
      group.append(option);
    }
    const settings = await loadSettings();
    const selectedIndex = findStoredVoiceIndex(voices, settings);
    if (selectedIndex >= 0) {
      voiceSelect.value = String(selectedIndex);
      await saveSelectedVoice(selectedIndex);
    }
  }
  async function saveSelectedVoice(index) {
    const voice = voices[index];
    if (!voice) {
      throw new Error("\u9009\u4E2D\u7684\u58F0\u97F3\u5DF2\u7ECF\u4E0D\u53EF\u7528\u3002");
    }
    await updateSettings({
      voiceName: voice.voiceName ?? null,
      voiceExtensionId: voice.extensionId ?? null,
      lang: voice.lang ?? null
    });
  }
  function renderSettings(settings) {
    globalEnabledInput.checked = settings.globalEnabled;
    rateInput.value = String(settings.rate);
    rateValue.textContent = `${formatRate(settings.rate)}\xD7`;
    volumeInput.value = String(settings.volume);
    volumeValue.textContent = `${Math.round(settings.volume * 100)}%`;
    autoPlaySelectionInput.checked = settings.autoPlaySelection;
    showSelectionJumpPromptInput.checked = settings.showSelectionJumpPrompt;
    playAllVisibleTextInput.checked = settings.playAllVisibleText;
  }
  globalEnabledInput.addEventListener("change", () => {
    clearPopupError();
    void updateSettings({ globalEnabled: globalEnabledInput.checked }).catch(
      showPopupError
    );
  });
  function showPopupError(error) {
    errorElement.textContent = error instanceof Error ? error.message : String(error);
    errorElement.hidden = false;
  }
  function clearPopupError() {
    errorElement.hidden = true;
    errorElement.textContent = "";
  }
  voiceSelect.addEventListener("change", () => {
    clearPopupError();
    void saveSelectedVoice(Number(voiceSelect.value)).catch(showPopupError);
  });
  rateInput.addEventListener("input", () => {
    rateValue.textContent = `${formatRate(Number(rateInput.value))}\xD7`;
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
      autoPlaySelection: autoPlaySelectionInput.checked
    }).catch(showPopupError);
  });
  showSelectionJumpPromptInput.addEventListener("change", () => {
    clearPopupError();
    void updateSettings({
      showSelectionJumpPrompt: showSelectionJumpPromptInput.checked
    }).catch(showPopupError);
  });
  playAllVisibleTextInput.addEventListener("change", () => {
    clearPopupError();
    void updateSettings({
      playAllVisibleText: playAllVisibleTextInput.checked
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
    testButton.textContent = "\u89E6\u53D1\u6D4B\u8BD5\u9519\u8BEF";
    testButton.addEventListener("click", () => {
      clearPopupError();
      const request = { type: "test:trigger-error" };
      void chrome.runtime.sendMessage(request).then((response) => {
        if (!response.ok) {
          throw new Error(response.error);
        }
      }).catch(showPopupError);
    });
    testActions.append(testButton);
  }
  void Promise.all([loadSettings(), loadVoices()]).then(([settings]) => renderSettings(settings)).catch(showPopupError);
  function formatRate(rate) {
    return Number(rate.toFixed(2)).toString();
  }
})();
