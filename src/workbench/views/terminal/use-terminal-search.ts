import { useCallback, useState } from "react";
import type { Terminal } from "@xterm/xterm";

export interface TerminalSearch {
  open: boolean;
  setOpen: (value: boolean | ((current: boolean) => boolean)) => void;
  query: string;
  setQuery: (value: string) => void;
  state: { index: number; total: number } | null;
  run: () => void;
}

/**
 * 回滚缓冲内查找（xterm 自带插件不可用：这里只查已渲染的 buffer）。
 *
 * 匹配行是**整行包含**计数，`run()` 每次从上次命中的序号往后走一格 ——
 * 重复回车依次跳到下一个匹配处（与常见终端 Ctrl+F 一致）。
 */
export function useTerminalSearch(terminalRef: React.RefObject<Terminal | null>): TerminalSearch {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [state, setState] = useState<{ index: number; total: number } | null>(null);

  const run = useCallback(() => {
    const instance = terminalRef.current;
    if (!instance || !query.trim()) {
      setState(null);
      return;
    }
    const needle = query.toLowerCase();
    const buffer = instance.buffer.active;
    let total = 0;
    let firstLine: number | null = null;
    for (let i = 0; i < buffer.length; i += 1) {
      const text = buffer.getLine(i)?.translateToString(true).toLowerCase() ?? "";
      if (text.includes(needle)) {
        total += 1;
        firstLine ??= i;
      }
    }
    if (firstLine === null) {
      setState({ index: 0, total: 0 });
      return;
    }
    // Walk forward from the current position so repeated searches advance.
    const start = (state?.index ?? 0) % Math.max(total, 1);
    let seen = -1;
    let target = firstLine;
    for (let i = 0; i < buffer.length && seen < start; i += 1) {
      const text = buffer.getLine(i)?.translateToString(true).toLowerCase() ?? "";
      if (!text.includes(needle)) continue;
      seen += 1;
      target = i;
    }
    instance.scrollToLine(target);
    setState({ index: (seen + 1) % Math.max(total, 1), total });
  }, [query, state, terminalRef]);

  return { open, setOpen, query, setQuery, state, run };
}
