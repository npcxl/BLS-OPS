import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  CaseSensitive,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  Replace,
  ReplaceAll,
  X,
} from "lucide-react";
import { cn } from "@/lib/cn";
import type { EditorView } from "@uiw/react-codemirror";
import {
  activeMatchIndex,
  applyQuery,
  buildQuery,
  clearQuery,
  gotoMatch,
  MATCH_SCAN_LIMIT,
  replaceMatch,
  scanChunk,
} from "@/lib/cm-search";

/**
 * VSCode 风格的编辑器内搜索框：右上角浮动，默认只有查找行，点左侧箭头才
 * 展开替换行。只读文档不显示替换（与 VSCode 一致：只读没有替换入口）。
 *
 * 交互与 VSCode 对齐：Enter 下一个、Shift+Enter 上一个、Esc 关闭、
 * Ctrl+H 展开/收起替换、Alt+Enter 全部替换。
 */
export function CodeSearchBox({
  view,
  readOnly = false,
  onClose,
}: {
  view: EditorView | null;
  readOnly?: boolean;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [replaceText, setReplaceText] = useState("");
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [total, setTotal] = useState(0);
  const [index, setIndex] = useState(-1);
  const inputRef = useRef<HTMLInputElement>(null);
  const { t } = useTranslation();

  const searchQuery = useMemo(() => buildQuery(query, caseSensitive), [query, caseSensitive]);

  /**
   * 已扫描出的匹配区间 + 扫描时的文档快照。
   *
   * 光标移动（按键、点击）**不重新扫描**：全文遍历是这里唯一的大开销，
   * 而"第几个匹配"只需要在已有区间里找位置。只有查询/选项变化，或文档
   * 真的被编辑过（CodeMirror 的 `Text` 不可变，换实例即变更），才重新扫。
   */
  const rangesRef = useRef<{ from: number; to: number }[]>([]);
  const scannedDocRef = useRef<unknown>(null);
  const composingRef = useRef(false);
  /** 分批扫描的代次：新查询 / 卸载都会递增，旧批次据此作废。 */
  const scanSeqRef = useRef(0);
  const [truncated, setTruncated] = useState(false);
  const [scanning, setScanning] = useState(false);

  /** 只同步"当前第几个匹配"，复用已扫描的区间。 */
  const syncIndex = useCallback(() => {
    if (!view) return;
    setIndex(activeMatchIndex(view, rangesRef.current, truncated));
  }, [view, truncated]);

  /**
   * 重新扫描全文：**按时间预算分批**。
   *
   * 数量上限（[`MATCH_SCAN_LIMIT`]）只防"命中太多"，防不住"没命中但文档极大"——
   * 那种情况下同步 `getCursor` 仍会一次扫完整篇。所以每批只算 8ms，然后
   * `setTimeout(0)` 让出主线程，直到扫完或到达数量上限。
   *
   * 新查询到来时 `seq` 递增，旧批次自行作废（不会越扫越积压）。
   */
  const recompute = useCallback(() => {
    if (!view) return;
    const seq = ++scanSeqRef.current;
    const snapshot = view.state;
    rangesRef.current = [];
    setTotal(0);
    setTruncated(false);
    if (!searchQuery.valid) {
      setScanning(false);
      scannedDocRef.current = snapshot.doc;
      setIndex(-1);
      return;
    }

    setScanning(true);

    // **按文本区间分块**，而不是"同一个 cursor 反复 next()"。
    //
    // 原因：`cursor.next()` 会一直找到下一个匹配**或文档结束**才返回。
    // 大文件里搜一个不存在的词，单次 `next()` 就会同步扫完全文 ——
    // 外面再怎么算 8ms 预算也打断不了它。
    //
    // `getCursor(state, from, to)` 把查找限制在块内，单次 `next()` 最多扫
    // 一个块（64 KiB），耗时可控。跨块匹配靠 **4 KiB 重叠**覆盖：
    // 搜索词加上下文超过 4 KiB 的极端情况会漏，这个限制写在注释里，
    // 不假装能处理任意长度的正则。
    const ranges = rangesRef.current;
    let position = 0;
    /** 已收录的最后一个匹配起点，用于重叠区去重。 */
    let lastFrom = -1;

    const step = () => {
      // 新查询 / 卸载：这一批直接作废，不写任何状态。
      if (seq !== scanSeqRef.current) return;
      const deadline = performance.now() + 8;
      let done = false;

      // 每轮最多算 8ms；每次 `scanChunk` 只碰一个 64 KiB 块，
      // 所以单次 `next()` 不会扫完整篇（零命中的大文件也不会）。
      while (!done && ranges.length < MATCH_SCAN_LIMIT) {
        if (performance.now() > deadline) break;
        const chunk = scanChunk({ state: snapshot }, searchQuery, position, { lastFrom });
        for (const range of chunk.ranges) ranges.push(range);
        if (chunk.ranges.length > 0) {
          lastFrom = chunk.ranges[chunk.ranges.length - 1].from;
        }
        position = chunk.position;
        done = chunk.done;
      }

      const hitLimit = ranges.length >= MATCH_SCAN_LIMIT;
      if (!done && !hitLimit) {
        // 还没扫完：先让已找到的结果可见，再让出主线程继续。
        setTotal(ranges.length);
        window.setTimeout(step, 0);
        return;
      }

      // 到了数量上限但文档还没扫完 → 结果只是下限。
      const cut = hitLimit;
      scannedDocRef.current = snapshot.doc;
      setTotal(ranges.length);
      setTruncated(cut);
      setIndex(activeMatchIndex(view, ranges, cut));
      setScanning(false);
    };
    step();
  }, [view, searchQuery]);

  // 卸载时作废在途扫描（`setTimeout` 链不会自己停）。
  useEffect(() => () => {
    scanSeqRef.current += 1;
  }, []);

  // 查询变化 → 写进编辑器并重新扫描。
  useEffect(() => {
    if (!view) return;
    applyQuery(view, searchQuery);
    // 输入法组合期间不扫全文：中文每个键都会改 query，扫了也没用，
    // 等 compositionend 再扫一次即可。
    if (composingRef.current) return;
    recompute();
  }, [view, searchQuery, recompute]);

  // 光标移动只更新序号；文档被编辑过才重新扫描。
  useEffect(() => {
    if (!view) return;
    const sync = () => {
      if (view.state.doc !== scannedDocRef.current) recompute();
      else syncIndex();
    };
    view.dom.addEventListener("keyup", sync);
    view.dom.addEventListener("mouseup", sync);
    return () => {
      view.dom.removeEventListener("keyup", sync);
      view.dom.removeEventListener("mouseup", sync);
    };
  }, [view, recompute, syncIndex]);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const step = useCallback(
    (backward: boolean) => {
      if (!view || total === 0) return;
      gotoMatch(view, backward);
      // 跳转只移动光标，区间没变 —— 不能为此重扫全文。
      syncIndex();
    },
    [view, total, syncIndex],
  );

  const replace = useCallback(
    (all: boolean) => {
      if (!view || readOnly || total === 0) return;
      // 替换动作要求查询自带 replace 文本。
      applyQuery(view, buildQuery(query, caseSensitive, replaceText));
      replaceMatch(view, all);
      // 替换改动了文档 → 必须重扫。
      recompute();
    },
    [view, readOnly, total, query, caseSensitive, replaceText, recompute],
  );

  const close = useCallback(() => {
    if (view) {
      clearQuery(view);
      view.focus();
    }
    onClose();
  }, [view, onClose]);

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === "Escape") {
      event.preventDefault();
      close();
    } else if (event.key === "Enter" && !event.altKey) {
      event.preventDefault();
      step(event.shiftKey);
    } else if (event.key === "Enter" && event.altKey) {
      event.preventDefault();
      replace(true);
    } else if (event.key.toLowerCase() === "h" && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      setExpanded((current) => !current);
    }
  };

  // 光标落在"已扫描范围之外"：不能再报一个具体序号（那是错的）。
  const beyondScan = truncated && index >= total;
  const counter = scanning
    ? // 还在分批扫描：不显示会跳动的半成品数字。
      "…"
    : total === 0
      ? query
        ? t("No results")
        : ""
      : beyondScan
        ? `${total}+/${total}+`
        : // 达到扫描上限时显示 `2000+`：这是下限，不能伪装成精确总数。
          `${(index >= 0 ? index : 0) + 1}/${total}${truncated ? "+" : ""}`;

  return (
    <div
      className="absolute right-2 top-2 z-30 w-[320px] overflow-hidden rounded-md border border-line bg-surface-1 shadow-[0_4px_16px_rgb(15_23_42/0.16)]"
      onKeyDown={onKeyDown}
      // 点击面板时不要让编辑器抢走焦点。
      onMouseDown={(event) => event.preventDefault()}
    >
      {/* 第一行：查找 */}
      <div className="flex items-center gap-1 p-1">
        {readOnly ? (
          <span className="h-7 w-7 shrink-0" />
        ) : (
          <button
            type="button"
            onClick={() => setExpanded((current) => !current)}
            title={expanded ? t("Collapse replace") : t("Expand replace (Ctrl+H)")}
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded text-fg-subtle transition-colors hover:bg-surface-hover hover:text-fg"
          >
            {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          </button>
        )}
        <input
          ref={inputRef}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          // 输入法组合期间不扫全文（见上面的 effect）；结束后补一次。
          onCompositionStart={() => {
            composingRef.current = true;
          }}
          onCompositionEnd={() => {
            composingRef.current = false;
            recompute();
          }}
          placeholder={t("Find")}
          spellCheck={false}
          className={cn(
            "h-7 min-w-0 flex-1 rounded border bg-surface-2 px-2 text-12 text-fg outline-none transition-colors placeholder:text-fg-subtle",
            query && total === 0 ? "border-danger/50" : "border-line focus:border-accent",
          )}
        />
        <button
          type="button"
          onClick={() => setCaseSensitive((current) => !current)}
          title={t("Match case")}
          className={cn(
            "flex h-7 w-7 shrink-0 items-center justify-center rounded transition-colors",
            caseSensitive
              ? "bg-accent/12 text-accent"
              : "text-fg-subtle hover:bg-surface-hover hover:text-fg",
          )}
        >
          <CaseSensitive size={14} />
        </button>
        {counter && (
          <span
            className={cn(
              "shrink-0 px-1 text-center text-11 tabular-nums",
              total === 0 ? "text-fg-subtle" : "text-fg-muted",
            )}
          >
            {counter}
          </span>
        )}
        <button
          type="button"
          onClick={() => step(true)}
          title={t("Previous (Shift+Enter)")}
          disabled={total === 0}
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded text-fg-subtle transition-colors hover:bg-surface-hover hover:text-fg disabled:opacity-40"
        >
          <ChevronUp size={14} />
        </button>
        <button
          type="button"
          onClick={() => step(false)}
          title={t("Next (Enter)")}
          disabled={total === 0}
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded text-fg-subtle transition-colors hover:bg-surface-hover hover:text-fg disabled:opacity-40"
        >
          <ChevronDown size={14} />
        </button>
        <button
          type="button"
          onClick={close}
          title={t("Close (Esc)")}
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded text-fg-subtle transition-colors hover:bg-surface-hover hover:text-fg"
        >
          <X size={14} />
        </button>
      </div>

      {/* 第二行：替换（仅展开且可编辑时） */}
      {expanded && !readOnly && (
        <div className="flex items-center gap-1 px-1 pb-1">
          <span className="h-7 w-7 shrink-0" />
          <input
            value={replaceText}
            onChange={(event) => setReplaceText(event.target.value)}
            placeholder={t("Replace")}
            spellCheck={false}
            className="h-7 min-w-0 flex-1 rounded border border-line bg-surface-2 px-2 text-12 text-fg outline-none transition-colors placeholder:text-fg-subtle focus:border-accent"
          />
          <button
            type="button"
            onClick={() => replace(false)}
            title={t("Replace (Enter replaces the current match)")}
            disabled={total === 0}
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded text-fg-subtle transition-colors hover:bg-surface-hover hover:text-fg disabled:opacity-40"
          >
            <Replace size={14} />
          </button>
          <button
            type="button"
            onClick={() => replace(true)}
            title={t("Replace all (Alt+Enter)")}
            disabled={total === 0}
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded text-fg-subtle transition-colors hover:bg-surface-hover hover:text-fg disabled:opacity-40"
          >
            <ReplaceAll size={14} />
          </button>
          <span className="w-7 shrink-0" />
        </div>
      )}
    </div>
  );
}
