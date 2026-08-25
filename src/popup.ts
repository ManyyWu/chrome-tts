/**
 * 根据 CSS 选择器获取 popup 页面中的必需元素。
 *
 * popup 的交互逻辑依赖固定的 DOM 结构，因此元素缺失时直接抛出异常，
 * 可以让 HTML 与脚本不一致的问题尽早暴露，避免后续访问 null 时产生含义不明的错误。
 * 泛型参数 T 用于保留元素的具体类型，使调用方可以安全访问 value、textContent 等属性。
 *
 * @param selector 要查询的 CSS 选择器。
 * @returns 与选择器匹配的元素。
 * @throws 当页面中不存在目标元素时抛出错误。
 */
function requireElement<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);

  if (!element) {
    throw new Error(`缺少页面元素：${selector}`);
  }

  return element;
}

// 在脚本初始化时集中校验所有必需元素，后续事件处理器无需重复进行空值判断。
const voiceSelect = requireElement<HTMLSelectElement>("#voice");
const textInput = requireElement<HTMLTextAreaElement>("#text");
const rateInput = requireElement<HTMLInputElement>("#rate");
const statusElement = requireElement<HTMLDivElement>("#status");
const speakButton = requireElement<HTMLButtonElement>("#speak");
const stopButton = requireElement<HTMLButtonElement>("#stop");

// 保存 Chrome 返回的原始声音对象，用于根据下拉框中的 voiceName 查找语言等元数据。
let voices: chrome.tts.TtsVoice[] = [];

// 常用语言的展示优先级；未列出的语言统一排在这些语言之后。
const languagePriority = ["zh-CN", "zh-TW", "en-US", "ja-JP"] as const;

/**
 * 将 unknown 类型的异常转换为适合展示的字符串。
 * JavaScript 允许抛出任意值，因此 catch 变量不能假定为 Error 实例。
 */
function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 比较两个声音的展示顺序。
 *
 * 先根据 languagePriority 排列常用语言，再按语言代码排列其他语言；
 * 同一语言内按声音名称排序，从而保证分组与选项顺序稳定。
 */
function compareVoices(
  firstVoice: chrome.tts.TtsVoice,
  secondVoice: chrome.tts.TtsVoice,
): number {
  const firstLanguage = firstVoice.lang ?? "";
  const secondLanguage = secondVoice.lang ?? "";
  const firstPriority = languagePriority.indexOf(
    firstLanguage as (typeof languagePriority)[number],
  );
  const secondPriority = languagePriority.indexOf(
    secondLanguage as (typeof languagePriority)[number],
  );

  // indexOf 返回 -1 表示不在优先列表中，将其转换为列表长度以排到后面。
  const normalizedFirstPriority =
    firstPriority >= 0 ? firstPriority : languagePriority.length;
  const normalizedSecondPriority =
    secondPriority >= 0 ? secondPriority : languagePriority.length;
  const priorityDifference =
    normalizedFirstPriority - normalizedSecondPriority;

  if (priorityDifference !== 0) {
    return priorityDifference;
  }

  const languageDifference = firstLanguage.localeCompare(secondLanguage);
  if (languageDifference !== 0) {
    return languageDifference;
  }

  return (firstVoice.voiceName ?? "").localeCompare(
    secondVoice.voiceName ?? "",
  );
}

/**
 * 确定声音列表的默认选择项。
 *
 * 优先选择 Google 普通话；没有该声音时，依次回退到简体中文、
 * 繁体中文和排序后的第一个可用声音。
 *
 * @returns 默认声音在传入数组中的索引；空数组返回 -1。
 */
function findPreferredVoiceIndex(
  availableVoices: readonly chrome.tts.TtsVoice[],
): number {
  const mandarinVoiceIndex = availableVoices.findIndex(
    (voice) => voice.voiceName?.includes("Google") === true,
  );

  if (mandarinVoiceIndex >= 0) {
    return mandarinVoiceIndex;
  }

  const simplifiedChineseIndex = availableVoices.findIndex(
    (voice) => voice.lang === "zh-CN",
  );
  if (simplifiedChineseIndex >= 0) {
    return simplifiedChineseIndex;
  }

  const traditionalChineseIndex = availableVoices.findIndex(
    (voice) => voice.lang === "zh-TW",
  );
  if (traditionalChineseIndex >= 0) {
    return traditionalChineseIndex;
  }

  return availableVoices.length > 0 ? 0 : -1;
}

/**
 * 从 chrome.tts 读取当前系统可用的声音，并重建声音选择列表。
 *
 * 声音列表可能随操作系统语音包或扩展引擎的变化而更新，因此该函数既用于
 * popup 首次初始化，也用于响应 chrome.tts.onVoicesChanged 事件。
 */
async function loadVoices(): Promise<void> {
  // getVoices 返回本地声音与 TTS 引擎扩展提供的远程声音。
  voices = await chrome.tts.getVoices();

  // 每次刷新前清空旧选项，防止 onVoicesChanged 多次触发后出现重复声音。
  voiceSelect.replaceChildren();

  if (voices.length === 0) {
    statusElement.textContent = "Chrome 没有返回可用声音。";
    return;
  }

  // 使用副本排序，避免改变 Chrome API 返回数组的原始顺序。
  const sortedVoices = [...voices].sort(compareVoices);

  // 每个语言对应一个 optgroup，使下拉框形成“语言 -> 声音”的二级结构。
  const languageGroups = new Map<string, HTMLOptGroupElement>();

  for (const voice of sortedVoices) {
    const language = voice.lang ?? "未知语言";
    let languageGroup = languageGroups.get(language);

    if (!languageGroup) {
      languageGroup = document.createElement("optgroup");
      languageGroup.label = language;
      languageGroups.set(language, languageGroup);
      voiceSelect.append(languageGroup);
    }

    const option = document.createElement("option");

    // voiceName 是 chrome.tts.speak 指定声音时使用的标识；缺失时保留空字符串。
    option.value = voice.voiceName ?? "";
    option.textContent =
      `${voice.remote ? "远程 | " : "本地 | "}` +
      `${voice.voiceName ?? "未命名声音"}`;

    // 为简体中文声音添加视觉标记，便于在分组中快速定位。
    if (voice.lang === "zh-CN") {
      option.textContent = `★ ${option.textContent}`;
    }

    languageGroup.append(option);
  }

  // selectedIndex 按所有 optgroup 内 option 的整体顺序计数，与 sortedVoices 一一对应。
  const preferredIndex = findPreferredVoiceIndex(sortedVoices);
  if (preferredIndex >= 0) {
    voiceSelect.selectedIndex = preferredIndex;
  }

  // 统计所有 zh 开头的语言变体，例如 zh-CN、zh-TW 和 zh-HK。
  const chineseVoiceCount = voices.filter((voice) =>
    voice.lang?.startsWith("zh-CN"),
  ).length;
  statusElement.textContent =
    `检测到 ${voices.length} 个声音，其中中文声音：${chineseVoiceCount}`;
}

// 点击“播放”后读取当前表单值，并将文本交给 Chrome TTS 引擎朗读。
speakButton.addEventListener("click", async () => {
  const text = textInput.value.trim();
  const voiceName = voiceSelect.value;

  // 下拉框只保存 voiceName，需要回查完整对象以取得该声音声明的语言。
  const selectedVoice = voices.find((voice) => voice.voiceName === voiceName);

  if (!text) {
    statusElement.textContent = "请输入测试文本。";
    return;
  }

  // 停止可能仍在进行的朗读，确保本次点击不会与上一次播放并发。
  chrome.tts.stop();
  statusElement.textContent =
    `准备播放\n` +
    `声音：${voiceName || "系统默认"}\n` +
    `语言：${selectedVoice?.lang ?? "zh-CN"}\n` +
    `长度：${text.length}`;

  // TtsOptions 控制本次朗读使用的语言、语速、音调、音量及事件反馈。
  const options: chrome.tts.TtsOptions = {
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
      statusElement.textContent =
        `事件：${event.type}\n` +
        `声音：${voiceName || "系统默认"}\n` +
        `位置：${event.charIndex ?? "未知"}\n` +
        `长度：${event.length ?? "未知"}\n` +
        `错误：${event.errorMessage ?? "无"}`;
    },
  };

  // 空 voiceName 表示交由 Chrome 选择系统默认声音，避免传入无效的空标识。
  if (voiceName) {
    options.voiceName = voiceName;
  }

  try {
    // await 用于捕获 Chrome API Promise 拒绝，例如声音不可用或参数无效。
    await chrome.tts.speak(text, options);
  } catch (error: unknown) {
    statusElement.textContent = `调用失败：${getErrorMessage(error)}`;
  }
});

// 用户主动停止时中断当前朗读，并立即更新 popup 中的状态提示。
stopButton.addEventListener("click", () => {
  chrome.tts.stop();
  statusElement.textContent = "已停止。";
});

// 系统语音包或 TTS 引擎发生变化时重新读取列表；void 表明事件处理器不等待该 Promise。
chrome.tts.onVoicesChanged.addListener(() => {
  void loadVoices();
});

// popup 加载完成后立即初始化声音列表，并将读取失败原因展示给用户。
loadVoices().catch((error: unknown) => {
  statusElement.textContent = `读取声音失败：${getErrorMessage(error)}`;
});
