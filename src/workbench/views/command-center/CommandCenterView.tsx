import { useCallback, useEffect, useMemo, useState } from "react";
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
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { useCommandSession } from "@/hooks/use-command-session";
import { useCommandSuggestions } from "@/hooks/use-command-suggestions";
import type { WorkspaceTab } from "@/workbench/types";
import { ResultPanel } from "./ResultPanel";
import { ParamsDialog } from "./ParamsDialog";
import { buildArgs, needsParams } from "./complete";
import { executability } from "./executability";

/**
 * P4 命令智能中心。
 *
 * 输入 → 实时提示（与终端共用 `useCommandSuggestions`）→ 执行 →
 * 结构化视图 | 原始输出 双 Tab（原始输出永久保留）。
 *
 * 执行分级：只读直接执行；medium 弹确认（无参数走 ConfirmDialog，带参数走
 * ParamsDialog 的 danger 确认）；high/destructive 第一批不收录。
 */
export function CommandCenterView({ tab }: { tab: WorkspaceTab }) {
  const session = useCommandSession(tab);
  const [query, setQuery] = useState("");
  const [executing, setExecuting] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<CommandExecutionResult | null>(null);
  const [paramsTarget, setParamsTarget] = useState<CommandSearchHit | null>(null);
  /** 待确认的中风险命令（无参数，走 ConfirmDialog）。 */
  const [confirmTarget, setConfirmTarget] = useState<CommandSearchHit | null>(null);
  /** 服务器上真实存在的工具（command -v 探测）。 */
  const [installedTools, setInstalledTools] = useState<Set<string> | null>(null);

  // 检索不依赖连接：知识库是本地编目。
  const suggestions = useCommandSuggestions(query, { limit: 20 });
  const { hits, activeIndex, setActiveIndex, searching, clear: clearHits } = suggestions;
  const active = hits[activeIndex];

  // 工具探测：依赖"命中的工具集合"而非 hits 引用本身 —— 首屏 hits 为空时
  // 若直接探测会得到空集合，随后命中的 docker/nginx 会被误判成"未安装"。
  const requiredToolsKey = useMemo(
    () => [...new Set(hits.flatMap((hit) => hit.requires))].sort().join("|"),
    [hits],
  );
  const requiredTools = useMemo(
    () => (requiredToolsKey ? requiredToolsKey.split("|") : []),
    [requiredToolsKey],
  );

  useEffect(() => {
    if (!session.ready || !session.hasTarget || requiredTools.length === 0) return;
    let cancelled = false;
    opsApi
      .commandProbeTools(session.sessionId, requiredTools)
      .then((installed) => {
        if (!cancelled) setInstalledTools(new Set(installed));
      })
      .catch(() => {
        // 探测失败：置 null 表示"未知"，不置灰，交给后端硬校验。
        if (!cancelled) setInstalledTools(null);
      });
    return () => {
      cancelled = true;
    };
  }, [session.ready, session.hasTarget, session.sessionId, requiredTools]);

  const runExecution = useCallback(
    async (hit: CommandSearchHit, params = buildArgs(hit)) => {
      setExecuting(hit.id);
      setError(null);
      try {
        const execution = await opsApi.commandExecute(session.sessionId, hit.id, params);
        setResult(execution);
      } catch (cause) {
        setError(toErrorMessage(cause));
      } finally {
        setExecuting(null);
      }
    },
    [session.sessionId],
  );

  /** 请求执行：按风险与参数需求分派到对应确认路径。 */
  const requestExecute = useCallback(
    (hit: CommandSearchHit) => {
      if (executing) return;
      const state = executability(
        hit,
        session.phase === "connected",
        installedTools,
      );
      if (!state.ok) {
        setError(state.reason);
        return;
      }
      if (needsParams(hit)) {
        setParamsTarget(hit); // 带参数：参数弹窗本身即确认（medium 用 danger 按钮）。
        return;
      }
      if (hit.mutability !== "read") {
        setConfirmTarget(hit); // 无参数的中风险命令：必须先确认。
        return;
      }
      void runExecution(hit);
    },
    [executing, installedTools, runExecution, session.phase],
  );

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLInputElement>) => {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setActiveIndex(Math.min(activeIndex + 1, hits.length - 1));
      } else if (event.key === "ArrowUp") {
        event.preventDefault();
        setActiveIndex(Math.max(activeIndex - 1, 0));
      } else if (event.key === "Enter") {
        event.preventDefault();
        if (active) requestExecute(active);
      } else if (event.key === "Escape") {
        setQuery("");
        clearHits();
      }
    },
    [active, activeIndex, clearHits, hits.length, requestExecute, setActiveIndex],
  );

  const summary = useMemo(
    () => ({ favorites: hits.filter((hit) => hit.favorite).length }),
    [hits],
  );

  return (
    <div className="flex h-full min-h-0 flex-col gap-2 p-3">
      {/* 输入 + 提示：始终可用，不要求已连接服务器。 */}
      <div className="relative shrink-0">
        <div
          className={cn(
            "flex h-9 items-center gap-2 rounded-[9px] border bg-surface-1 px-2.5 transition-colors",
            active ? "border-accent" : "border-line",
          )}
        >
          <Search size={14} className="shrink-0 text-fg-subtle" />
          <input
            autoFocus
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={onKeyDown}
            placeholder="输入命令前缀或中文场景，如 docker p / 查看所有容器"
            spellCheck={false}
            className="h-full min-w-0 flex-1 bg-transparent text-12 text-fg outline-none placeholder:text-fg-subtle"
          />
          {searching && <Loader2 size={12} className="animate-spin text-fg-subtle" />}
          {query && !searching && (
            <span className="text-10 tabular-nums text-fg-subtle">{hits.length} 条</span>
          )}
        </div>

        {hits.length > 0 && (
          <div className="absolute inset-x-0 top-[calc(100%+4px)] z-30 max-h-[46vh] overflow-y-auto rounded-[10px] border border-line bg-surface-1 p-1 shadow-lg">
            {hits.map((hit, index) => {
              const state = executability(
                hit,
                session.phase === "connected",
                installedTools,
              );
              return (
                <button
                  key={hit.id}
                  type="button"
                  // 只移动高亮，不抢输入框焦点（↑↓ 继续可用）。
                  onMouseEnter={() => setActiveIndex(index)}
                  onClick={() => requestExecute(hit)}
                  className={cn(
                    "flex w-full flex-col gap-0.5 rounded-[7px] px-2.5 py-1.5 text-left transition-colors",
                    index === activeIndex ? "bg-accent/10" : "hover:bg-surface-hover",
                    !state.ok && "opacity-60",
                  )}
                >
                  <span className="flex items-center gap-1.5">
                    <code className={cn("text-12", state.ok ? "text-fg" : "text-fg-subtle")}>
                      {hit.syntax}
                    </code>
                    <span className={cn("rounded px-1 py-0.5 text-9", RISK_META[hit.risk].tone)}>
                      {RISK_META[hit.risk].label}
                    </span>
                    {!state.ok && (
                      <span className="rounded bg-surface-3 px-1 py-0.5 text-9 text-fg-subtle">
                        {state.reason}
                      </span>
                    )}
                    <span
                      role="button"
                      tabIndex={-1}
                      className="ml-auto rounded p-0.5 hover:bg-surface-hover"
                      onClick={(event) => {
                        event.stopPropagation();
                        suggestions.toggleFavorite(hit);
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
              {session.phase !== "connected" && " · 未连接服务器，命令可查但暂不可执行"}
            </div>
          </div>
        )}
      </div>

      {session.hasTarget && session.phase !== "connected" && (
        <p className="shrink-0 text-11 text-warning">
          {session.phase === "connecting"
            ? "正在连接服务器…（知识检索不受影响）"
            : `连接不可用：${session.error ?? "请从左侧选择服务器"}（知识检索不受影响）`}
        </p>
      )}
      {error && <p className="shrink-0 text-11 text-danger">{error}</p>}
      {suggestions.error && <p className="shrink-0 text-11 text-danger">{suggestions.error}</p>}

      {/* 结果：结构化 | 原始输出 */}
      <div className="min-h-0 flex-1">
        {executing && (
          <div className="flex h-full items-center justify-center gap-2 text-12 text-fg-subtle">
            <Loader2 size={14} className="animate-spin" />
            正在执行 {executing}…
          </div>
        )}
        {!executing &&
          (result ? (
            <ResultPanel result={result} />
          ) : (
            <ModuleEmpty
              icon={session.hasTarget ? Search : TerminalSquare}
              title="还没有执行结果"
              hint={
                session.hasTarget
                  ? "从上方提示中选择一条命令执行；只读命令立即返回，修改类命令会先确认。每次执行的原始输出都会保留在这里。"
                  : "当前未选择服务器，命令知识仍可检索（输入 docker p 或中文场景试试）。选择左侧服务器后即可执行并查看结构化结果。"
              }
            />
          ))}
      </div>

      {paramsTarget && (
        <ParamsDialog
          hit={paramsTarget}
          onCancel={() => setParamsTarget(null)}
          onSubmit={(params) => {
            const target = paramsTarget;
            setParamsTarget(null);
            if (target) void runExecution(target, params);
          }}
        />
      )}

      {confirmTarget && (
        <ConfirmDialog
          open
          danger
          title={`确认执行「${confirmTarget.title}」`}
          description={`该命令会修改服务器状态（${confirmTarget.syntax}）。执行后会记录在审计日志中，请确认影响范围。`}
          confirmLabel="确认执行"
          onCancel={() => setConfirmTarget(null)}
          onConfirm={() => {
            const target = confirmTarget;
            setConfirmTarget(null);
            if (target) void runExecution(target);
          }}
        />
      )}
    </div>
  );
}
