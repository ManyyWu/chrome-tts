import type {
  SiteTextFilter,
  SourceTextRange,
  TextFilterResult,
} from "../text-filter";

const ANNOUNCED_SKIP_KEYWORDS = [
  "火灾",
  "消防",
  "起火",
  "泥石流",
  "洪水",
  "洪灾",
  "塌方",
  "旺旺",
  "欠薪",
  "讨薪",
  "拖欠",
  "上官正义",
  "渔猎齐哥",
  "恶性", "伤人", ] as const;

const SILENT_SKIP_KEYWORDS = ["强奸", "性少数", "lgbt"] as const;
const REMOVE_TO_END_MARKERS = ["查看原文", "引用推文"] as const;
const QUOTED_SECTION_MARKERS = [
  "网友热议",
  "网友评论",
  "弹幕评论",
  "网友留言",
  "网友嘲讽",
  "评论区",
] as const;

type RemovalRange = SourceTextRange;

/** End GFW 的关键词、局部删除规则及处理代码全部集中在此文件。 */
export const endGfwTextFilter: SiteTextFilter = {
  id: "end-gfw-text-filter",
  matches: (url) => url.hostname === "end-gfw.com",
  filter: filterEndGfwText,
};

function filterEndGfwText(text: string): TextFilterResult | null {
  const cleaned = removePartialContent(text);
  if (cleaned === null || !cleaned.text) {
    return cleaned;
  }

  // 不允许播报的关键词优先，避免同一条文本还命中普通跳过词时泄露关键词。
  if (findFirstKeyword(cleaned.text, SILENT_SKIP_KEYWORDS) !== null) {
    return createGeneratedResult("跳过", text.length);
  }

  const announcedKeyword = findFirstKeyword(
    cleaned.text,
    ANNOUNCED_SKIP_KEYWORDS,
  );
  if (announcedKeyword !== null) {
    return createGeneratedResult(
      `跳过，关键字：${announcedKeyword}`,
      text.length,
    );
  }

  return cleaned;
}

/** 按文本中的实际出现顺序选择关键词；英文匹配不区分大小写。 */
function findFirstKeyword(
  text: string,
  keywords: readonly string[],
): string | null {
  const comparableText = text.toLocaleLowerCase();
  let firstKeyword: string | null = null;
  let firstIndex = Number.POSITIVE_INFINITY;
  for (const keyword of keywords) {
    const index = comparableText.indexOf(keyword.toLocaleLowerCase());
    if (index >= 0 && index < firstIndex) {
      firstKeyword = keyword;
      firstIndex = index;
    }
  }
  return firstKeyword;
}

function createGeneratedResult(
  text: string,
  sourceLength: number,
): TextFilterResult {
  return {
    text,
    sourceCharacterIndexes: null,
    postPlaybackDelayMs: 1000,
    removedSourceRanges: sourceLength > 0
      ? [{ start: 0, end: sourceLength }]
      : [],
  };
}

/** 汇总所有删除区间后一次性重建文本，避免多次替换造成原文索引漂移。 */
function removePartialContent(text: string): TextFilterResult | null {
  const ranges: RemovalRange[] = [];
  collectUrlRanges(text, ranges);
  collectCommentSectionRange(text, ranges);

  const terminalIndex = findFirstMarkerIndex(text, REMOVE_TO_END_MARKERS);
  if (terminalIndex >= 0) {
    ranges.push({ start: terminalIndex, end: text.length });
  }

  if (ranges.length === 0) {
    return {
      text,
      sourceCharacterIndexes: Array.from(text, (_character, index) => index),
      removedSourceRanges: [],
    };
  }
  return rebuildWithoutRanges(text, mergeRanges(ranges));
}

/** 同时删除 http 与 https 地址；截图中的实际链接使用 https。 */
function collectUrlRanges(text: string, ranges: RemovalRange[]): void {
  const urlPattern = /https?:\/\/[^\s)\]}>，。、“”‘’；！？]+/giu;
  for (const match of text.matchAll(urlPattern)) {
    const start = match.index;
    if (start === undefined) {
      continue;
    }
    ranges.push({ start, end: start + match[0].length });
  }
}

/**
 * End GFW 的评论引导语并不固定：关键词和首个引号之间可能插入“有人写道”、
 * “有网友表示”“与嘲讽”等说明，也可能省略冒号。只要起点词后短距离内出现
 * 中英文开引号，就把它识别为页面末尾的评论区，并从该段开头删除到末尾。
 */
function collectCommentSectionRange(
  text: string,
  ranges: RemovalRange[],
): void {
  const candidates = QUOTED_SECTION_MARKERS
    .flatMap((marker) => findAllMarkerIndexes(text, marker))
    .sort((first, second) => first - second);
  const terminalIndex = findFirstMarkerIndex(text, REMOVE_TO_END_MARKERS);

  for (const markerIndex of candidates) {
    const searchEnd = Math.min(
      text.length,
      terminalIndex >= 0 ? terminalIndex : markerIndex + 80,
      markerIndex + 80,
    );
    if (!hasOpeningQuote(text, markerIndex, searchEnd)) {
      continue;
    }
    ranges.push({
      start: findCommentSectionStart(text, markerIndex),
      end: text.length,
    });
    return;
  }
}

/** 返回同一标记的全部位置，避免前一次正文提及遮蔽后面的实际评论区。 */
function findAllMarkerIndexes(text: string, marker: string): number[] {
  const indexes: number[] = [];
  let searchFrom = 0;
  while (searchFrom < text.length) {
    const index = text.indexOf(marker, searchFrom);
    if (index < 0) {
      break;
    }
    indexes.push(index);
    searchFrom = index + marker.length;
  }
  return indexes;
}

function hasOpeningQuote(
  text: string,
  start: number,
  end: number,
): boolean {
  for (let index = start; index < end; index += 1) {
    if (isOpeningQuote(text[index])) {
      return true;
    }
  }
  return false;
}

function isOpeningQuote(character: string | undefined): character is string {
  return character === "“" || character === "‘" || character === "\"" ||
    character === "'";
}

/**
 * 通用适配器已折叠换行，因此通过最近的句末标点恢复评论引导句起点。
 * 限制最多回看 40 个字符，防止无标点长正文被一并删除。
 */
function findCommentSectionStart(text: string, markerIndex: number): number {
  const minimumIndex = Math.max(0, markerIndex - 40);
  for (let index = markerIndex - 1; index >= minimumIndex; index -= 1) {
    if (/[。！？!?]/u.test(text[index] ?? "")) {
      let sectionStart = index + 1;
      while (sectionStart < markerIndex && /\s/u.test(text[sectionStart] ?? "")) {
        sectionStart += 1;
      }
      return sectionStart;
    }
  }
  return markerIndex;
}

function findFirstMarkerIndex(
  text: string,
  markers: readonly string[],
): number {
  let firstIndex = Number.POSITIVE_INFINITY;
  for (const marker of markers) {
    const index = text.indexOf(marker);
    if (index >= 0 && index < firstIndex) {
      firstIndex = index;
    }
  }
  return Number.isFinite(firstIndex) ? firstIndex : -1;
}

function mergeRanges(ranges: readonly RemovalRange[]): RemovalRange[] {
  const sorted = [...ranges]
    .map((range) => ({
      start: Math.max(0, range.start),
      end: Math.min(range.end, Number.MAX_SAFE_INTEGER),
    }))
    .filter((range) => range.end > range.start)
    .sort((first, second) => first.start - second.start);
  const merged: RemovalRange[] = [];
  for (const range of sorted) {
    const previous = merged.at(-1);
    if (previous && range.start <= previous.end) {
      previous.end = Math.max(previous.end, range.end);
    } else {
      merged.push({ ...range });
    }
  }
  return merged;
}

/** 删除区间并折叠残留空白，同时为每个输出字符保存原文位置。 */
function rebuildWithoutRanges(
  text: string,
  ranges: readonly RemovalRange[],
): TextFilterResult | null {
  const characters: string[] = [];
  const indexes: number[] = [];
  let rangeIndex = 0;
  for (let sourceIndex = 0; sourceIndex < text.length; sourceIndex += 1) {
    while (
      rangeIndex < ranges.length &&
      sourceIndex >= (ranges[rangeIndex]?.end ?? Number.POSITIVE_INFINITY)
    ) {
      rangeIndex += 1;
    }
    const range = ranges[rangeIndex];
    if (range && sourceIndex >= range.start && sourceIndex < range.end) {
      continue;
    }

    const character = text[sourceIndex] ?? "";
    if (/\s/u.test(character)) {
      if (characters.length === 0 || characters.at(-1) === " ") {
        continue;
      }
      characters.push(" ");
      indexes.push(sourceIndex);
    } else {
      characters.push(character);
      indexes.push(sourceIndex);
    }
  }

  if (characters.at(-1) === " ") {
    characters.pop();
    indexes.pop();
  }

  const additionallyRemovedIndexes: number[] = [];
  removeEmptySymbolPairs(characters, indexes, additionallyRemovedIndexes);
  removeTrailingOrphanSymbols(characters, indexes, additionallyRemovedIndexes);

  // 过滤后只剩标点或括号时不再创建播放条目，避免 TTS 单独读出符号名称。
  if (!/[\p{L}\p{N}]/u.test(characters.join(""))) {
    return {
      text: "",
      sourceCharacterIndexes: [],
      removedSourceRanges: text.length > 0
        ? [{ start: 0, end: text.length }]
        : [],
    };
  }

  const allRemovedRanges = mergeRanges([
    ...ranges,
    ...additionallyRemovedIndexes.map((sourceIndex) => ({
      start: sourceIndex,
      end: sourceIndex + 1,
    })),
  ]);
  return {
    text: characters.join(""),
    sourceCharacterIndexes: indexes,
    removedSourceRanges: allRemovedRanges,
  };
}

/** 删除 URL 等内容后形成的空括号，例如 `()`、`（）`、`[]` 和 `【】`。 */
function removeEmptySymbolPairs(
  characters: string[],
  indexes: number[],
  removedIndexes: number[],
): void {
  const closingByOpening = new Map<string, string>([
    ["(", ")"],
    ["（", "）"],
    ["[", "]"],
    ["【", "】"],
    ["{", "}"],
    ["<", ">"],
    ["《", "》"],
  ]);

  let changed = true;
  while (changed) {
    changed = false;
    for (let index = 0; index < characters.length; index += 1) {
      const expectedClosing = closingByOpening.get(characters[index] ?? "");
      if (!expectedClosing) {
        continue;
      }
      const possibleSpaceIndex = index + 1;
      const closingIndex = characters[possibleSpaceIndex] === " "
        ? possibleSpaceIndex + 1
        : possibleSpaceIndex;
      if (characters[closingIndex] !== expectedClosing) {
        continue;
      }

      for (let removeIndex = closingIndex; removeIndex >= index; removeIndex -= 1) {
        const sourceIndex = indexes[removeIndex];
        if (sourceIndex !== undefined) {
          removedIndexes.push(sourceIndex);
        }
        characters.splice(removeIndex, 1);
        indexes.splice(removeIndex, 1);
      }
      changed = true;
      break;
    }
  }
}

/** 删除正文末尾因“删除到末尾”规则遗留的左括号、冒号、逗号等悬空符号。 */
function removeTrailingOrphanSymbols(
  characters: string[],
  indexes: number[],
  removedIndexes: number[],
): void {
  const orphanPattern = /[\s[【(（{<《：:,，、;；\-—|/\\]/u;
  while (characters.length > 0 && orphanPattern.test(characters.at(-1) ?? "")) {
    const sourceIndex = indexes.pop();
    characters.pop();
    if (sourceIndex !== undefined) {
      removedIndexes.push(sourceIndex);
    }
  }
}
