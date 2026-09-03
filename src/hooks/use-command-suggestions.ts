import { useCallback, useEffect, useRef, useState } from "react";
import { opsApi, toErrorMessage, type CommandSearchHit } from "@/api/ops-api";

/**
 * 命令检索提示 —— `CommandCenterView`（独立输入框）与 `TerminalView`
 * （终端内联提示）**共用同一条链路**，保证两处行为与排序完全一致。
 *
 * 职责：120ms 防抖检索、丢弃过期响应、管理高亮项、清空提示、收藏切换的
 * 乐观更新。
 *
 * 关键设计：**检索不依赖服务器连接** —— 知识库是本地编目，"docker ps 是
 * 什么意思"不需要连上任何机器。连接状态只影响"能否执行"（由调用方的
 * `canExecute` 判定），不影响"能否检索"。
 */
export interface CommandSuggestionsOptions {
  /** 关闭时不检索并清空结果（终端进入 vim/top 等 alternate screen 时用）。 */
  enabled?: boolean;
  limit?: number;
  debounceMs?: number;
}

export interface CommandSuggestions {
  hits: CommandSearchHit[];
  activeIndex: number;
  setActiveIndex: (index: number) => void;
  searching: boolean;
  error: string | null;
  /** 清空提示（Enter 提交 / Ctrl+C / 失焦时调用）。 */
  clear: () => void;
  /** 收藏切换（乐观更新，失败回滚并报错）。 */
  toggleFavorite: (hit: CommandSearchHit) => void;
}

export function useCommandSuggestions(
  query: string,
  { enabled = true, limit = 12, debounceMs = 120 }: CommandSuggestionsOptions = {},
): CommandSuggestions {
  const [hits, setHits] = useState<CommandSearchHit[]>([]);
  const [activeIndex, setActiveIndex] = useState(0);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const seqRef = useRef(0);

  useEffect(() => {
    if (!enabled) {
      // 递增 seq 作废在途请求，避免旧响应覆盖"已清空"状态。
      seqRef.current += 1;
      setHits([]);
      setActiveIndex(0);
      setSearching(false);
      return;
    }
    const seq = ++seqRef.current;
    setSearching(true);
    const timer = window.setTimeout(() => {
      opsApi
        .commandSearch(query, limit)
        .then((result) => {
          if (seqRef.current !== seq) return; // 过期响应：丢弃
          setHits(result);
          setActiveIndex(0);
          setError(null);
        })
        .catch((cause) => {
          if (seqRef.current === seq) setError(toErrorMessage(cause));
        })
        .finally(() => {
          if (seqRef.current === seq) setSearching(false);
        });
    }, debounceMs);
    return () => window.clearTimeout(timer);
  }, [query, enabled, limit, debounceMs]);

  const clear = useCallback(() => {
    seqRef.current += 1;
    setHits([]);
    setActiveIndex(0);
    setSearching(false);
  }, []);

  const toggleFavorite = useCallback((hit: CommandSearchHit) => {
    const previous = hit.favorite;
    // 乐观更新：星级立刻响应，失败再回滚。
    setHits((current) =>
      current.map((item) => (item.id === hit.id ? { ...item, favorite: !previous } : item)),
    );
    opsApi.commandToggleFavorite(hit.id).catch((cause) => {
      setHits((current) =>
        current.map((item) => (item.id === hit.id ? { ...item, favorite: previous } : item)),
      );
      setError(toErrorMessage(cause));
    });
  }, []);

  return { hits, activeIndex, setActiveIndex, searching, error, clear, toggleFavorite };
}
