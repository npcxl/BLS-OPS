/**
 * 结果面板内搜索 —— 纯函数（渲染层只负责把切片画成高亮）。
 *
 * 命中的是**渲染文本本身**（终端输出快照 / JSON 序列化文本 / 原始流），
 * 不做任何清洗或归一化：用户看到什么就搜什么，大小写不敏感是唯一放宽。
 */

/** 一段文本按命中切片后的结果（`hit=true` 的片段要画高亮底色）。 */
export interface SearchSegment {
  text: string;
  hit: boolean;
}

/** 一行内的高亮命中区间（半开区间 `[start, end)`，按字符计）。 */
export interface SearchRange {
  start: number;
  end: number;
}

/** 空查询（含纯空白）视为"未搜索"—— 调用方据此不画任何高亮。 */
export function normalizeQuery(query: string): string {
  return query.trim().toLowerCase();
}

/**
 * 一行的全部命中区间（不重叠，从左到右）。空查询/空行返回 `[]`。
 *
 * 逐字符推进而非 `indexOf` 步进：`indexOf` 传 needle 长度会在 needle
 * 自身重叠时漏配（如 `aa` 在 `aaaa` 里只找到一处）。
 */
export function findRanges(line: string, query: string): SearchRange[] {
  const needle = normalizeQuery(query);
  if (!needle) return [];
  const haystack = line.toLowerCase();
  const ranges: SearchRange[] = [];
  let index = 0;
  while (index <= haystack.length - needle.length) {
    if (haystack.startsWith(needle, index)) {
      ranges.push({ start: index, end: index + needle.length });
      index += needle.length;
    } else {
      index += 1;
    }
  }
  return ranges;
}

/** 一行按命中切成若干段；无命中时返回整行一段（`hit=false`）。 */
export function segmentLine(line: string, query: string): SearchSegment[] {
  const ranges = findRanges(line, query);
  if (ranges.length === 0) return [{ text: line, hit: false }];
  const segments: SearchSegment[] = [];
  let cursor = 0;
  for (const range of ranges) {
    if (range.start > cursor) segments.push({ text: line.slice(cursor, range.start), hit: false });
    segments.push({ text: line.slice(range.start, range.end), hit: true });
    cursor = range.end;
  }
  if (cursor < line.length) segments.push({ text: line.slice(cursor), hit: false });
  return segments;
}

/** 行列表里的总命中数（用于 "n 处匹配" 展示）。 */
export function countHits(lines: string[], query: string): number {
  const needle = normalizeQuery(query);
  if (!needle) return 0;
  let total = 0;
  for (const line of lines) {
    total += findRanges(line, query).length;
  }
  return total;
}


