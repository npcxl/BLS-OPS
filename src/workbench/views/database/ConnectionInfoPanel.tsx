/**
 * 连接信息：点左侧连接时显示在右侧。
 *
 * 只读属性卡，不在这里改配置；编辑仍走连接表单。
 */
import { useEffect, type ElementType } from "react";
import { useTranslation } from "react-i18next";
import {
  Clock,
  Database as DatabaseIcon,
  Info,
  KeyRound,
  Network,
  RefreshCw,
  Server,
  ShieldCheck,
  X,
} from "@/components/icons";
import { Button } from "@/components/ui/button";
import { Tooltip } from "@/components/ui/tooltip";
import type { DbEngine, ProfileRuntimeStatus } from "@/api/types/database";
import { useDatabaseStore } from "@/stores/database-store";
import { useDatabaseWorkspaceStore } from "@/stores/database-workspace-store";

const ENGINE_LABEL: Record<DbEngine, string> = {
  mysql: "MySQL",
  mariadb: "MariaDB",
  postgres: "PostgreSQL",
  sqlite: "SQLite",
  sqlserver: "SQL Server",
  oracle: "Oracle",
};

function InfoRow({
  icon: Icon,
  label,
  value,
}: {
  icon: ElementType;
  label: string;
  value: string;
}) {
  return (
    <div className="flex items-start gap-2 px-3 py-[5px]">
      <Icon size={12} className="mt-0.5 shrink-0 text-fg-subtle" />
      <span className="w-[72px] shrink-0 text-11 text-fg-subtle">{label}</span>
      <Tooltip label={value} side="left">
        <span className="min-w-0 flex-1 truncate text-11 text-fg">{value}</span>
      </Tooltip>
    </div>
  );
}

export function ConnectionInfoPanel({ profileId }: { profileId: string }) {
  const { t } = useTranslation();
  const profile = useDatabaseStore(
    (state) =>
      state.profiles.find((entry) => entry.id === profileId) ?? null,
  );
  const session = useDatabaseStore(
    (state) => state.sessions[profileId] ?? null,
  );
  const status = useDatabaseStore(
    (state) => state.statuses[profileId] ?? (null as ProfileRuntimeStatus | null),
  );
  const refreshStatus = useDatabaseStore((state) => state.refreshStatus);
  const hideConnectionInfo = useDatabaseWorkspaceStore(
    (state) => state.hideConnectionInfo,
  );

  useEffect(() => {
    void refreshStatus(profileId);
  }, [profileId, refreshStatus]);

  if (!profile) return null;

  const connected = !!session;
  const version = session?.server_version ?? status?.server_version ?? t("未知");
  const tls = session?.tls_active
    ? [session.tls_version, session.tls_cipher].filter(Boolean).join(" · ")
    : t("未启用");
  const tunnel = status?.tunnel_active
    ? `127.0.0.1:${status.tunnel_local_port ?? "?"}`
    : t("未启用");
  const openedAt = session?.opened_at
    ? new Date(
        session.opened_at > 1_000_000_000_000
          ? session.opened_at
          : session.opened_at * 1000,
      ).toLocaleString()
    : "—";

  return (
    <aside className="flex h-full min-h-0 flex-col bg-surface-1">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-line px-2">
        <DatabaseIcon size={12} className="shrink-0 text-fg" />
        <span className="min-w-0 flex-1 truncate text-12 font-medium text-fg">
          {t("连接信息")}
        </span>
        <Tooltip label={t("刷新状态")} side="left">
          <Button
            variant="ghost"
            size="xs"
            className="h-5 w-5 px-0"
            aria-label={t("刷新状态")}
            onClick={() => void refreshStatus(profileId)}
          >
            <RefreshCw size={10} />
          </Button>
        </Tooltip>
        <Tooltip label={t("关闭连接信息")} side="left">
          <Button
            variant="ghost"
            size="xs"
            className="h-5 w-5 px-0"
            aria-label={t("关闭连接信息")}
            onClick={hideConnectionInfo}
          >
            <X size={11} />
          </Button>
        </Tooltip>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto py-1">
        <div className="flex items-center gap-2 px-3 py-2">
          <span
            className={
              connected
                ? "h-1.5 w-1.5 shrink-0 rounded-full bg-fg"
                : "h-1.5 w-1.5 shrink-0 rounded-full bg-line-strong"
            }
          />
          <span className="min-w-0 flex-1 truncate text-12 font-medium text-fg">
            {profile.name}
          </span>
          <span className="shrink-0 text-11 text-fg-subtle">
            {connected ? t("已连接") : t("未连接")}
          </span>
        </div>

        <InfoRow
          icon={DatabaseIcon}
          label={t("类型")}
          value={ENGINE_LABEL[profile.engine]}
        />
        <InfoRow
          icon={Info}
          label={t("版本")}
          value={version}
        />
        <InfoRow
          icon={Server}
          label={t("主机")}
          value={`${profile.host}:${profile.port}`}
        />
        <InfoRow
          icon={KeyRound}
          label={t("用户")}
          value={profile.username}
        />
        <InfoRow
          icon={DatabaseIcon}
          label={t("当前数据库")}
          value={
            session?.current_database ??
            profile.default_database ??
            t("未选择数据库")
          }
        />
        <InfoRow icon={ShieldCheck} label={t("TLS")} value={tls} />
        <InfoRow icon={Network} label={t("SSH 隧道")} value={tunnel} />
        <InfoRow icon={Clock} label={t("连接时间")} value={openedAt} />
        <InfoRow
          icon={Info}
          label={t("连接 ID")}
          value={session ? `#${session.connection_id}` : "—"}
        />
      </div>
    </aside>
  );
}
