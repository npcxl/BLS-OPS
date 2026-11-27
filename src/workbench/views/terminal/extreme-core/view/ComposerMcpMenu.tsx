/**
 * 输入框底栏的「MCP · 已启用 N 项」：紧凑多选菜单。
 *
 * 勾选表示允许模型使用这类能力；具体操作仍然受任务权限（只读 / 按需 /
 * 完全）与审批约束。取消过的项写进会话存储，重连、重探、返回会话都保持。
 */
import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Plug } from "@/components/icons";
import { Checkbox } from "@/components/ui/input";
import { cn } from "@/lib/cn";
import { ComposerMenu } from "../ComposerMenu";
import type { McpCapabilityRow, McpCapabilityState } from "./use-mcp-capabilities";

function statusText(row: McpCapabilityRow, t: (key: string, options?: Record<string, unknown>) => string): string {
  // 绑定不匹配优先解释清楚"绑在哪"，不要只说一句不可用。
  if (row.status === "bound-away") {
    return row.bindingTarget
      ? t("仅绑定在{{target}}", { target: row.bindingTarget })
      : t("绑定目标缺失");
  }
  if (row.kind === "builtin" && row.enabled && !row.available) {
    return t("已启用但暂不可用");
  }
  switch (row.status) {
    case "ready":
      return row.kind === "mcp"
        ? t("{{n}} 个工具", { n: row.toolCount ?? 0 })
        : t("可用");
    case "unavailable":
      return t("当前服务器不可用");
    case "disconnected":
      return t("未连接");
    case "off":
      return t("已停用");
    case "error":
      return t("连接失败");
    case "untested":
      return t("未测试");

    case "no-tools":
      return t("没有启用的工具");
    default:
      return "";
  }
}

function CapabilityRow({
  row,
  onToggle,
  onManage,
  onRetry,
  checkError,
  checking,
}: {
  row: McpCapabilityRow;
  onToggle: (on: boolean) => void;
  onManage: () => void;
  onRetry?: () => void;
  checkError?: string;
  checking?: boolean;
}) {
  const { t } = useTranslation();
  const status = statusText(row, t);
  const hasError = row.status === "error" || row.status === "no-tools" || Boolean(checkError);
  const dotClass = hasError
    ? "bg-warning"
    : row.status === "ready" && row.available
      ? "bg-success"
      : "bg-fg-subtle/40";
  return (
    <div
      /* 内置能力的说明是中文常量：走 t() 才能跟着语言切换。 */
      title={t(row.detail)}
      onClick={(event) => {
        if ((event.target as HTMLElement).closest("button,a,input,label")) return;
        onToggle(!row.enabled);
      }}
      className={cn(
        "group flex cursor-pointer items-start gap-2.5 rounded-[10px] px-2 py-1.5 transition-colors duration-150 hover:bg-fg/[0.045]",
        !row.available && "opacity-70",
      )}
    >
      <Checkbox
        className="mt-[3px] cursor-pointer"
        checked={row.enabled}
        data-testid={`mcp-cap-${row.id}`}
        onChange={(event) => onToggle(event.target.checked)}
      />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-1.5">
          <span
            className={cn(
              "truncate text-12 font-medium transition-colors duration-150",
              row.enabled ? "text-fg" : "text-fg-muted group-hover:text-fg",
            )}
          >
            {t(row.name)}
          </span>
          <span className="rounded-full bg-fg/[0.05] px-1.5 py-0.5 text-[10px] leading-[14px] font-medium text-fg-subtle">
            {t(row.source)}
          </span>
        </div>
        <div
          className={cn(
            "mt-0.5 flex flex-wrap items-center gap-1.5 text-10",
            hasError ? "text-warning" : "text-fg-subtle",
          )}
        >
          <span aria-hidden="true" className={cn("size-1.5 shrink-0 rounded-full", dotClass)} />
          <span className="min-w-0 truncate">{checkError ? t("检测失败") : status}</span>
          {onRetry && (row.status === "error" || row.status === "no-tools" || row.status === "untested" || checkError) && (
            <button type="button" disabled={checking} className="shrink-0 text-accent hover:underline disabled:opacity-50" onClick={onRetry}>
              {checking ? t("检测中…") : t("重新检测")}
            </button>
          )}
          {row.canEditBinding && (
            <button
              type="button"
              className="shrink-0 text-accent hover:underline"
              data-testid={`mcp-fix-binding-${row.id}`}
              onClick={onManage}
            >
              {t("修改绑定")}
            </button>
          )}
        </div>
        {(checkError || (row.status === "error" && row.detail)) && (
          <p className="mt-1 break-words rounded-md bg-warning/[0.08] px-2 py-1 text-10 leading-4 text-fg-muted">
            {checkError || row.detail}
          </p>
        )}
      </div>
    </div>
  );
}

export function ComposerMcpMenu({
  state,
  onOpenMarket,
  onManage,
}: {
  state: McpCapabilityState;
  onOpenMarket: () => void;
  onManage: () => void;
}) {
  const { t } = useTranslation();
  const anchorRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const builtins = state.rows.filter((row) => row.kind === "builtin");
  const connections = state.rows.filter((row) => row.kind === "mcp");
  const problems = connections.filter((row) => row.status === "error" || row.status === "no-tools" || Boolean(state.checkErrors?.[row.id.replace(/^mcp:/, "")]));

  return (
    <>
      <button
        ref={anchorRef}
        type="button"
        data-testid="composer-mcp"
        aria-label={t("MCP 能力")}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className={cn(
          "flex h-6 shrink-0 items-center gap-1 rounded-full px-2 text-10 transition-colors duration-[120ms] ease-out focus-visible:outline-2 focus-visible:outline-accent",
          problems.length > 0
            ? "bg-warning/10 text-warning hover:bg-warning/15"
            : state.enabledCount > 0
            ? "bg-accent/10 text-accent hover:bg-accent/15"
            : "text-fg-subtle hover:bg-surface-hover hover:text-fg",
        )}
      >
        <Plug size={10} />
        <span className="shrink-0">MCP</span>
        <span className="shrink-0 tabular-nums">
          · {state.enabledCount > 0 ? t("已启用 {{n}} 项", { n: state.enabledCount }) : t("未启用")}
        </span>
        {problems.length > 0 && <span className="shrink-0" role="status">· {t("{{n}} 项异常", { n: problems.length })}</span>}
      </button>

      <ComposerMenu
        open={open}
        onClose={() => setOpen(false)}
        anchor={anchorRef.current}
        label={t("MCP 能力")}
        opaque
      >
        <div
          className="select-menu max-h-[320px] overflow-y-auto px-1 pb-1 pt-1"
          role="group"
          aria-label={t("MCP 能力")}
        >
          <div className="flex items-center justify-between px-2 pb-1 pt-0.5">
            <span className="text-[11px] font-medium text-fg-subtle">
              {t("内置运维技能")}
            </span>
            <span className="flex items-center gap-1.5">
              {state.probing && <span className="text-[10px] text-fg-subtle">{t("检查环境…")}</span>}
              <button
                type="button"
                className="rounded-md px-1.5 py-0.5 text-[11px] font-medium text-fg-subtle transition-colors hover:bg-fg/[0.06] hover:text-fg"
                onClick={() => state.refresh()}
              >
                {t("重新检测")}
              </button>
            </span>
          </div>
          {builtins.map((row) => (
            <CapabilityRow
              key={row.id}
              row={row}
              onToggle={(on) => state.toggle(row.id, on)}
              onManage={() => {
                setOpen(false);
                onManage();
              }}
            />
          ))}

          <div className="mt-1.5 flex items-center justify-between border-t border-line/60 px-2 pb-1 pt-2 text-[11px] font-medium text-fg-subtle">
            <span>{t("已连接 MCP")}</span>
            <button
              type="button"
              disabled={state.checkingMcp}
              className="rounded-md px-1.5 py-0.5 text-[11px] font-medium text-fg-subtle transition-colors hover:bg-fg/[0.06] hover:text-fg disabled:opacity-50"
              onClick={() => void state.checkMcp?.()}
            >
              {state.checkingMcp ? t("检测中…") : t("检测连接")}
            </button>
          </div>
          {state.serversLoading && (
            <p className="px-2 py-1.5 text-10 text-fg-subtle" data-testid="mcp-loading">
              {t("正在加载 MCP 连接…")}
            </p>
          )}
          {state.serversError && (
            <div className="flex flex-wrap items-center gap-2 px-2 py-1.5 text-10 text-warning">
              <span className="min-w-0 break-words">
                {t("MCP 连接读取失败：{{error}}", { error: state.serversError })}
              </span>
              <button
                type="button"
                className="text-accent hover:underline"
                onClick={() => state.refresh()}
              >
                {t("重试")}
              </button>
            </div>
          )}
          {!state.serversLoading && !state.serversError && connections.length === 0 ? (
            <p className="px-2 py-1.5 text-10 text-fg-subtle">
              {t("还没有连接。先从市场添加一个，或自定义远程 / 本地服务。")}
            </p>
          ) : (
            connections.map((row) => (
              <CapabilityRow
                key={row.id}
                row={row}
                onToggle={(on) => state.toggle(row.id, on)}
                onManage={() => {
                  setOpen(false);
                  onManage();
                }}
                checking={state.checkingMcp}
                checkError={state.checkErrors?.[row.id.replace(/^mcp:/, "")]}
                onRetry={() => void state.checkMcp?.(row.id.replace(/^mcp:/, ""))}
              />
            ))
          )}
        </div>
        <div className="flex items-center justify-between gap-2 border-t border-line/60 px-2 py-1.5">
          <button
            type="button"
            data-testid="mcp-open-market"
            className="rounded-lg px-2 py-1 text-11 font-medium text-fg-muted transition-colors hover:bg-fg/[0.06] hover:text-fg"
            onClick={() => {
              setOpen(false);
              onOpenMarket();
            }}
          >
            {t("打开 MCP 市场")}
          </button>
          <button
            type="button"
            data-testid="mcp-manage"
            className="rounded-lg px-2 py-1 text-11 font-medium text-fg-muted transition-colors hover:bg-fg/[0.06] hover:text-fg"
            onClick={() => {
              setOpen(false);
              onManage();
            }}
          >
            {t("管理连接")}
          </button>
        </div>
      </ComposerMenu>
    </>
  );
}
