import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { NginxEnvironment } from "@/api/types/environment";
import type { CompletionContext, CompletionItem } from "./completion/types";
import { resolveCompletions } from "./completion/registry";
import {
  CompletionScheduler,
  DEFAULT_DEBOUNCE_MS,
} from "./completion/scheduler";

/**
 * 终端补全的 React 层。
 *
 * 只做三件事：把"当前行 + 光标 + cwd + 环境"打包成 `CompletionContext`，
 * 交给调度器（防抖 + 丢弃过期响应），把结果交给渲染层。**没有任何 if/else
 * 判断"这是 cd 还是 docker"** —— 那些都在 Provider 里。
 */

export interface TerminalCompletionOptions {
  sessionId: string;
  /** 当前正在输入的行。 */
  line: string;
  /** 光标在行内的偏移（终端里 = 已输入部分的末尾）。 */
  cursor: number;
  /** 关闭时不检索并清空结果（alternate screen、面板被用户关掉…）。 */
  enabled: boolean;
  cwd: string | null;
  home: string | null;
  environment?: NginxEnvironment | null;
  debounceMs?: number;
}

export interface TerminalCompletion {
  items: CompletionItem[];
  /** 面板底部说明（"没有匹配的远程目录" / 环境状态…）。 */
  notice: string | null;
  activeIndex: number;
  setActiveIndex: (index: number) => void;
  searching: boolean;
  /** 清空提示（提交命令 / Ctrl+C 时调用）。 */
  clear: () => void;
}

export function useTerminalCompletion(options: TerminalCompletionOptions): TerminalCompletion {
  const {
    sessionId,
    line,
    cursor,
    enabled,
    cwd,
    home,
    environment = null,
    debounceMs = DEFAULT_DEBOUNCE_MS,
  } = options;

  const [items, setItems] = useState<CompletionItem[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);
  const [searching, setSearching] = useState(false);
  const schedulerRef = useRef<CompletionScheduler | null>(null);

  const context = useMemo<CompletionContext>(
    () => ({
      line,
      cursor,
      sessionId,
      cwd,
      home,
      environment,
    }),
    [line, cursor, sessionId, cwd, home, environment],
  );

  useEffect(() => {
    if (!schedulerRef.current) {
      schedulerRef.current = new CompletionScheduler({
        debounceMs,
        run: (ctx) => resolveCompletions(ctx),
        onResult: (result) => {
          setItems(result.items);
          setNotice(result.notice ?? null);
          setActiveIndex(0);
          setSearching(false);
        },
      });
    }
    return () => {
      schedulerRef.current?.dispose();
      schedulerRef.current = null;
    };
    // 调度器只建一次；debounceMs 变化通过下面 request 传入的上下文生效。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const scheduler = schedulerRef.current;
    if (!scheduler) return;
    if (!enabled) {
      // 作废在途请求，避免旧响应覆盖"已清空"状态。
      scheduler.cancel();
      setItems([]);
      setNotice(null);
      setActiveIndex(0);
      setSearching(false);
      return;
    }
    setSearching(true);
    scheduler.request(context);
  }, [context, enabled]);

  // setState 是稳定的，这里可以安全地空依赖。
  const clear = useCallback(() => {
    schedulerRef.current?.cancel();
    setItems([]);
    setNotice(null);
    setActiveIndex(0);
    setSearching(false);
  }, []);

  return { items, notice, activeIndex, setActiveIndex, searching, clear };
}
