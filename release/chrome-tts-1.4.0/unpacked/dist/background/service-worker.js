"use strict";
(() => {
  // src/shared/messages.ts
  function isExtensionRequest(value) {
    if (typeof value !== "object" || value === null || !("type" in value)) {
      return false;
    }
    const type = value.type;
    if (type === "page:set-items") {
      return "items" in value && isPageTextItemArray(value.items) && "pageSessionId" in value && typeof value.pageSessionId === "string" && value.pageSessionId.length >= 16 && value.pageSessionId.length <= 128;
    }
    if (type === "player:play-text") {
      return "text" in value && typeof value.text === "string" && isSpeakableText(value.text) && "source" in value && (value.source === "selection" || value.source === "input");
    }
    if (type === "selection:auto-play") {
      return "text" in value && typeof value.text === "string" && isSpeakableText(value.text);
    }
    if (type === "site:play-caption") {
      return "text" in value && typeof value.text === "string" && isSpeakableText(value.text);
    }
    if (type === "site:open-x-tweet") {
      return "tweetId" in value && typeof value.tweetId === "string" && /^\d+$/u.test(value.tweetId);
    }
    if (type === "page:play-from-position") {
      return "itemId" in value && typeof value.itemId === "string" && value.itemId.length > 0 && "charIndex" in value && typeof value.charIndex === "number" && Number.isInteger(value.charIndex) && value.charIndex >= 0 && value.charIndex <= 32768;
    }
    return type === "page:toggle" || type === "page:previous" || type === "page:next" || type === "player:stop" || type === "player:get-state" || type === "test:trigger-error";
  }
  function isPageTextItemArray(value) {
    return Array.isArray(value) && value.length <= 1e4 && value.every(
      (item) => typeof item === "object" && item !== null && "id" in item && typeof item.id === "string" && item.id.length > 0 && "text" in item && typeof item.text === "string" && isSpeakableText(item.text) && "index" in item && typeof item.index === "number" && Number.isInteger(item.index) && item.index >= 0
    );
  }
  function isSpeakableText(text) {
    const length = text.trim().length;
    return length > 0 && length <= 32768;
  }

  // src/shared/settings.ts
  var SETTINGS_KEY = "extensionSettings";
  var DEFAULT_SETTINGS = {
    version: 6,
    voiceName: null,
    voiceExtensionId: null,
    lang: null,
    rate: 1,
    volume: 1,
    highlightBorderColor: "#22a06b",
    highlightBackgroundColor: "#e6f6ef",
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
  function normalizeColor(value, fallback) {
    return typeof value === "string" && /^#[0-9a-f]{6}$/iu.test(value) ? value.toLowerCase() : fallback;
  }
  function normalizeSettings(value) {
    if (typeof value !== "object" || value === null) {
      return { ...DEFAULT_SETTINGS };
    }
    const stored = value;
    const rate = typeof stored.rate === "number" && Number.isFinite(stored.rate) ? clamp(Math.round(stored.rate * 10) / 10, 0.5, 1.5) : DEFAULT_SETTINGS.rate;
    const volume = typeof stored.volume === "number" && Number.isFinite(stored.volume) ? clamp(stored.volume, 0, 1) : DEFAULT_SETTINGS.volume;
    return {
      version: 6,
      voiceName: isNullableString(stored.voiceName) ? stored.voiceName : DEFAULT_SETTINGS.voiceName,
      voiceExtensionId: isNullableString(stored.voiceExtensionId) ? stored.voiceExtensionId : DEFAULT_SETTINGS.voiceExtensionId,
      lang: isNullableString(stored.lang) ? stored.lang : DEFAULT_SETTINGS.lang,
      rate,
      volume,
      highlightBorderColor: normalizeColor(
        stored.highlightBorderColor,
        DEFAULT_SETTINGS.highlightBorderColor
      ),
      highlightBackgroundColor: normalizeColor(
        stored.highlightBackgroundColor,
        DEFAULT_SETTINGS.highlightBackgroundColor
      ),
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

  // src/background/player.ts
  var TtsPlayer = class {
    constructor(onStateChange, onPositionChange) {
      this.onStateChange = onStateChange;
      this.onPositionChange = onPositionChange;
    }
    state = {
      status: "idle",
      source: null,
      itemId: null,
      updatedAt: Date.now()
    };
    playbackToken = 0;
    currentSpeech = null;
    /** 返回不可被调用方修改的状态副本。 */
    getState() {
      return { ...this.state };
    }
    /** 返回当前话语及最近的位置事件，用于原生暂停失效后的文本位置恢复。 */
    getSpeechSnapshot() {
      return this.currentSpeech === null ? null : { ...this.currentSpeech };
    }
    /**
     * 暂停当前话语。桌面端保留原生暂停；Android 的本地 TTS 无法可靠 resume，需停止
     * 原话语，再由 service worker 重新播放本次完整文本。
     */
    pause(useRestartFallback) {
      if (this.state.status === "playing") {
        if (useRestartFallback) {
          this.playbackToken += 1;
          chrome.tts.stop();
        } else {
          chrome.tts.pause();
        }
        this.setState("paused");
      }
      return this.getState();
    }
    /** 桌面端恢复由浏览器原生暂停的话语；Android 不调用此方法。 */
    resume() {
      if (this.state.status === "paused") {
        chrome.tts.resume();
        this.setState("playing");
      }
      return this.getState();
    }
    /** 播放标准化文本，并记录来源和可选页面条目 ID。 */
    async playText(text, source, itemId = null, textOffset = 0) {
      const normalizedText = text.trim();
      if (!normalizedText) {
        this.setState("error", "\u6CA1\u6709\u53EF\u64AD\u653E\u7684\u6587\u672C\u3002");
        return this.getState();
      }
      this.currentSpeech = {
        text: normalizedText,
        source,
        itemId,
        charIndex: 0,
        textOffset
      };
      return this.play(normalizedText, source, itemId);
    }
    /** 停止当前话语，并让旧话语的后续事件全部失效。 */
    stop() {
      this.playbackToken += 1;
      chrome.tts.stop();
      this.setState("stopped");
      return this.getState();
    }
    /** 使用持久化声音参数开始一次独立话语。 */
    async play(text, source, itemId) {
      this.playbackToken += 1;
      const token = this.playbackToken;
      chrome.tts.stop();
      this.state = {
        status: "loading",
        source,
        itemId,
        updatedAt: Date.now()
      };
      this.onStateChange(this.getState());
      try {
        const settings = await loadSettings();
        if (token !== this.playbackToken) {
          return this.getState();
        }
        const options = this.createOptions(settings, token);
        await chrome.tts.speak(text, options);
      } catch (error) {
        if (token === this.playbackToken) {
          this.setState("error", getErrorMessage(error));
        }
      }
      return this.getState();
    }
    /** 根据已校验设置生成 TTS 参数，并只监听当前 token 对应的话语事件。 */
    createOptions(settings, token) {
      const options = {
        enqueue: false,
        rate: settings.rate,
        volume: settings.volume,
        pitch: 1,
        // 明确请求文本边界事件；具体能否返回以及粒度仍由当前语音引擎决定。
        desiredEventTypes: [
          "start",
          "end",
          "word",
          "sentence",
          "interrupted",
          "cancelled",
          "error",
          "pause",
          "resume"
        ],
        onEvent: (event) => {
          if (token !== this.playbackToken) {
            return;
          }
          this.handleTtsEvent(event);
        }
      };
      if (settings.voiceName) {
        options.voiceName = settings.voiceName;
      }
      if (settings.voiceExtensionId) {
        options.extensionId = settings.voiceExtensionId;
      }
      if (settings.lang) {
        options.lang = settings.lang;
      }
      return options;
    }
    /** 将 Chrome TTS 事件归一化为项目定义的有限状态。 */
    handleTtsEvent(event) {
      if (this.currentSpeech !== null && typeof event.charIndex === "number" && Number.isFinite(event.charIndex)) {
        this.currentSpeech.charIndex = Math.min(
          this.currentSpeech.text.length,
          Math.max(0, Math.trunc(event.charIndex))
        );
        if (this.currentSpeech.source === "page" && this.currentSpeech.itemId !== null && (event.type === "word" || event.type === "sentence")) {
          const reportedLength = event.type === "word" && typeof event.length === "number" && event.length > 0 ? Math.trunc(event.length) : 1;
          this.onPositionChange({
            itemId: this.currentSpeech.itemId,
            charIndex: this.currentSpeech.textOffset + this.currentSpeech.charIndex,
            length: reportedLength,
            granularity: event.type
          });
        }
      }
      switch (event.type) {
        case "start":
        case "resume":
          this.setState("playing");
          break;
        case "pause":
          this.setState("paused");
          break;
        case "end":
          this.setState("completed");
          break;
        case "interrupted":
        case "cancelled":
          this.setState("stopped");
          break;
        case "error":
          this.setState("error", event.errorMessage ?? "TTS \u64AD\u653E\u5931\u8D25\u3002");
          break;
        default:
          break;
      }
    }
    /** 更新状态并发布完整快照，确保所有界面观察到一致结果。 */
    setState(status, errorMessage) {
      this.state = {
        status,
        source: this.state.source,
        itemId: this.state.itemId,
        updatedAt: Date.now(),
        ...errorMessage ? { errorMessage } : {}
      };
      this.onStateChange(this.getState());
    }
  };
  function getErrorMessage(error) {
    return error instanceof Error ? error.message : String(error);
  }

  // src/background/service-worker.ts
  var PAUSED_PLAYBACK_KEY = "pausedPlayback";
  var PAGE_QUEUE_CURSORS_KEY = "pageQueueCursors";
  var PLAYER_KEEP_ALIVE_PORT = "player-keep-alive";
  var pageQueues = /* @__PURE__ */ new Map();
  var activePlaybackTabId = null;
  var playbackOwnerTabId = null;
  function publishState(state) {
    const event = { type: "player:state-changed", state };
    void chrome.runtime.sendMessage(event).catch(() => void 0);
    const targetTabId = activePlaybackTabId;
    if (targetTabId !== null) {
      void chrome.tabs.sendMessage(targetTabId, event).catch(() => void 0);
    }
    if (state.status === "completed" && state.source === "page") {
      void continuePageQueue(state, targetTabId);
    } else if (state.status === "completed" || state.status === "stopped" || state.status === "error") {
      activePlaybackTabId = null;
      if (state.status === "completed" || state.status === "error") {
        void clearPausedPlayback();
      }
    }
  }
  function publishPosition(position) {
    const targetTabId = activePlaybackTabId;
    if (targetTabId === null) {
      return;
    }
    const event = { type: "player:position-changed", position };
    void chrome.tabs.sendMessage(targetTabId, event).catch(() => void 0);
  }
  var player = new TtsPlayer(publishState, publishPosition);
  var platformInfoPromise = chrome.runtime.getPlatformInfo();
  chrome.runtime.onInstalled.addListener(() => {
    void loadSettings().catch((error) => {
      console.error(
        "\u521D\u59CB\u5316\u6269\u5C55\u8BBE\u7F6E\u5931\u8D25\uFF1A",
        error instanceof Error ? error.message : String(error)
      );
    });
  });
  chrome.tabs.onRemoved.addListener((tabId) => {
    pageQueues.delete(tabId);
    if (tabId === playbackOwnerTabId) {
      playbackOwnerTabId = null;
    }
    if (tabId === activePlaybackTabId) {
      activePlaybackTabId = null;
      player.stop();
    }
    void clearPausedPlaybackForTab(tabId);
    void clearPageQueueCursor(tabId);
  });
  chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
    const navigationStarted = changeInfo.status === "loading" || changeInfo.url !== void 0;
    if (!navigationStarted) {
      return;
    }
    pageQueues.delete(tabId);
    void clearPausedPlaybackForTab(tabId);
    void clearPageQueueCursor(tabId);
    if (tabId !== activePlaybackTabId) {
      return;
    }
    activePlaybackTabId = null;
    playbackOwnerTabId = null;
    player.stop();
  });
  chrome.runtime.onConnect.addListener((port) => {
    if (port.name !== PLAYER_KEEP_ALIVE_PORT) {
      return;
    }
    port.onMessage.addListener(() => void 0);
  });
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!isExtensionRequest(message)) {
      return false;
    }
    void handleRequest(message, sender).then(sendResponse).catch((error) => {
      const response = {
        ok: false,
        state: player.getState(),
        error: error instanceof Error ? error.message : String(error)
      };
      sendResponse(response);
    });
    return true;
  });
  async function handleRequest(request, sender) {
    switch (request.type) {
      case "page:set-items": {
        const tabId = requireSenderTabId(sender);
        await updatePageQueue(tabId, request.items, request.pageSessionId);
        return { ok: true, state: getStateForTab(tabId) };
      }
      case "page:toggle": {
        const tabId = requireSenderTabId(sender);
        return { ok: true, state: await togglePagePlayback(tabId) };
      }
      case "page:previous": {
        const tabId = requireSenderTabId(sender);
        return { ok: true, state: await jumpPageItem(tabId, -1) };
      }
      case "page:next": {
        const tabId = requireSenderTabId(sender);
        return { ok: true, state: await jumpPageItem(tabId, 1) };
      }
      case "page:play-from-position": {
        const tabId = requireSenderTabId(sender);
        return {
          ok: true,
          state: await playPageItemFromPosition(
            tabId,
            request.itemId,
            request.charIndex
          )
        };
      }
      case "player:play-text": {
        const tabId = requireSenderTabId(sender);
        return {
          ok: true,
          state: await startPlaybackForTab(
            tabId,
            () => player.playText(request.text, request.source)
          )
        };
      }
      case "selection:auto-play": {
        const tabId = requireSenderTabId(sender);
        const state = player.getState();
        if (state.status === "loading" || state.status === "playing" || state.status === "paused") {
          return { ok: true, state: getStateForTab(tabId) };
        }
        return {
          ok: true,
          state: await startPlaybackForTab(
            tabId,
            () => player.playText(request.text, "selection")
          )
        };
      }
      case "site:play-caption": {
        const tabId = requireSenderTabId(sender);
        return {
          ok: true,
          state: await startPlaybackForTab(
            tabId,
            () => player.playText(request.text, "caption")
          )
        };
      }
      case "site:open-x-tweet": {
        await chrome.tabs.create({
          url: `https://x.com/i/status/${request.tweetId}`,
          active: true
        });
        return { ok: true, state: player.getState() };
      }
      case "player:stop":
        await clearPausedPlayback();
        return { ok: true, state: player.stop() };
      case "player:get-state":
        return {
          ok: true,
          state: sender.tab?.id === void 0 ? player.getState() : getStateForTab(sender.tab.id)
        };
      case "test:trigger-error":
        await sendTestError();
        return { ok: true, state: player.getState() };
    }
  }
  async function updatePageQueue(tabId, items, pageSessionId) {
    const previousQueue = pageQueues.get(tabId);
    const storedCursor = previousQueue ? null : await loadPageQueueCursor(tabId);
    const storedPausedPlayback = previousQueue ? null : await loadPausedPlayback();
    const previousSessionId = previousQueue?.pageSessionId ?? storedCursor?.pageSessionId ?? (storedPausedPlayback?.tabId === tabId ? storedPausedPlayback.pageSessionId : void 0);
    const isNewPageSession = previousSessionId !== void 0 && previousSessionId !== pageSessionId;
    if (isNewPageSession) {
      if (activePlaybackTabId === tabId || playbackOwnerTabId === tabId) {
        player.stop();
        activePlaybackTabId = null;
        playbackOwnerTabId = null;
      }
      await clearPausedPlaybackForTab(tabId);
      await clearPageQueueCursor(tabId);
    }
    const reusableQueue = isNewPageSession ? void 0 : previousQueue;
    const reusableCursor = isNewPageSession ? null : storedCursor;
    const nextNamespace = getItemNamespace(items[0]?.id);
    const previousItem = reusableQueue?.items[reusableQueue.currentIndex];
    const previousNamespace = getItemNamespace(
      previousItem?.id ?? reusableCursor?.itemId
    );
    const sameAdapterNamespace = previousNamespace === null || previousNamespace === nextNamespace;
    const currentItemId = sameAdapterNamespace && activePlaybackTabId === tabId && player.getState().source === "page" ? player.getState().itemId : sameAdapterNamespace ? previousItem?.id ?? reusableCursor?.itemId : null;
    const matchingIndex = currentItemId ? items.findIndex((item) => item.id === currentItemId) : -1;
    const fallbackIndex = Math.min(
      Math.max(
        sameAdapterNamespace ? reusableQueue?.currentIndex ?? reusableCursor?.index ?? 0 : 0,
        0
      ),
      Math.max(items.length - 1, 0)
    );
    pageQueues.set(tabId, {
      items: items.map((item, index) => ({ ...item, index })),
      currentIndex: matchingIndex >= 0 ? matchingIndex : fallbackIndex,
      pageSessionId
    });
  }
  function getItemNamespace(itemId) {
    if (!itemId) {
      return null;
    }
    return itemId.split(":", 1)[0] ?? null;
  }
  async function togglePagePlayback(tabId) {
    const state = player.getState();
    if (activePlaybackTabId === tabId) {
      if (state.status === "loading") {
        return state;
      }
      if (state.status === "playing") {
        const pausedState = player.pause(await isAndroidPlatform());
        await savePausedPlayback(tabId);
        return pausedState;
      }
      if (state.status === "paused") {
        if (!await isAndroidPlatform()) {
          await clearPausedPlayback();
          return player.resume();
        }
        const pausedPlayback2 = await loadPausedPlayback();
        if (pausedPlayback2?.tabId === tabId) {
          return replayPausedPlayback(pausedPlayback2);
        }
        const queue2 = requirePageQueue(tabId);
        return playPageItem(tabId, queue2.currentIndex);
      }
    }
    const pausedPlayback = await loadPausedPlayback();
    if (pausedPlayback?.tabId === tabId) {
      if (await isAndroidPlatform()) {
        return replayPausedPlayback(pausedPlayback);
      }
      return resumePausedPlayback(pausedPlayback);
    }
    const queue = requirePageQueue(tabId);
    return playPageItem(tabId, queue.currentIndex);
  }
  async function isAndroidPlatform() {
    return (await platformInfoPromise).os === "android";
  }
  async function jumpPageItem(tabId, offset) {
    const queue = requirePageQueue(tabId);
    const targetIndex = Math.min(
      queue.items.length - 1,
      Math.max(0, queue.currentIndex + offset)
    );
    if (targetIndex === queue.currentIndex && activePlaybackTabId === tabId && player.getState().source === "page" && player.getState().itemId) {
      return player.getState();
    }
    return playPageItem(tabId, targetIndex);
  }
  async function playPageItem(tabId, index) {
    const queue = requirePageQueue(tabId);
    const item = queue.items[index];
    if (!item) {
      throw new Error("\u76EE\u6807\u6587\u672C\u6761\u76EE\u4E0D\u5B58\u5728\u3002");
    }
    queue.currentIndex = index;
    await savePageQueueCursor(tabId, item.id, index);
    return startPlaybackForTab(
      tabId,
      () => player.playText(item.text, "page", item.id)
    );
  }
  async function playPageItemFromPosition(tabId, itemId, charIndex) {
    const queue = requirePageQueue(tabId);
    const index = queue.items.findIndex((item2) => item2.id === itemId);
    const item = queue.items[index];
    if (!item) {
      throw new Error("\u9009\u62E9\u6587\u672C\u6240\u5728\u6BB5\u843D\u5DF2\u53D1\u751F\u53D8\u5316\uFF0C\u8BF7\u91CD\u65B0\u9009\u62E9\u3002");
    }
    const boundedIndex = Math.min(item.text.length - 1, Math.max(0, charIndex));
    const rawRemainingText = item.text.slice(boundedIndex);
    const remainingText = rawRemainingText.trimStart();
    const removedLeadingWhitespace = rawRemainingText.length - remainingText.length;
    const textOffset = boundedIndex + removedLeadingWhitespace;
    if (!remainingText) {
      throw new Error("\u9009\u62E9\u4F4D\u7F6E\u4E4B\u540E\u6CA1\u6709\u53EF\u64AD\u653E\u6587\u672C\u3002");
    }
    queue.currentIndex = index;
    await savePageQueueCursor(tabId, item.id, index);
    return startPlaybackForTab(
      tabId,
      () => player.playText(remainingText, "page", item.id, textOffset)
    );
  }
  async function startPlaybackForTab(tabId, start) {
    const previousTabId = activePlaybackTabId;
    await clearPausedPlayback();
    if (previousTabId !== null && previousTabId !== tabId) {
      player.stop();
    }
    activePlaybackTabId = tabId;
    playbackOwnerTabId = tabId;
    await start();
    return getStateForTab(tabId);
  }
  async function resumePausedPlayback(pausedPlayback) {
    const remainingText = pausedPlayback.text.slice(pausedPlayback.charIndex).trimStart();
    const recoveryText = remainingText || pausedPlayback.text;
    const rawRemainingText = pausedPlayback.text.slice(pausedPlayback.charIndex);
    const removedLeadingWhitespace = rawRemainingText.length - remainingText.length;
    const recoveryOffset = remainingText ? pausedPlayback.textOffset + pausedPlayback.charIndex + removedLeadingWhitespace : pausedPlayback.textOffset;
    return startPlaybackForTab(
      pausedPlayback.tabId,
      () => player.playText(
        recoveryText,
        pausedPlayback.source,
        pausedPlayback.itemId,
        recoveryOffset
      )
    );
  }
  async function replayPausedPlayback(pausedPlayback) {
    return startPlaybackForTab(
      pausedPlayback.tabId,
      () => player.playText(
        pausedPlayback.text,
        pausedPlayback.source,
        pausedPlayback.itemId,
        pausedPlayback.textOffset
      )
    );
  }
  async function savePausedPlayback(tabId) {
    const speech = player.getSpeechSnapshot();
    const pageSessionId = pageQueues.get(tabId)?.pageSessionId;
    if (!speech || !pageSessionId) {
      return;
    }
    const pausedPlayback = { tabId, pageSessionId, ...speech };
    await chrome.storage.session.set({ [PAUSED_PLAYBACK_KEY]: pausedPlayback });
  }
  async function loadPausedPlayback() {
    const stored = await chrome.storage.session.get(PAUSED_PLAYBACK_KEY);
    const value = stored[PAUSED_PLAYBACK_KEY];
    if (typeof value !== "object" || value === null) {
      return null;
    }
    const record = value;
    if (typeof record.tabId !== "number" || !Number.isInteger(record.tabId) || typeof record.pageSessionId !== "string" || record.pageSessionId.length < 16 || record.pageSessionId.length > 128 || typeof record.text !== "string" || record.text.length === 0 || !isSpeechSource(record.source) || !(record.itemId === null || typeof record.itemId === "string") || typeof record.charIndex !== "number" || !Number.isFinite(record.charIndex) || typeof record.textOffset !== "number" || !Number.isFinite(record.textOffset)) {
      await clearPausedPlayback();
      return null;
    }
    return {
      tabId: record.tabId,
      pageSessionId: record.pageSessionId,
      text: record.text,
      source: record.source,
      itemId: record.itemId,
      charIndex: Math.min(
        record.text.length,
        Math.max(0, Math.trunc(record.charIndex))
      ),
      textOffset: Math.max(0, Math.trunc(record.textOffset))
    };
  }
  function isSpeechSource(value) {
    return value === "page" || value === "selection" || value === "input" || value === "caption";
  }
  async function clearPausedPlayback() {
    await chrome.storage.session.remove(PAUSED_PLAYBACK_KEY);
  }
  async function clearPausedPlaybackForTab(tabId) {
    const pausedPlayback = await loadPausedPlayback();
    if (pausedPlayback?.tabId === tabId) {
      await clearPausedPlayback();
    }
  }
  async function savePageQueueCursor(tabId, itemId, index) {
    const pageSessionId = pageQueues.get(tabId)?.pageSessionId;
    if (!pageSessionId) {
      return;
    }
    const stored = await chrome.storage.session.get(PAGE_QUEUE_CURSORS_KEY);
    const cursors = normalizePageQueueCursors(stored[PAGE_QUEUE_CURSORS_KEY]);
    cursors[String(tabId)] = { itemId, index, pageSessionId };
    await chrome.storage.session.set({ [PAGE_QUEUE_CURSORS_KEY]: cursors });
  }
  async function loadPageQueueCursor(tabId) {
    const stored = await chrome.storage.session.get(PAGE_QUEUE_CURSORS_KEY);
    const cursors = normalizePageQueueCursors(stored[PAGE_QUEUE_CURSORS_KEY]);
    return cursors[String(tabId)] ?? null;
  }
  async function clearPageQueueCursor(tabId) {
    const stored = await chrome.storage.session.get(PAGE_QUEUE_CURSORS_KEY);
    const cursors = normalizePageQueueCursors(stored[PAGE_QUEUE_CURSORS_KEY]);
    const key = String(tabId);
    if (!(key in cursors)) {
      return;
    }
    delete cursors[key];
    await chrome.storage.session.set({ [PAGE_QUEUE_CURSORS_KEY]: cursors });
  }
  function normalizePageQueueCursors(value) {
    if (typeof value !== "object" || value === null) {
      return {};
    }
    const normalized = {};
    for (const [key, cursor] of Object.entries(value)) {
      if (typeof cursor === "object" && cursor !== null && "itemId" in cursor && typeof cursor.itemId === "string" && "index" in cursor && typeof cursor.index === "number" && Number.isInteger(cursor.index) && cursor.index >= 0 && "pageSessionId" in cursor && typeof cursor.pageSessionId === "string" && cursor.pageSessionId.length >= 16 && cursor.pageSessionId.length <= 128) {
        normalized[key] = {
          itemId: cursor.itemId,
          index: cursor.index,
          pageSessionId: cursor.pageSessionId
        };
      }
    }
    return normalized;
  }
  function getStateForTab(tabId) {
    const state = player.getState();
    if (playbackOwnerTabId === null || playbackOwnerTabId === tabId) {
      return state;
    }
    return {
      status: "idle",
      source: null,
      itemId: null,
      updatedAt: state.updatedAt
    };
  }
  async function continuePageQueue(completedState, tabId) {
    if (tabId === null || tabId !== activePlaybackTabId) {
      return;
    }
    const queue = pageQueues.get(tabId);
    if (!queue) {
      activePlaybackTabId = null;
      return;
    }
    const completedIndex = completedState.itemId ? queue.items.findIndex((item) => item.id === completedState.itemId) : queue.currentIndex;
    const nextIndex = completedIndex + 1;
    if (nextIndex >= queue.items.length) {
      activePlaybackTabId = null;
      return;
    }
    await playPageItem(tabId, nextIndex);
  }
  function requirePageQueue(tabId) {
    const queue = pageQueues.get(tabId);
    if (!queue || queue.items.length === 0) {
      throw new Error("\u5F53\u524D\u9875\u9762\u6CA1\u6709\u53EF\u81EA\u52A8\u64AD\u653E\u7684\u6587\u672C\u3002");
    }
    return queue;
  }
  function requireSenderTabId(sender) {
    if (sender.tab?.id === void 0) {
      throw new Error("\u9875\u9762\u547D\u4EE4\u7F3A\u5C11\u6765\u6E90\u6807\u7B7E\u9875\u3002");
    }
    return sender.tab.id;
  }
  async function sendTestError() {
    const [activeTab] = await chrome.tabs.query({
      active: true,
      lastFocusedWindow: true
    });
    if (activeTab?.id === void 0) {
      throw new Error("\u6CA1\u6709\u53EF\u63A5\u6536\u6D4B\u8BD5\u9519\u8BEF\u7684\u6D3B\u52A8\u9875\u9762\u3002");
    }
    const testError = {
      code: "TEST_ERROR",
      message: "\u8FD9\u662F\u4E00\u6761 Chrome TTS \u6D4B\u8BD5\u9519\u8BEF\u3002",
      source: "test",
      recoverable: true
    };
    const event = { type: "extension:error", error: testError };
    await chrome.tabs.sendMessage(activeTab.id, event);
  }
})();
