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
import type { EditorView } from "@uiw/react-codemirror";
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
 * 当前查询的全部匹配区间。
 *
 * `getCursor` 返回的是裸 `Iterator`（不带 `Symbol.iterator`），只能手动
 * `next()` —— 不要用 `for...of` / 展开运算符。
 */
export function matchRanges(view: EditorView, query: SearchQuery): { from: number; to: number }[] {
  if (!query.valid) return [];
  const ranges: { from: number; to: number }[] = [];
  const cursor = query.getCursor(view.state);
  for (let next = cursor.next(); !next.done; next = cursor.next()) {
    ranges.push(next.value);
  }
  return ranges;
}

/**
 * 当前光标落在第几个匹配上（0 基），`-1` 表示没有匹配。
 *
 * 精确命中优先（跳转后光标正好停在匹配起点）；否则取"第一个不早于光标"的
 * 匹配；光标已在全部匹配之后时回绕到第一个 —— 与 VSCode 的计数行为一致。
 */
export function activeMatchIndex(
  view: EditorView,
  ranges: { from: number; to: number }[],
): number {
  if (ranges.length === 0) return -1;
  const cursor = view.state.selection.main.from;
  const exact = ranges.findIndex((range) => range.from === cursor);
  if (exact >= 0) return exact;
  const next = ranges.findIndex((range) => range.from > cursor);
  return next >= 0 ? next : 0;
}
