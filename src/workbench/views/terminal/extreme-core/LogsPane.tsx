import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Container, Search } from "@/components/icons";
import { opsApi } from "@/api/ops-api";
import type { LogSource } from "@/api/types/panel";
import { LiveLogPanel } from "./LiveLogPanel";

/**
 * 日志标签。
 *
 * 有来源就直接接已有的实时日志（监听在应用级 store，切标签 / 切对话不断）；
 * 没有来源时给出这台服务器上实际在跑的服务与容器，让用户选一个。AI 通过
 * `openPanel` 打开日志时也会把来源写进来，这里直接显示。
 */
export function LogsPane({
  workspaceId,
  serverId,
  sessionId,
  source,
  onChoose,
}: {
  workspaceId: string;
  serverId: string | null;
  sessionId: string | null;
  source: LogSource | null;
  onChoose: (source: LogSource) => void;
}) {
  const { t } = useTranslation();
  const [units, setUnits] = useState<{ unit: string; description: string; active: string }[]>([]);
  const [containers, setContainers] = useState<{ id: string; name: string; state: string }[]>([]);
  const [query, setQuery] = useState("");
  const [choosing, setChoosing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if ((source && !choosing) || !sessionId) return undefined;
    let cancelled = false;
    setLoading(true);
    void Promise.all([
      opsApi.serviceList(sessionId).catch(() => []),
      opsApi.dockerSnapshot(sessionId).catch(() => null),
    ])
      .then(([serviceList, docker]) => {
        if (cancelled) return;
        setUnits(
          serviceList
            .filter((unit) => unit.active === "active")
            .map((unit) => ({
              unit: unit.unit,
              description: unit.description,
              active: unit.active,
            })),
        );
        setContainers(docker?.containers ?? []);
        setError(null);
      })
      .catch((cause: unknown) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [choosing, source, sessionId]);

  const choose = (next: LogSource) => {
    onChoose(next);
    setChoosing(false);
    setQuery("");
  };

  const filteredUnits = useMemo(
    () =>
      units.filter((unit) =>
        `${unit.unit} ${unit.description}`.toLowerCase().includes(query.toLowerCase()),
      ),
    [units, query],
  );
  const filteredContainers = useMemo(
    () => containers.filter((item) => item.name.toLowerCase().includes(query.toLowerCase())),
    [containers, query],
  );

  if (source && sessionId && !choosing) {
    return (
      <LiveLogPanel
        workspaceId={workspaceId}
        sessionId={sessionId}
        serverId={serverId}
        source={source}
        onChangeSource={() => setChoosing(true)}
      />
    );
  }

  if (!sessionId) {
    return (
      <p className="px-3 py-2 text-11 text-fg-subtle">
        {t("服务器未连接：重新连接后才能查看实时日志。")}
      </p>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-1 border-b border-line/70 px-2 py-1.5">
        <Search size={12} className="shrink-0 text-fg-subtle" />
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={t("筛选服务 / 容器")}
          aria-label={t("筛选日志来源")}
          className="min-w-0 flex-1 bg-transparent text-11 text-fg outline-none placeholder:text-fg-subtle"
        />
        {source && (
          <button
            type="button"
            className="shrink-0 rounded px-2 py-0.5 text-11 text-fg-muted hover:bg-surface-hover"
            onClick={() => setChoosing(false)}
          >
            {t("取消")}
          </button>
        )}
      </div>
      {error && <p className="px-2 py-1 text-10 text-danger">{error}</p>}
      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        <p className="mb-1 text-10 text-fg-subtle">{t("容器日志")}</p>
        {filteredContainers.length === 0 ? (
          <p className="mb-2 text-11 text-fg-subtle">{loading ? t("读取中…") : t("没有运行中的容器")}</p>
        ) : (
          <ul className="mb-2 space-y-0.5">
            {filteredContainers.slice(0, 20).map((item) => (
              <li key={item.id}>
                <button
                  type="button"
                  onClick={() =>
                    choose({ kind: "docker", container: item.name, label: item.name })
                  }
                  className="flex w-full items-center gap-1.5 rounded-[6px] px-1.5 py-1 text-left text-11 text-fg-muted hover:bg-surface-hover hover:text-fg"
                >
                  <Container size={12} className="shrink-0 text-fg-subtle" />
                  <span className="min-w-0 flex-1 truncate">{item.name}</span>
                  <span className="shrink-0 text-10 text-fg-subtle">{item.state}</span>
                </button>
              </li>
            ))}
          </ul>
        )}

        <p className="mb-1 text-10 text-fg-subtle">{t("服务日志")}</p>
        {filteredUnits.length === 0 ? (
          <p className="text-11 text-fg-subtle">{loading ? t("读取中…") : t("没有运行中的服务")}</p>
        ) : (
          <ul className="space-y-0.5">
            {filteredUnits.slice(0, 40).map((unit) => (
              <li key={unit.unit}>
                <button
                  type="button"
                  onClick={() =>
                    choose({ kind: "journal", unit: unit.unit, label: unit.unit })
                  }
                  className="flex w-full items-start gap-1.5 rounded-[6px] px-1.5 py-1 text-left hover:bg-surface-hover"
                >
                  <span className="mt-1 size-1.5 shrink-0 rounded-full bg-success" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-11 text-fg-muted">{unit.unit}</span>
                    <span className="block truncate text-10 text-fg-subtle">
                      {unit.description}
                    </span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
