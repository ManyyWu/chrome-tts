/** 一个规范化字符在原始 DOM 文本节点中的实际边界。 */
export interface NormalizedCharacterRange {
  node: Text;
  startOffset: number;
  endOffset: number;
}

/**
 * 把 DOM 文本节点映射为与页面适配器一致的“连续空白折叠为一个空格”字符序列。
 * 逐字播放高亮和过滤删除标记共用该映射，确保两种效果定位到同一份原文。
 */
export function createNormalizedCharacterMap(
  element: HTMLElement,
): NormalizedCharacterRange[] {
  const characters: NormalizedCharacterRange[] = [];
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
  let pendingWhitespace: NormalizedCharacterRange | null = null;
  let currentNode = walker.nextNode();

  while (currentNode) {
    const textNode = currentNode as Text;
    const value = textNode.data;
    for (let offset = 0; offset < value.length; offset += 1) {
      const character: NormalizedCharacterRange = {
        node: textNode,
        startOffset: offset,
        endOffset: offset + 1,
      };
      if (/\s/u.test(value[offset] ?? "")) {
        if (characters.length > 0 && pendingWhitespace === null) {
          pendingWhitespace = character;
        }
        continue;
      }

      if (pendingWhitespace !== null) {
        characters.push(pendingWhitespace);
        pendingWhitespace = null;
      }
      characters.push(character);
    }
    currentNode = walker.nextNode();
  }

  return characters;
}
