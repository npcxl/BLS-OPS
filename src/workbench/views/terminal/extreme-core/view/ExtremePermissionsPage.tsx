/**
 * 超能模式 → 权限：操作权限（默认值 / 当前任务覆盖）与备份策略。
 *
 * 所有开关都立即落到本地配置；发起任务时随请求快照发给后端，由执行器
 * 真正校验（只读拦截 / 审批 / 备份失败取消），这里只管收集。
 */
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Check, Plug } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Select } from "@/components/ui/select";
import { cn } from "@/lib/cn";
import {
  effectivePermission,
  useExtremePermissionsStore,
} from "@/stores/extreme-permissions-store";
import { opsApi } from "@/api/ops-api";
import type { FileChangeSummary } from "@/api/types/agent";
import type { McpServerView } from "@/api/types/mcp";
import { bindingMatches } from "./use-mcp-capabilities";
import {
  BACKUP_RETENTION_OPTIONS,
  PERMISSION_HINT,
  type PermissionMode,
} from "../permissions";
import { ExtremePageShell } from "./ExtremePageShell";

const MODE_LABEL: Record<PermissionMode, string> = {
  readonly: "只读",
  ask: "按需确认",
  full: "完全访问",
};

function ModeCard({
  mode,
  selected,
  onSelect,
}: {
  mode: PermissionMode;
  selected: boolean;
  onSelect: () => void;
}) {
  const { t } = useTranslation();
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      onClick={onSelect}
      className={cn(
        "flex min-w-0 flex-1 flex-col gap-1 rounded-lg border px-3 py-2.5 text-left transition-colors duration-[120ms] ease-out focus-visible:outline-2 focus-visible:outline-accent",
        selected
          ? "border-accent/45 bg-accent/[0.07]"
          : "border-line/60 hover:bg-surface-hover",
      )}
    >
      <span className="flex items-center gap-1.5 text-12 font-medium text-fg">
        {selected && <Check size={12} className="text-accent" />}
        {t(MODE_LABEL[mode])}
      </span>
      <span className="text-10 leading-4 text-fg-subtle">{t(PERMISSION_HINT[mode])}</span>
    </button>
  );
}

function ToggleRow({
  title,
  description,
  checked,
  onChange,
}: {
  title: string;
  description: string;
  checked: boolean;
  onChange: (next: boolean) => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex items-start gap-3 border-t border-line/50 py-2.5 first:border-t-0">
      <div className="min-w-0 flex-1">
        <p className="text-12 text-fg">{t(title)}</p>
        <p className="mt-0.5 text-10 leading-4 text-fg-subtle">{t(description)}</p>
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={t(title)}
        onClick={() => onChange(!checked)}
        className={cn(
          "relative mt-0.5 h-5 w-9 shrink-0 rounded-full transition-colors duration-[140ms] ease-out focus-visible:outline-2 focus-visible:outline-accent",
          checked ? "bg-accent/80" : "bg-surface-active",
        )}
      >
        <span
          className={cn(
            "absolute top-0.5 size-4 rounded-full bg-surface-1 shadow-sm transition-[left] duration-[140ms] ease-out",
            checked ? "left-[18px]" : "left-0.5",
          )}
        />
      </button>
    </div>
  );
}

export function ExtremePermissionsPage({
  workspaceId,
  workspaceTitle,
  serverId,
  onBack,
  onManageMcp,
  onRestoreBackup,
}: {
  workspaceId: string | null;
  workspaceTitle?: string;
  serverId: string | null;
  onBack: () => void;
  onManageMcp: () => void;
  /** 还原交给 Agent 走同一套权限 / 审批 / 备份与变更登记。 */
  onRestoreBackup: (backupPath: string, originalPath: string) => void;
}) {
  const { t } = useTranslation();
  const defaultMode = useExtremePermissionsStore((state) => state.defaultMode);
  const byWorkspace = useExtremePermissionsStore((state) => state.byWorkspace);
  const backup = useExtremePermissionsStore((state) => state.backup);
  const allowSudo = useExtremePermissionsStore((state) => state.allowSudo);
  const setDefaultMode = useExtremePermissionsStore((state) => state.setDefaultMode);
  const setWorkspaceMode = useExtremePermissionsStore((state) => state.setWorkspaceMode);
  const resetWorkspaceMode = useExtremePermissionsStore((state) => state.resetWorkspaceMode);
  const setBackup = useExtremePermissionsStore((state) => state.setBackup);
  const setAllowSudo = useExtremePermissionsStore((state) => state.setAllowSudo);
  const [servers, setServers] = useState<McpServerView[] | null>(null);
  const [backups, setBackups] = useState<FileChangeSummary[] | null>(null);
  const [backupTick, setBackupTick] = useState(0);
  const [restore, setRestore] = useState<FileChangeSummary | null>(null);

  const overridden = Boolean(workspaceId && byWorkspace[workspaceId]);
  const current = effectivePermission({ defaultMode, byWorkspace }, workspaceId);
  const retention = backup.retentionDays;

  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const list = await opsApi.mcpServerList();
        if (live) setServers(Array.isArray(list) ? list : []);
      } catch {
        if (live) setServers([]);
      }
    })();
    return () => {
      live = false;
    };
  }, [workspaceId, serverId]);

  useEffect(() => {
    if (!workspaceId) {
      setBackups([]);
      return undefined;
    }
    let live = true;
    void (async () => {
      try {
        /*
         * 先看本对话正在跑 / 刚跑完的内存记录，再按任务历史把落库的摘要补回来
         * （应用重启后内存为空，但 `changes_json` 里的备份信息还在）。
         */
        const current = await opsApi
          .aiAgentFileChanges(workspaceId, null)
          .catch(() => []);
        const tasks = await opsApi
          .extremeTaskList({ workspaceId, limit: 30 })
          .catch(() => []);
        const relevant = tasks
          .filter((task) => !serverId || !task.serverId || task.serverId === serverId)
          .slice(0, 20);
        const lists = await Promise.all(
          relevant.map((task) =>
            opsApi.aiAgentFileChanges(workspaceId, task.id).catch(() => []),
          ),
        );
        const merged = new Map<string, FileChangeSummary>();
        for (const change of [current, ...lists].flat()) {
          if (change?.id) merged.set(change.id, change);
        }
        if (live) setBackups([...merged.values()]);
      } catch {
        if (live) setBackups([]);
      }
    })();
    return () => {
      live = false;
    };
  }, [workspaceId, serverId, backupTick]);

  const external = (servers ?? []).filter(
    (server) =>
      server.enabled &&
      bindingMatches(server, serverId, workspaceId) &&
      server.status === "connected",
  );
  const verifiedBackups = (backups ?? []).filter(
    (change) => change.backupVerified && change.backupPath,
  );

  return (
    <ExtremePageShell
      title="权限"
      description="操作权限与备份策略"
      onBack={onBack}
    >
      <div className="flex flex-col gap-3">
        <section className="rounded-lg border border-line/60 px-3 py-3">
          <header className="mb-2">
            <h2 className="text-12 font-medium text-fg">{t("执行权限")}</h2>
            <p className="mt-0.5 text-10 leading-4 text-fg-subtle">
              {t("只读直接拒绝写入；按需确认逐条询问；完全访问只对严重操作二次确认。仅作用于超能 Agent 的工具调用。")}
            </p>
          </header>

          <p className="text-11 text-fg-muted">{t("新任务默认值")}</p>
          <div
            className="mt-1.5 flex flex-col gap-1.5 sm:flex-row"
            role="radiogroup"
            aria-label={t("新任务默认值")}
          >
            {(["readonly", "ask", "full"] as PermissionMode[]).map((mode) => (
              <ModeCard
                key={mode}
                mode={mode}
                selected={defaultMode === mode}
                onSelect={() => setDefaultMode(mode)}
              />
            ))}
          </div>

          <div className="mt-4 border-t border-line/50 pt-3">
            <div className="flex items-center gap-2">
              <p className="min-w-0 flex-1 truncate text-11 text-fg-muted">
                {t("当前任务覆盖")}
                {workspaceTitle ? ` · ${workspaceTitle}` : ""}
              </p>
              {overridden && (
                <button
                  type="button"
                  onClick={() => workspaceId && resetWorkspaceMode(workspaceId)}
                  className="shrink-0 rounded-[5px] border border-line/60 px-1.5 py-0.5 text-10 text-fg-subtle hover:bg-surface-hover hover:text-fg"
                >
                  {t("跟随默认")}
                </button>
              )}
            </div>
            <div
              className="mt-1.5 flex flex-col gap-1.5 sm:flex-row"
              role="radiogroup"
              aria-label={t("当前任务覆盖")}
            >
              {(["readonly", "ask", "full"] as PermissionMode[]).map((mode) => (
                <ModeCard
                  key={mode}
                  mode={mode}
                  selected={current === mode}
                  onSelect={() => workspaceId && setWorkspaceMode(workspaceId, mode)}
                />
              ))}
            </div>
            <p className="mt-2 text-10 leading-4 text-fg-subtle">
              {overridden
                ? t("这条对话使用上面的覆盖值；新任务仍使用默认值。")
                : t("这条对话当前跟随默认值；改这里会为它单独记住。")}
            </p>
          </div>

          <div className="mt-3 border-t border-line/50 pt-1">
            <ToggleRow
              title="允许提权"
              description="允许 Agent 执行 sudo；只读模式仍禁用。需要提权的操作按实际影响确认。"
              checked={allowSudo}
              onChange={setAllowSudo}
            />
          </div>
        </section>

        <section className="rounded-lg border border-line/60 px-3 py-3">
          <header className="mb-2 flex items-start gap-2">
            <div className="min-w-0 flex-1">
              <h2 className="text-12 font-medium text-fg">{t("外部工具")}</h2>
              <p className="mt-0.5 text-10 leading-4 text-fg-subtle">
                {t("当前会话已启用、已连接且绑定到这台服务器 / 工作区的 MCP 连接。调用仍受上面的权限与审批约束。")}
              </p>
              <p className="mt-0.5 text-10 leading-4 text-fg-subtle">
                {t("可调用范围：{{mode}}。只读模式下写入型工具会被拦截。", {
                  mode: t(MODE_LABEL[current]),
                })}
              </p>
            </div>
            <Button variant="ghost" size="xs" onClick={onManageMcp}>
              <Plug size={12} /> {t("管理 MCP")}
            </Button>
          </header>
          {servers === null ? (
            <p className="text-11 text-fg-subtle">{t("正在加载…")}</p>
          ) : external.length === 0 ? (
            <p className="text-10 leading-4 text-fg-subtle">
              {t("当前会话没有可用的外部 MCP 连接。")}
            </p>
          ) : (
            <ul className="flex flex-col gap-1">
              {external.map((server) => {
                const tools = server.tools.filter((tool) => tool.enabled);
                const readOnly = tools.filter((tool) => tool.readOnly).length;
                return (
                  <li
                    key={server.id}
                    className="flex flex-wrap items-center gap-1.5 rounded border border-line/50 px-2 py-1.5"
                  >
                    <span className="min-w-0 flex-1 truncate text-11 text-fg">
                      {server.name}
                    </span>
                    <span className="text-10 text-fg-subtle">
                      {t("{{n}} 个工具（{{read}} 只读）", {
                        n: tools.length,
                        read: readOnly,
                      })}
                    </span>
                    <span className="rounded bg-surface-active px-1 text-9 text-fg-muted">
                      {server.binding?.scope === "server"
                        ? t("当前服务器")
                        : server.binding?.scope === "global"
                          ? t("全局")
                          : t("当前工作区")}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        <section className="rounded-lg border border-line/60 px-3 py-3">
          <header className="mb-2">
            <h2 className="text-12 font-medium text-fg">{t("备份与恢复")}</h2>
            <p className="mt-0.5 text-10 leading-4 text-fg-subtle">
              {t("覆盖超能 Agent 的文件修改与删除；新建文件无需备份。备份失败会取消本次改动并在步骤里说明原因。")}
            </p>
          </header>

          <ToggleRow
            title="修改或覆盖前备份"
            description="只保护本次会被覆盖 / 修改的文件，在同目录留旧版本（.bls-bak. 标记）；新建文件显示「无需备份」。"
            checked={backup.beforeWrite}
            onChange={(next) => setBackup({ beforeWrite: next })}
          />
          <ToggleRow
            title="删除前备份"
            description="删除文件时保护该文件，删除目录时保护整个目标目录；目录同步只保护本次会被覆盖 / 删除的具体文件。"
            checked={backup.beforeDelete}
            onChange={(next) => setBackup({ beforeDelete: next })}
          />

          <div className="flex items-center gap-3 border-t border-line/50 pt-2.5">
            <div className="min-w-0 flex-1">
              <p className="text-12 text-fg">{t("备份保留期限")}</p>
              <p className="mt-0.5 text-10 leading-4 text-fg-subtle">
                {retention > 0
                  ? t("当前生效：{{n}} 天，下次备份时清理同目录下过期的本应用备份。", { n: retention })
                  : t("当前生效：永久保留，不会自动清理。")}
              </p>
            </div>
            <Select
              variant="menu"
              className="w-[104px] shrink-0"
              ariaLabel={t("备份保留期限")}
              value={String(retention)}
              onChange={(value) => setBackup({ retentionDays: Number(value) })}
              options={BACKUP_RETENTION_OPTIONS.map((days) => ({
                value: String(days),
                label: days === 0 ? t("永久") : t("{{n}} 天", { n: days }),
              }))}
            />
          </div>

          <div className="mt-3 border-t border-line/50 pt-2.5">
            <div className="flex items-center gap-2">
              <p className="min-w-0 flex-1 text-12 text-fg">{t("查看已有备份")}</p>
              <span className="text-10 text-fg-subtle">
                {t("{{n}} 份已验证", { n: verifiedBackups.length })}
              </span>
              <button
                type="button"
                className="rounded border border-line/60 px-1.5 py-0.5 text-10 text-fg-subtle hover:bg-surface-hover hover:text-fg"
                onClick={() => setBackupTick((value) => value + 1)}
              >
                {t("刷新")}
              </button>
            </div>
            <p className="mt-0.5 text-10 leading-4 text-fg-subtle">
              {t("只列出当前会话里已确认存在的备份；还原会走 Agent 的权限、审批与变更登记。")}
            </p>
            {backups === null ? (
              <p className="mt-1 text-11 text-fg-subtle">{t("正在加载…")}</p>
            ) : verifiedBackups.length === 0 ? (
              <p className="mt-1 text-10 text-fg-subtle">{t("当前会话还没有已登记的备份。")}</p>
            ) : (
              <ul className="mt-1.5 flex flex-col gap-1">
                {verifiedBackups.map((change) => (
                  <li
                    key={change.id}
                    className="flex items-start gap-2 rounded border border-line/50 px-2 py-1.5"
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block break-all font-mono text-10 text-fg">
                        {change.path}
                      </span>
                      <span className="mt-0.5 block break-all text-9 text-fg-subtle">
                        {t("备份：{{path}}", { path: change.backupPath ?? "" })}
                      </span>
                      <span className="mt-0.5 block text-9 text-fg-subtle">
                        {[change.server, change.taskId, new Date(change.createdAt).toLocaleString()]
                          .filter(Boolean)
                          .join(" · ")}
                      </span>
                    </span>
                    <button
                      type="button"
                      className="shrink-0 rounded border border-line/60 px-1.5 py-0.5 text-10 text-fg-muted hover:bg-surface-hover hover:text-fg"
                      onClick={() => setRestore(change)}
                    >
                      {t("还原")}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </section>

        <section className="rounded-lg border border-line/60 px-3 py-3">
          <header className="mb-2">
            <h2 className="text-12 font-medium text-fg">{t("应用范围")}</h2>
            <p className="mt-0.5 text-10 leading-4 text-fg-subtle">
              {t("这一页的权限与备份由 Rust 执行器裁决；未接入的入口保留各自原有确认。")}
            </p>
          </header>
          <ul className="flex flex-col gap-1.5 text-11">
            {[
              [t("Agent 工具 / 写文件 / 删除 / 服务重启"), t("已覆盖")],
              [t("MCP 工具调用"), t("已覆盖")],
              [t("右栏远程编辑保存 / 删除"), t("保留原有确认")],
              [t("标准模式手工文件操作"), t("保留原有确认与备份")],
              [t("部署执行器"), t("使用部署自己的确认")],
            ].map(([label, status]) => (
              <li key={label} className="flex items-center gap-2">
                <span className="min-w-0 flex-1 text-fg-muted">{label}</span>
                <span
                  className={cn(
                    "shrink-0 rounded px-1 text-9",
                    status === t("已覆盖")
                      ? "bg-accent/10 text-accent"
                      : "bg-surface-active text-fg-subtle",
                  )}
                >
                  {status}
                </span>
              </li>
            ))}
          </ul>
        </section>

        <p className="px-1 text-10 leading-4 text-fg-subtle">
          {t("权限只决定要不要确认，不改变“只查询”任务的只读边界；列出计划本身不授予执行权限。")}
        </p>
      </div>

      {restore && (
        <ConfirmDialog
          open
          title={t("还原备份")}
          description={t(
            "将用备份覆盖 {{target}}：\n{{backup}}\n\n执行前会按当前权限重新核对版本与目标，成功后记为一条真实文件变更。",
            {
              target: restore.path,
              backup: restore.backupPath ?? "",
            },
          )}
          confirmLabel={t("还原")}
          cancelLabel={t("取消")}
          risk="irreversible"
          onCancel={() => setRestore(null)}
          onConfirm={() => {
            const change = restore;
            setRestore(null);
            if (change.backupPath) onRestoreBackup(change.backupPath, change.path);
          }}
        />
      )}
    </ExtremePageShell>
  );
}
