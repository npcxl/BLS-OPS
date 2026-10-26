/**
 * CodeMirror 搜索：扩展装配 + 查询/匹配工具。
 *
 * # 为什么面板不再由 CodeMirror 渲染
 *
 * `@codemirror/search` 自带的面板是 DOM 构造的原生样式（灰色整行），既不好
 * 看也无法复用设计令牌。这里只用它提供的**匹配与命令能力**，面板交给
 * `CodeSearchBox`（React）渲染成 VSCode 那样的右上角浮动小框：默认只有查找
 * 行，点箭头才展开替换行。
 *
 * 因此：
 *
 * - `opsSearch()` 装载 search 扩展（高亮 + 命令），**不**装载它的面板；
 * - `Mod-f` 由外层容器在**捕获阶段**拦截（`searchKeymap` 挂在编辑器 DOM 上，
 *   冒泡阶段拦不住），从而永远打不开默认面板；
 * - 高亮靠 `setSearchQuery`，跳转/替换靠官方 `findNext` / `replaceAll` 等命令，
 *   语义与默认面板一致，只是外壳换成我们自己画的。
 */
import type { EditorState, EditorView } from "@uiw/react-codemirror";
import {
  SearchQuery,
  findNext,
  findPrevious,
  replaceAll,
  replaceNext,
  search,
  setSearchQuery,
} from "@codemirror/search";

/**
 * 搜索扩展：高亮、跳转与替换命令（不含默认面板）。
 *
 * 返回单个 Extension，方便调用方直接 push 语言扩展而不必解开数组。
 */
export function opsSearch() {
  return search();
}

/** 构造查询。`replace` 只在执行替换动作时带上。 */
export function buildQuery(
  search: string,
  caseSensitive: boolean,
  replace?: string,
): SearchQuery {
  return new SearchQuery({ search, caseSensitive, replace });
}

/** 把查询写入编辑器（触发高亮）。 */
export function applyQuery(view: EditorView, query: SearchQuery): void {
  view.dispatch({ effects: setSearchQuery.of(query) });
}

/** 清除高亮（关闭面板时调用）。 */
export function clearQuery(view: EditorView): void {
  view.dispatch({ effects: setSearchQuery.of(buildQuery("", false)) });
}

/** 下一个 / 上一个匹配。 */
export function gotoMatch(view: EditorView, backward: boolean): void {
  if (backward) findPrevious(view);
  else findNext(view);
}

/** 替换当前匹配 / 全部替换。查询必须已带 `replace`。 */
export function replaceMatch(view: EditorView, all: boolean): void {
  if (all) replaceAll(view);
  else replaceNext(view);
}

/**
 * 单次扫描的匹配数量上限。
 *
 * 为什么要有上限：`getCursor` 是同步遍历，命中越多、文档越大，这次遍历
 * 就越久 —— 它跑在主线程上，直接决定输入跟不跟手。上限把最坏情况钉住。
 *
 * 达到上限就停止，调用方**必须**把 `truncated` 显示出来（例如 `2000+`），
 * 不能把"下限"伪装成精确总数。
 */
export const MATCH_SCAN_LIMIT = 2000;

/** 一次扫描的结果。`truncated` 为真时 `ranges.length` 只是下限。 */
export interface MatchScan {
  ranges: { from: number; to: number }[];
  truncated: boolean;
}

/**
 * 扫描当前查询的匹配区间（最多 [`MATCH_SCAN_LIMIT`] 个）。
 *
 * `getCursor` 返回的是裸 `Iterator`（不带 `Symbol.iterator`），只能手动
 * `next()` —— 不要用 `for...of` / 展开运算符。
 */
export function scanMatches(
  // 只要 `state`：这样测试可以只造一个 `EditorState`，不必挂真实编辑器。
  target: { state: EditorState },
  query: SearchQuery,
  limit = MATCH_SCAN_LIMIT,
): MatchScan {
  if (!query.valid) return { ranges: [], truncated: false };
  const ranges: { from: number; to: number }[] = [];
  const cursor = query.getCursor(target.state);
  let truncated = false;
  for (let next = cursor.next(); !next.done; next = cursor.next()) {
    if (ranges.length >= limit) {
      truncated = true;
      break;
    }
    ranges.push(next.value);
  }
  return { ranges, truncated };
}

/** 一次分块扫描的结果。 */
export interface ChunkScan {
  /** 本次块内新增的匹配（已按 `from` 去重，保证单调递增）。 */
  ranges: { from: number; to: number }[];
  /** 下一次从这里继续（已回退重叠区）；`>= doc.length` 表示扫完。 */
  position: number;
  done: boolean;
}

/**
 * 扫描**一个文本块**，而不是让同一个 cursor 反复 `next()`。
 *
 * `cursor.next()` 会一直找到下一个匹配或文档结束才返回 —— 大文件里搜一个
 * 不存在的词，单次调用就会同步扫完全文，外层再怎么算时间预算也打断不了。
 * 把查找范围限制在 `[from, to)` 之后，单次 `next()` 最多扫一个块。
 *
 * 跨块匹配靠 `overlapChars` 重叠覆盖：**长度超过重叠区的匹配会漏**，
 * 这是明确的取舍（默认 4 KiB，覆盖正常搜索词），不假装能处理任意正则。
 */
export function scanChunk(
  target: { state: EditorState },
  query: SearchQuery,
  position: number,
  options: {
    chunkChars?: number;
    overlapChars?: number;
    limit?: number;
    /** 已收录的最后一个匹配起点：重叠区里的重复匹配据此跳过。 */
    lastFrom?: number;
  } = {},
): ChunkScan {
  const chunkChars = options.chunkChars ?? 64 * 1024;
  const overlapChars = options.overlapChars ?? 4 * 1024;
  const limit = options.limit ?? MATCH_SCAN_LIMIT;
  let lastFrom = options.lastFrom ?? -1;

  const docLength = target.state.doc.length;
  const ranges: { from: number; to: number }[] = [];
  if (!query.valid) return { ranges, position: docLength, done: true };

  // **只扫一个块**。调用方按时间预算反复调用，这样 8ms 预算才真的能打断
  // 一篇超大文档的扫描（一次调用扫完所有块就等于没分块）。
  if (position >= docLength) return { ranges, position: docLength, done: true };

  const from = position === 0 ? 0 : position - overlapChars;
  const to = Math.min(position + chunkChars, docLength);
  const cursor = query.getCursor(target.state, from, to);
  for (;;) {
    const step = cursor.next();
    if (step.done) break;
    // 重叠区里的匹配上一块已经收过：按起点单调递增去重。
    if (step.value.from <= lastFrom) continue;
    ranges.push(step.value);
    lastFrom = step.value.from;
    if (ranges.length >= limit) break;
  }

  return {
    ranges,
    position: to,
    done: to >= docLength || ranges.length >= limit,
  };
}

/**
 * 当前查询的全部匹配区间（不限数量）。
 *
 * 保留给"必须拿到完整集合"的调用方（如替换前的统计）；搜索框走
 * [`scanMatches`]，避免在大文档上把主线程卡住。
 */
export function matchRanges(
  target: { state: EditorState },
  query: SearchQuery,
): { from: number; to: number }[] {
  return scanMatches(target, query, Number.POSITIVE_INFINITY).ranges;
}

/**
 * 当前光标落在第几个匹配上（0 基），`-1` 表示没有匹配。
 *
 * 精确命中优先（跳转后光标正好停在匹配起点）；否则取"第一个不早于光标"的
 * 匹配；光标已在全部匹配之后时回绕到第一个 —— 与 VSCode 的计数行为一致。
 */
export function activeMatchIndex(
  target: { state: EditorState },
  ranges: { from: number; to: number }[],
  /** 传入时：`ranges` 只是**前若干个**匹配，光标可能落在扫描范围之外。 */
  truncated = false,
): number {
  if (ranges.length === 0) return -1;
  const cursor = target.state.selection.main.from;
  const exact = ranges.findIndex((range) => range.from === cursor);
  if (exact >= 0) return exact;
  const next = ranges.findIndex((range) => range.from > cursor);
  if (next >= 0) return next;
  // 没有更靠后的**已扫描**匹配。
  //
  // 如果结果被截断，光标后面可能还有匹配 —— 此时回绕到第 1 个会把
  // "第 2001 个" 误报成 "第 1 个"（真实存在的计数错误）。
  // 返回 `ranges.length` 表示"超出已扫描范围"，由调用方显示成 `N+`。
  return truncated ? ranges.length : 0;
}
