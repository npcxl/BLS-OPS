import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Loader2, Search, Star, TerminalSquare } from "lucide-react";
import { cn } from "@/lib/cn";
import { ModuleEmpty } from "@/workbench/views/module-frame";
import {
  opsApi,
  toErrorMessage,
  RISK_META,
  type CommandExecutionResult,
  type CommandSearchHit,
} from "@/api/ops-api";
import { useCommandSession } from "@/hooks/use-command-session";
import type { WorkspaceTab } from "@/workbench/types";
import { ResultPanel } from "./ResultPanel";
import { ParamsDialog } from "./ParamsDialog";
import { buildArgs, needsParams } from "./params";

/**
 * P4 命令智能中心（P4.2/P4.3 第一个可见版本）。
 *
 * 输入 → 实时提示（前缀 / 中文别名 / 场景 / 模糊 + 收藏使用加权）→
 * 执行 → 结构化视图 | 原始输出 双 Tab（原始输出永久保留）。
 * 只读命令直接执行；medium（restart 等）先弹确认；删除类第一批不存在。
 */
export function CommandCenterView({ tab }: { tab: WorkspaceTab }) {
  const session = useCommandSession(tab);
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<CommandSearchHit[]>([]);
  const [activeIndex, setActiveIndex] = useState(0);
  const [searching, setSearching] = useState(false);
  const [executing, setExecuting] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<CommandExecutionResult | null>(null);
  const [paramsTarget, setParamsTarget] = useState<CommandSearchHit | null>(null);
  /** 服务器上真实存在的工具（command -v 探测一次），用于置灰不可用命令。 */
  const [installedTools, setInstalledTools] = useState<Set<string> | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const searchSeq = useRef(0);

  // 会话就绪后探测一次知识库涉及的全部工具（去重，≤24 个）。
  useEffect(() => {
    if (!session.ready || !session.hasTarget) return;
    const tools = [...new Set(hits.flatMap((hit) => hit.requires))].slice(0, 24);
    if (tools.length === 0) {
      setInstalledTools(new Set());
      return;
    }
    let cancelled = false;
    opsApi
      .commandProbeTools(session.sessionId, tools)
      .then((installed) => {
        if (!cancelled) setInstalledTools(new Set(installed));
      })
      .catch(() => {
        // 探测失败不阻塞使用：执行时后端还有硬校验兜底。
        if (!cancelled) setInstalledTools(null);
      });
    return () => {
      cancelled = true;
    };
    // hits 的 requires 只随知识库变化，取首次加载结果即可。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.ready, session.hasTarget, session.sessionId]);

  // 输入即提示（防抖 120ms；空查询返回收藏 + 最近使用）。
  useEffect(() => {
    if (!session.ready) return;
    const seq = ++searchSeq.current;
    setSearching(true);
    const timer = window.setTimeout(() => {
      opsApi
        .commandSearch(query, 20)
        .then((hits) => {
          if (searchSeq.current !== seq) return;
          setHits(hits);
          setActiveIndex(0);
          setError(null);
        })
        .catch((cause) => {
          if (searchSeq.current === seq) setError(toErrorMessage(cause));
        })
        .finally(() => {
          if (searchSeq.current === seq) setSearching(false);
        });
    }, 120);
    return () => window.clearTimeout(timer);
  }, [query, session.ready]);

  const active = hits[activeIndex];

  const toggleFavorite = useCallback(async (hit: CommandSearchHit) => {
    try {
      const favorite = await opsApi.commandToggleFavorite(hit.id);
      setHits((current) =>
        current.map((item) => (item.id === hit.id ? { ...item, favorite } : item)),
      );
    } catch (cause) {
      setError(toErrorMessage(cause));
    }
  }, []);

  const execute = useCallback(
    async (hit: CommandSearchHit) => {
      if (!session.ready || executing) return;
      // 需要参数的命令先弹参数编辑器（docker logs <容器> 等）。
      if (needsParams(hit)) {
        setParamsTarget(hit);
        return;
      }
      setExecuting(hit.id);
      setError(null);
      try {
        const execution = await opsApi.commandExecute(
          session.sessionId,
          hit.id,
          buildArgs(hit),
        );
        setResult(execution);
      } catch (cause) {
        setError(toErrorMessage(cause));
      } finally {
        setExecuting(null);
      }
    },
    [executing, session.ready, session.sessionId],
  );

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLInputElement>) => {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setActiveIndex((index) => Math.min(index + 1, hits.length - 1));
      } else if (event.key === "ArrowUp") {
        event.preventDefault();
        setActiveIndex((index) => Math.max(index - 1, 0));
      } else if (event.key === "Enter") {
        event.preventDefault();
        if (!active) return;
        const missing =
          installedTools === null
            ? []
            : active.requires.filter((tool) => !installedTools.has(tool));
        if (!active.can_execute || missing.length > 0) {
          setError(
            missing.length > 0
              ? `服务器未安装 ${missing.join("、")}，无法执行该命令`
              : "该命令仅展示知识，不提供执行",
          );
          return;
        }
        void execute(active);
      } else if (event.key === "Escape") {
        setQuery("");
      }
    },
    [active, execute, hits.length, installedTools],
  );

  const summary = useMemo(
    () => ({
      favorites: hits.filter((hit) => hit.favorite).length,
      executable: hits.filter((hit) => hit.can_execute).length,
    }),
    [hits],
  );

  return (
    <div className="flex h-full min-h-0 flex-col gap-2 p-3">
      {!session.hasTarget ? (
        <ModuleEmpty
          icon={TerminalSquare}
          title="命令智能中心"
          hint="从左侧服务器列表选择一台服务器开始。输入命令前缀（docker p）或中文场景（查看所有容器）即可获得可执行命令提示；只读命令直接执行，修改类命令需要确认。"
        />
      ) : (
        <>
          {/* 输入 + 提示 */}
          <div className="relative shrink-0">
            <div
              className={cn(
                "flex h-9 items-center gap-2 rounded-[9px] border bg-surface-1 px-2.5 transition-colors",
                active ? "border-accent" : "border-line",
              )}
            >
              <Search size={14} className="shrink-0 text-fg-subtle" />
              <input
                ref={inputRef}
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                onKeyDown={onKeyDown}
                placeholder={session.ready ? "输入命令前缀或中文场景，如 docker p / 查看所有容器" : "等待连接…"}
                disabled={!session.ready}
                spellCheck={false}
                className="h-full min-w-0 flex-1 bg-transparent text-12 text-fg outline-none placeholder:text-fg-subtle"
              />
              {searching && <Loader2 size={12} className="animate-spin text-fg-subtle" />}
              {query && !searching && (
                <span className="text-10 tabular-nums text-fg-subtle">{hits.length} 条</span>
              )}
            </div>

            {session.ready && hits.length > 0 && (
              <div className="absolute inset-x-0 top-[calc(100%+4px)] z-30 max-h-[46vh] overflow-y-auto rounded-[10px] border border-line bg-surface-1 p-1 shadow-lg">
                {hits.map((hit, index) => {
                  // 服务器上下文：需要未安装工具的命令置灰并解释原因；
                  // 探测失败（installedTools=null）时不置灰，交给后端硬校验。
                  const missing =
                    installedTools === null
                      ? []
                      : hit.requires.filter((tool) => !installedTools.has(tool));
                  const unavailable = !hit.can_execute || missing.length > 0;
                  return (
                    <button
                      key={hit.id}
                      type="button"
                      // 移动高亮即可，不抢输入框焦点（↑↓ 继续）。
                      onMouseEnter={() => setActiveIndex(index)}
                      onClick={() => {
                        if (unavailable) {
                          setError(
                            missing.length > 0
                              ? `服务器未安装 ${missing.join("、")}，无法执行该命令`
                              : "该命令仅展示知识，不提供执行",
                          );
                          return;
                        }
                        void execute(hit);
                      }}
                      className={cn(
                        "flex w-full flex-col gap-0.5 rounded-[7px] px-2.5 py-1.5 text-left transition-colors",
                        index === activeIndex ? "bg-accent/10" : "hover:bg-surface-hover",
                        unavailable && "opacity-60",
                      )}
                    >
                      <span className="flex items-center gap-1.5">
                        <code className={cn("text-12", unavailable ? "text-fg-subtle" : "text-fg")}>
                          {hit.syntax}
                        </code>
                        <span
                          className={cn(
                            "rounded px-1 py-0.5 text-9",
                            RISK_META[hit.risk].tone,
                          )}
                        >
                          {RISK_META[hit.risk].label}
                        </span>
                        {!hit.can_execute && (
                          <span className="rounded bg-surface-3 px-1 py-0.5 text-9 text-fg-subtle">
                            仅展示
                          </span>
                        )}
                        {missing.length > 0 && (
                          <span
                            className="rounded bg-warning/12 px-1 py-0.5 text-9 text-warning"
                            title={`command -v 未找到：${missing.join(", ")}`}
                          >
                            服务器未安装 {missing.join("/")}
                          </span>
                        )}
                        {!unavailable && hit.requires.length > 0 && (
                          <span className="text-9 text-fg-subtle">需 {hit.requires.join("/")}</span>
                        )}
                        <span
                          role="button"
                          tabIndex={-1}
                          className="ml-auto rounded p-0.5 hover:bg-surface-hover"
                          onClick={(event) => {
                            event.stopPropagation();
                            void toggleFavorite(hit);
                          }}
                          title={hit.favorite ? "取消收藏" : "收藏"}
                        >
                          <Star
                            size={11}
                            className={hit.favorite ? "fill-warning text-warning" : "text-fg-subtle"}
                          />
                        </span>
                      </span>
                      <span className="truncate text-10 text-fg-subtle">
                        {hit.title} · {hit.description}
                      </span>
                    </button>
                  );
                })}
                <div className="border-t border-line px-2.5 py-1 text-9 text-fg-subtle">
                  ↑↓ 选择 · Enter 执行 · Esc 清空
                  {summary.favorites > 0 && ` · 收藏 ${summary.favorites}`}
                </div>
              </div>
            )}
          </div>

          {session.phase !== "connected" && (
            <p className="shrink-0 text-11 text-warning">
              {session.phase === "connecting" ? "正在连接服务器…" : `连接不可用：${session.error ?? "请从左侧选择服务器"}`}
            </p>
          )}
          {error && <p className="shrink-0 text-11 text-danger">{error}</p>}

          {/* 结果：结构化 | 原始输出 */}
          <div className="min-h-0 flex-1">
            {executing && (
              <div className="flex h-full items-center justify-center gap-2 text-12 text-fg-subtle">
                <Loader2 size={14} className="animate-spin" />
                正在执行 {executing}…
              </div>
            )}
            {!executing && (result ? (
              <ResultPanel result={result} />
            ) : (
              <ModuleEmpty
                icon={Search}
                title="还没有执行结果"
                hint="从上方提示中选择一条命令执行；只读命令立即返回，修改类命令会先确认。每次执行的原始输出都会保留在这里。"
              />
            ))}
          </div>
        </>
      )}

      {paramsTarget && (
        <ParamsDialog
          hit={paramsTarget}
          onCancel={() => setParamsTarget(null)}
          onSubmit={(params) => {
            const target = paramsTarget;
            setParamsTarget(null);
            if (!target) return;
            setExecuting(target.id);
            opsApi
              .commandExecute(session.sessionId, target.id, params)
              .then(setResult)
              .catch((cause) => setError(toErrorMessage(cause)))
              .finally(() => setExecuting(null));
          }}
        />
      )}
    </div>
  );
}
