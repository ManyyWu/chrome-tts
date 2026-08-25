"use strict";
(() => {
  // src/popup.ts
  function requireElement(selector) {
    const element = document.querySelector(selector);
    if (!element) {
      throw new Error(`\u7F3A\u5C11\u9875\u9762\u5143\u7D20\uFF1A${selector}`);
    }
    return element;
  }
  var voiceSelect = requireElement("#voice");
  var textInput = requireElement("#text");
  var rateInput = requireElement("#rate");
  var statusElement = requireElement("#status");
  var speakButton = requireElement("#speak");
  var stopButton = requireElement("#stop");
  var voices = [];
  var languagePriority = ["zh-CN", "zh-TW", "en-US", "ja-JP"];
  function getErrorMessage(error) {
    return error instanceof Error ? error.message : String(error);
  }
  function compareVoices(firstVoice, secondVoice) {
    const firstLanguage = firstVoice.lang ?? "";
    const secondLanguage = secondVoice.lang ?? "";
    const firstPriority = languagePriority.indexOf(
      firstLanguage
    );
    const secondPriority = languagePriority.indexOf(
      secondLanguage
    );
    const normalizedFirstPriority = firstPriority >= 0 ? firstPriority : languagePriority.length;
    const normalizedSecondPriority = secondPriority >= 0 ? secondPriority : languagePriority.length;
    const priorityDifference = normalizedFirstPriority - normalizedSecondPriority;
    if (priorityDifference !== 0) {
      return priorityDifference;
    }
    const languageDifference = firstLanguage.localeCompare(secondLanguage);
    if (languageDifference !== 0) {
      return languageDifference;
    }
    return (firstVoice.voiceName ?? "").localeCompare(
      secondVoice.voiceName ?? ""
    );
  }
  function findPreferredVoiceIndex(availableVoices) {
    const mandarinVoiceIndex = availableVoices.findIndex(
      (voice) => voice.voiceName?.includes("Google") === true
    );
    if (mandarinVoiceIndex >= 0) {
      return mandarinVoiceIndex;
    }
    const simplifiedChineseIndex = availableVoices.findIndex(
      (voice) => voice.lang === "zh-CN"
    );
    if (simplifiedChineseIndex >= 0) {
      return simplifiedChineseIndex;
    }
    const traditionalChineseIndex = availableVoices.findIndex(
      (voice) => voice.lang === "zh-TW"
    );
    if (traditionalChineseIndex >= 0) {
      return traditionalChineseIndex;
    }
    return availableVoices.length > 0 ? 0 : -1;
  }
  async function loadVoices() {
    voices = await chrome.tts.getVoices();
    voiceSelect.replaceChildren();
    if (voices.length === 0) {
      statusElement.textContent = "Chrome \u6CA1\u6709\u8FD4\u56DE\u53EF\u7528\u58F0\u97F3\u3002";
      return;
    }
    const sortedVoices = [...voices].sort(compareVoices);
    const languageGroups = /* @__PURE__ */ new Map();
    for (const voice of sortedVoices) {
      const language = voice.lang ?? "\u672A\u77E5\u8BED\u8A00";
      let languageGroup = languageGroups.get(language);
      if (!languageGroup) {
        languageGroup = document.createElement("optgroup");
        languageGroup.label = language;
        languageGroups.set(language, languageGroup);
        voiceSelect.append(languageGroup);
      }
      const option = document.createElement("option");
      option.value = voice.voiceName ?? "";
      option.textContent = `${voice.remote ? "\u8FDC\u7A0B | " : "\u672C\u5730 | "}${voice.voiceName ?? "\u672A\u547D\u540D\u58F0\u97F3"}`;
      if (voice.lang === "zh-CN") {
        option.textContent = `\u2605 ${option.textContent}`;
      }
      languageGroup.append(option);
    }
    const preferredIndex = findPreferredVoiceIndex(sortedVoices);
    if (preferredIndex >= 0) {
      voiceSelect.selectedIndex = preferredIndex;
    }
    const chineseVoiceCount = voices.filter(
      (voice) => voice.lang?.startsWith("zh-CN")
    ).length;
    statusElement.textContent = `\u68C0\u6D4B\u5230 ${voices.length} \u4E2A\u58F0\u97F3\uFF0C\u5176\u4E2D\u4E2D\u6587\u58F0\u97F3\uFF1A${chineseVoiceCount}`;
  }
  speakButton.addEventListener("click", async () => {
    const text = textInput.value.trim();
    const voiceName = voiceSelect.value;
    const selectedVoice = voices.find((voice) => voice.voiceName === voiceName);
    if (!text) {
      statusElement.textContent = "\u8BF7\u8F93\u5165\u6D4B\u8BD5\u6587\u672C\u3002";
      return;
    }
    chrome.tts.stop();
    statusElement.textContent = `\u51C6\u5907\u64AD\u653E
\u58F0\u97F3\uFF1A${voiceName || "\u7CFB\u7EDF\u9ED8\u8BA4"}
\u8BED\u8A00\uFF1A${selectedVoice?.lang ?? "zh-CN"}
\u957F\u5EA6\uFF1A${text.length}`;
    const options = {
      // 声音缺少语言信息时使用简体中文，保证传给 Chrome 的 lang 始终有值。
      lang: selectedVoice?.lang ?? "zh-CN",
      // input.value 始终是字符串，需要转换为 chrome.tts 所需的 number。
      rate: Number(rateInput.value),
      pitch: 1,
      volume: 1,
      // 不进入现有播放队列；结合上方 stop()，本次请求会立即独立播放。
      enqueue: false,
      // Chrome 会通过该回调报告开始、单词边界、结束、取消和错误等播放事件。
      onEvent(event) {
        statusElement.textContent = `\u4E8B\u4EF6\uFF1A${event.type}
\u58F0\u97F3\uFF1A${voiceName || "\u7CFB\u7EDF\u9ED8\u8BA4"}
\u4F4D\u7F6E\uFF1A${event.charIndex ?? "\u672A\u77E5"}
\u957F\u5EA6\uFF1A${event.length ?? "\u672A\u77E5"}
\u9519\u8BEF\uFF1A${event.errorMessage ?? "\u65E0"}`;
      }
    };
    if (voiceName) {
      options.voiceName = voiceName;
    }
    try {
      await chrome.tts.speak(text, options);
    } catch (error) {
      statusElement.textContent = `\u8C03\u7528\u5931\u8D25\uFF1A${getErrorMessage(error)}`;
    }
  });
  stopButton.addEventListener("click", () => {
    chrome.tts.stop();
    statusElement.textContent = "\u5DF2\u505C\u6B62\u3002";
  });
  chrome.tts.onVoicesChanged.addListener(() => {
    void loadVoices();
  });
  loadVoices().catch((error) => {
    statusElement.textContent = `\u8BFB\u53D6\u58F0\u97F3\u5931\u8D25\uFF1A${getErrorMessage(error)}`;
  });
})();
