/**
 * CodeMirror 搜索：自定义查找/替换面板（替换 @codemirror/search 的默认
 * 原生样式面板）。
 *
 * - Ctrl+F（searchKeymap）打开本面板：`search({ createPanel })` 只是替换
 *   面板 DOM，快捷键与高亮匹配仍走官方实现；
 * - Enter / Shift+Enter 在匹配间跳转，Esc 关闭；
 * - 实时匹配计数；只读文档自动隐藏替换行；
 * - 样式走设计令牌（tokens.css），深浅色跟随主题。
 */
import type { EditorView } from "@uiw/react-codemirror";
import {
  closeSearchPanel,
  findNext,
  findPrevious,
  replaceAll,
  replaceNext,
  search,
  SearchQuery,
  setSearchQuery,
} from "@codemirror/search";

/** 打开搜索面板（供工具栏"搜索 Ctrl+F"按钮调用）。 */
export { closeSearchPanel, openSearchPanel } from "@codemirror/search";
import { openSearchPanel } from "@codemirror/search";

/** 便捷打开：视图未就绪时静默忽略。 */
export function openOpsSearch(view: EditorView | null | undefined): void {
  if (view) openSearchPanel(view);
}

/** 自定义搜索面板扩展。加入 extensions 后，Ctrl+F 打开的是本面板。 */
export function opsSearch() {
  return search({ createPanel: createOpsSearchPanel });
}

const MATCH_LIMIT = 999;

/** 统计 `needle` 在 `haystack` 中的出现次数；超过 `limit` 时 `[true, limit]` 提前返回。 */
function countOccurrences(
  haystack: string,
  needle: string,
  caseSensitive: boolean,
  limit: number,
): [boolean, number] {
  const h = caseSensitive ? haystack : haystack.toLowerCase();
  const n = caseSensitive ? needle : needle.toLowerCase();
  let count = 0;
  let index = 0;
  while ((index = h.indexOf(n, index)) !== -1) {
    count += 1;
    if (count > limit) return [true, limit];
    index += n.length || 1;
  }
  return [false, count];
}

function createOpsSearchPanel(view: EditorView): { dom: HTMLDivElement; top: boolean } {
  const dom = document.createElement("div");
  dom.className = "cm-ops-panel";

  // ---- 第一行：查找 ----
  const row1 = document.createElement("div");
  row1.className = "cm-ops-row";

  const findInput = document.createElement("input");
  findInput.className = "cm-ops-field cm-ops-field-find";
  findInput.name = "search";
  findInput.placeholder = "查找（Enter 下一个 · Shift+Enter 上一个）";
  findInput.spellcheck = false;
  findInput.setAttribute("main-field", "true");

  const caseBtn = document.createElement("button");
  caseBtn.type = "button";
  caseBtn.className = "cm-ops-btn";
  caseBtn.textContent = "Aa";
  caseBtn.title = "区分大小写";

  const count = document.createElement("span");
  count.className = "cm-ops-count";

  const prevBtn = document.createElement("button");
  prevBtn.type = "button";
  prevBtn.className = "cm-ops-btn";
  prevBtn.textContent = "↑";
  prevBtn.title = "上一个（Shift+Enter）";

  const nextBtn = document.createElement("button");
  nextBtn.type = "button";
  nextBtn.className = "cm-ops-btn";
  nextBtn.textContent = "↓";
  nextBtn.title = "下一个（Enter）";

  const closeBtn = document.createElement("button");
  closeBtn.type = "button";
  closeBtn.className = "cm-ops-btn";
  closeBtn.textContent = "✕";
  closeBtn.title = "关闭（Esc）";

  row1.append(findInput, caseBtn, count, prevBtn, nextBtn, closeBtn);

  // ---- 第二行：替换（只读文档隐藏）----
  let replaceRow: HTMLDivElement | null = null;
  let replaceInput: HTMLInputElement | null = null;
  if (!view.state.readOnly) {
    replaceRow = document.createElement("div");
    replaceRow.className = "cm-ops-row";

    replaceInput = document.createElement("input");
    replaceInput.className = "cm-ops-field cm-ops-field-replace";
    replaceInput.name = "replace";
    replaceInput.placeholder = "替换为";
    replaceInput.spellcheck = false;

    const replaceBtn = document.createElement("button");
    replaceBtn.type = "button";
    replaceBtn.className = "cm-ops-btn cm-ops-btn-wide";
    replaceBtn.textContent = "替换";
    replaceBtn.title = "替换当前匹配（Ctrl+Shift+H）";

    const replaceAllBtn = document.createElement("button");
    replaceAllBtn.type = "button";
    replaceAllBtn.className = "cm-ops-btn cm-ops-btn-wide";
    replaceAllBtn.textContent = "全部替换";
    replaceAllBtn.title = "替换全部匹配";

    replaceRow.append(replaceInput, replaceBtn, replaceAllBtn);
    dom.append(row1, replaceRow);
  } else {
    dom.append(row1);
  }

  let caseSensitive = false;

  const buildQuery = (withReplace: boolean): SearchQuery =>
    new SearchQuery({
      search: findInput.value,
      caseSensitive,
      replace: withReplace && replaceInput ? replaceInput.value : undefined,
    });

  // 匹配计数：对全文做纯字符串扫描（大小写按当前开关），封顶显示 999+。
  const refreshCount = () => {
    const needle = findInput.value;
    if (!needle) {
      count.textContent = "";
      return;
    }
    const haystack = view.state.doc.toString();
    const [overflow, total] = countOccurrences(haystack, needle, caseSensitive, MATCH_LIMIT);
    count.textContent = overflow ? `${MATCH_LIMIT}+ 个匹配` : `${total} 个匹配`;
  };

  const pushQuery = (withReplace: boolean) => {
    view.dispatch({ effects: setSearchQuery.of(buildQuery(withReplace)) });
    refreshCount();
  };

  const jump = (backward: boolean) => {
    pushQuery(false);
    (backward ? findPrevious : findNext)(view);
  };

  // ---- 事件 ----
  findInput.addEventListener("input", () => pushQuery(false));
  caseBtn.addEventListener("click", () => {
    caseSensitive = !caseSensitive;
    caseBtn.dataset.active = String(caseSensitive);
    pushQuery(false);
    findInput.focus();
  });
  prevBtn.addEventListener("click", () => jump(true));
  nextBtn.addEventListener("click", () => jump(false));
  closeBtn.addEventListener("click", () => closeSearchPanel(view));
  if (replaceRow && replaceInput) {
    replaceInput.addEventListener("input", () => pushQuery(true));
    const replaceBtn = replaceRow.children[1] as HTMLButtonElement;
    const replaceAllBtn = replaceRow.children[2] as HTMLButtonElement;
    replaceBtn.addEventListener("click", () => {
      pushQuery(true);
      replaceNext(view);
      refreshCount();
    });
    replaceAllBtn.addEventListener("click", () => {
      pushQuery(true);
      replaceAll(view);
      refreshCount();
    });
  }
  for (const input of [findInput, replaceInput]) {
    input?.addEventListener("keydown", (event) => {
      const key = event.key;
      if (key === "Enter") {
        event.preventDefault();
        jump(event.shiftKey);
      } else if (key === "Escape") {
        event.preventDefault();
        closeSearchPanel(view);
      }
    });
  }

  // 打开即以当前选中文本作为查找词（与主流编辑器一致）。
  const selection = view.state.sliceDoc(
    view.state.selection.main.from,
    view.state.selection.main.to,
  );
  if (selection && selection.length <= 200 && !selection.includes("\n")) {
    findInput.value = selection;
    pushQuery(false);
  }

  return { dom, top: true };
}
