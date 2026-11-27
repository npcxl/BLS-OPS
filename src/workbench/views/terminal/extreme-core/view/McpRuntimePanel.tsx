/**
 * MCP 本机运行环境：市场顶部状态条、诊断详情、单条命令探测结果。
 *
 * 状态由后端 `mcp_runtime_status` 统一给出（检测与启动共用同一套解析），
 * 这里只负责展示与"重新检测"入口，不猜安装路径、不执行任何命令。
 */
import { Loader2, RefreshCw } from "@/components/icons";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/cn";
import type {
  McpCommandProbe,
  McpRuntimeDetail,
  McpRuntimeId,
  McpRuntimeStatus,
} from "@/api/types/mcp";

/** 市场条目真正依赖的三类入口：uvx / npx / Docker。 */
const MARKET_RUNTIMES: McpRuntimeId[] = ["uvx", "npx", "docker"];

export function runtimeLabel(id: McpRuntimeId): string {
  switch (id) {
    case "uv":
      return "uv";
    case "uvx":
      return "uvx";
    case "node":
      return "Node.js";
    case "npx":
      return "npx";
    default:
      return "Docker";
  }
}

/** 用户可见的短状态；"unknown" 必须是"未确认"，不能写成已安装/未安装。 */
export function runtimeStatusLabel(
  status: McpRuntimeStatus,
  t: (key: string) => string,
): string {
  switch (status) {
    case "ready":
      return t("已就绪");
    case "missing":
      return t("未安装");
    case "unavailable":
      return t("无法运行");
    case "not_running":
      return t("服务未启动");
    default:
      return t("未确认");
  }
}

function toneClass(status: McpRuntimeStatus): string {
  switch (status) {
    case "ready":
      return "text-fg-subtle";
    case "missing":
    case "not_running":
    case "unavailable":
      return "text-warning";
    default:
      return "text-fg-subtle";
  }
}

function dotClass(status: McpRuntimeStatus): string {
  switch (status) {
    case "ready":
      return "bg-accent";
    case "missing":
    case "not_running":
    case "unavailable":
      return "bg-warning";
    default:
      return "bg-fg-subtle/50";
  }
}

/** 运行环境是否阻止"添加"：只有确定不可用才拦，`unknown` 允许用户自行尝试。 */
export function runtimeBlocksAdd(status: McpRuntimeStatus | null | undefined): boolean {
  return status === "missing" || status === "unavailable" || status === "not_running";
}

export function RuntimeDiagnostics({ details }: { details: McpRuntimeDetail[] }) {
  const { t } = useTranslation();
  if (details.length === 0) {
    return <p className="mt-1 text-10 text-fg-subtle">{t("暂无诊断信息")}</p>;
  }
  return (
    <div className="mt-1 space-y-1.5" data-testid="mcp-runtime-diagnostics">
      {details.map((item) => (
        <div key={item.id} className="text-10 leading-4">
          <p className="break-all text-fg-muted">
            <span className="text-fg">{item.label}</span>
            {" · "}
            <span className={toneClass(item.status)}>{runtimeStatusLabel(item.status, t)}</span>
            {item.version ? ` · ${item.version}` : ""}
            {item.path ? ` · ${item.path}` : ""}
          </p>
          {item.detail && <p className="break-all text-fg-subtle">{item.detail}</p>}
        </div>
      ))}
    </div>
  );
}

export function RuntimeStatusStrip({
  statuses,
  details,
  checking,
  error,
  onRecheck,
}: {
  statuses: Partial<Record<McpRuntimeId, McpRuntimeStatus>>;
  details: McpRuntimeDetail[];
  checking: boolean;
  error: string | null;
  onRecheck: () => void;
}) {
  const { t } = useTranslation();
  const problems = details.filter((item) => item.status !== "ready");
  const checked = details.length > 0;
  return (
    <section
      className="rounded-2xl border border-line/60 bg-surface-2 px-4 py-2.5 shadow-[0_2px_12px_rgb(0_0_0/0.04)]"
      data-testid="mcp-runtime-strip"
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-11">
        <span className="text-fg-subtle">{t("本地运行环境")}</span>
        {MARKET_RUNTIMES.map((id) => {
          const status = statuses[id] ?? "unknown";
          return (
            <span
              key={id}
              className="flex items-center gap-1 text-fg-muted"
              data-testid={`mcp-runtime-${id}`}
            >
              <span className={cn("size-1.5 rounded-full", dotClass(status))} aria-hidden />
              {runtimeLabel(id)}
              <span className={toneClass(status)}>{runtimeStatusLabel(status, t)}</span>
            </span>
          );
        })}
        <button
          type="button"
          className="ml-auto flex shrink-0 items-center gap-1 rounded-full px-2 py-1 text-10 text-accent hover:bg-accent/10 disabled:opacity-60"
          disabled={checking}
          onClick={onRecheck}
          data-testid="mcp-runtime-recheck"
        >
          {checking ? (
            <>
              <Loader2 size={11} className="animate-spin motion-reduce:animate-none" />
              {t("检测中…")}
            </>
          ) : (
            <>
              <RefreshCw size={11} />
              {t("重新检测")}
            </>
          )}
        </button>
      </div>
      {error && <p className="mt-1 break-words text-10 text-danger">{error}</p>}
      {!checked && !checking && !error && (
        <p className="mt-1 text-10 text-fg-subtle">
          {t("尚未检测本机运行环境；搜索或点「重新检测」后会显示最新状态。")}
        </p>
      )}
      {problems.length > 0 && (
        <details className="mt-1">
          <summary className="cursor-pointer select-none text-10 text-fg-subtle hover:text-fg">
            {t("诊断详情")}
          </summary>
          <RuntimeDiagnostics details={details} />
        </details>
      )}
    </section>
  );
}

/** 修复弹窗里的单条命令探测结果（自定义绝对路径也走这里）。 */
export function CommandProbeSummary({
  probe,
  checking,
  error,
}: {
  probe: McpCommandProbe | null;
  checking: boolean;
  error: string | null;
}) {
  const { t } = useTranslation();
  if (checking && !probe) {
    return (
      <p className="flex items-center gap-1.5 text-10 text-fg-subtle" role="status" aria-live="polite">
        <Loader2 size={11} className="animate-spin motion-reduce:animate-none" />
        {t("正在重新检测运行环境…")}
      </p>
    );
  }
  if (!probe) {
    return error ? (
      <p className="break-words text-10 text-danger">{error}</p>
    ) : (
      <p className="text-10 text-fg-subtle">{t("运行环境状态未确认")}</p>
    );
  }
  return (
    <div className="space-y-1" data-testid="mcp-command-probe">
      <p
        className={cn(
          "break-words text-10",
          probe.status === "ready" ? "text-accent" : "text-warning",
        )}
        role="status"
        aria-live="polite"
      >
        {probe.message}
      </p>
      {error && <p className="break-words text-10 text-danger">{error}</p>}
      <details>
        <summary className="cursor-pointer select-none text-10 text-fg-subtle hover:text-fg">
          {t("诊断详情")}
        </summary>
        <div className="mt-1 space-y-0.5 break-all text-10 leading-4 text-fg-subtle">
          <p>
            {t("检测命令：{{command}}", { command: probe.command })}
          </p>
          {probe.path && <p>{t("路径：{{path}}", { path: probe.path })}</p>}
          {probe.version && <p>{t("版本：{{version}}", { version: probe.version })}</p>}
          {probe.detail && <p>{probe.detail}</p>}
        </div>
      </details>
    </div>
  );
}
