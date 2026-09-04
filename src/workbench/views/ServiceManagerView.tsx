/**
 * 服务管家 — systemd service management (P3-3.1).
 *
 * Every row and every action is read from or sent to the live session: the
 * list comes from `systemctl list-units`, and start/stop/... are fixed verbs
 * that Rust validates before they become a command.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import { listen } from "@tauri-apps/api/event";
import { Copy, Play, RotateCw, Square, SquareCheck, SquareMinus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { ContextMenu, useContextMenu } from "@/components/ui/context-menu";
import { cn } from "@/lib/cn";
import { servicesChangedEvent } from "@/lib/events";
import { opsApi, toErrorMessage, type ServiceActionName, type ServiceUnit } from "@/api/ops-api";
import { useCommandSession } from "@/hooks/use-command-session";
import {
  ModuleEmpty,
  ModuleFrame,
  RefreshButton,
  ToolbarInput,
  ToolbarStat,
  ToolbarStatus,
} from "@/workbench/views/module-frame";
import type { WorkspaceTab } from "@/workbench/types";

type StateFilter = "all" | "running" | "failed" | "inactive" | "enabled";

/** label 存 i18n key（All/Running/Failed 复用 common），渲染处 `t(...)`。 */
const FILTERS: { id: StateFilter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "running", label: "Running" },
  { id: "failed", label: "Failed" },
  { id: "inactive", label: "Not running" },
  { id: "enabled", label: "Enabled on boot" },
];

/** How a unit's state is presented. Never guessed: unknown states are shown as-is. */
function activeTone(unit: ServiceUnit): string {
  if (unit.active === "failed" || unit.sub === "failed") return "bg-danger";
  if (unit.active === "active" && unit.sub === "running") return "bg-success";
  if (unit.active === "activating" || unit.active === "deactivating") return "bg-warning";
  return "bg-fg-subtle";
}

function activeLabel(unit: ServiceUnit, t: TFunction): string {
  if (unit.active === "active" && unit.sub === "running") return t("Running");
  if (unit.active === "failed" || unit.sub === "failed") return t("Failed to start");
  if (unit.active === "inactive") return t("Not running");
  if (unit.active === "activating") return t("Starting");
  if (unit.active === "deactivating") return t("Stopping");
  const sub = unit.sub || t("Unknown");
  return `${unit.active} · ${sub}`;
}

/** `enabled` is `null` for states like `static`, which have no on/off answer. */
function enabledLabel(unit: ServiceUnit, t: TFunction): string {
  if (unit.enabled === true) return t("Enabled on boot");
  if (unit.enabled === false) return t("Not enabled on boot");
  return unit.enabled_state ?? "—";
}

export function ServiceManagerView({ tab }: { tab: WorkspaceTab }) {
  const { t } = useTranslation();
  const session = useCommandSession(tab);

  const [units, setUnits] = useState<ServiceUnit[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<StateFilter>("all");
  const [search, setSearch] = useState("");
  const [busyUnit, setBusyUnit] = useState<string | null>(null);
  const [pendingAction, setPendingAction] = useState<{
    unit: ServiceUnit;
    action: ServiceActionName;
  } | null>(null);
  const [detail, setDetail] = useState<{ unit: string; text: string } | null>(null);

  const load = useCallback(async () => {
    if (!session.ready) return;
    setLoading(true);
    setError(null);
    try {
      setUnits(await opsApi.serviceList(session.sessionId));
    } catch (cause) {
      setError(toErrorMessage(cause));
    } finally {
      setLoading(false);
    }
  }, [session.ready, session.sessionId]);

  // Load whenever the session becomes usable.
  useEffect(() => {
    void load();
  }, [load]);

  // An action changes server state, so the list must reload afterwards.
  useEffect(() => {
    const unlisten = listen<string>(servicesChangedEvent(session.sessionId), () => {
      void load();
    });
    return () => void unlisten.then((fn) => fn());
  }, [load, session.sessionId]);

  const runAction = useCallback(
    async (unit: ServiceUnit, action: ServiceActionName) => {
      setBusyUnit(unit.unit);
      setError(null);
      try {
        await opsApi.serviceAction(session.sessionId, action, unit.unit);
        await load();
      } catch (cause) {
        setError(toErrorMessage(cause));
      } finally {
        setBusyUnit(null);
      }
    },
    [load, session.sessionId],
  );

  const showDetail = useCallback(
    async (unit: ServiceUnit) => {
      setBusyUnit(unit.unit);
      try {
        const text = await opsApi.serviceStatus(session.sessionId, unit.unit);
        setDetail({ unit: unit.unit, text });
      } catch (cause) {
        setError(toErrorMessage(cause));
      } finally {
        setBusyUnit(null);
      }
    },
    [session.sessionId],
  );

  const visible = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return units.filter((unit) => {
      const matchesSearch =
        !needle ||
        unit.unit.toLowerCase().includes(needle) ||
        unit.description.toLowerCase().includes(needle);
      if (!matchesSearch) return false;
      switch (filter) {
        case "running":
          return unit.active === "active" && unit.sub === "running";
        case "failed":
          return unit.active === "failed" || unit.sub === "failed";
        case "inactive":
          return unit.active === "inactive";
        case "enabled":
          return unit.enabled === true;
        default:
          return true;
      }
    });
  }, [filter, search, units]);

  const menu = useContextMenu();
  const rowMenu = (unit: ServiceUnit) =>
    menu.onContextMenu(() => {
      const running = unit.active === "active" && unit.sub === "running";
      return [
        { id: "detail", label: t("View details"), onSelect: () => void showDetail(unit) },
        { id: "sep1", separator: true },
        {
          id: "start",
          label: t("Start"),
          icon: Play,
          disabled: running || busyUnit !== null,
          onSelect: () => void runAction(unit, "start"),
        },
        {
          id: "stop",
          label: t("Stop"),
          icon: Square,
          disabled: !running || busyUnit !== null,
          danger: true,
          onSelect: () => setPendingAction({ unit, action: "stop" }),
        },
        {
          id: "restart",
          label: t("Restart"),
          icon: RotateCw,
          disabled: busyUnit !== null,
          danger: true,
          onSelect: () => setPendingAction({ unit, action: "restart" }),
        },
        {
          id: "reload",
          label: t("Reload configuration"),
          disabled: !running || busyUnit !== null,
          onSelect: () => void runAction(unit, "reload"),
        },
        { id: "sep2", separator: true },
        unit.enabled === true
          ? {
              id: "disable",
              label: t("Disable on boot"),
              icon: SquareMinus,
              disabled: busyUnit !== null,
              onSelect: () => void runAction(unit, "disable"),
            }
          : {
              id: "enable",
              label: t("Enable on boot"),
              icon: SquareCheck,
              disabled: unit.enabled === null || busyUnit !== null,
              onSelect: () => void runAction(unit, "enable"),
            },
      ];
    });

  const pendingUnit = pendingAction?.unit;

  return (
    <ModuleFrame
      tab={tab}
      session={session}
      icon={SquareCheck}
      toolbar={
        <>
          <RefreshButton busy={loading} onClick={() => void load()} />
          <div className="mx-1 h-4 w-px bg-line" />
          <ToolbarInput
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder={t("Search services…")}
            width="w-40"
          />
          <div className="mx-1 h-4 w-px bg-line" />
          {FILTERS.map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => setFilter(item.id)}
              className={cn(
                "h-[24px] rounded-[6px] px-2 text-11 transition-colors",
                filter === item.id
                  ? "bg-surface-active text-fg"
                  : "text-fg-muted hover:bg-surface-hover hover:text-fg",
              )}
            >
              {t(item.label)}
            </button>
          ))}
          <ToolbarStatus>
            <ToolbarStat>
              {loading ? t("Reading…") : t("{{visible}} / {{total}} services", { visible: visible.length, total: units.length })}
            </ToolbarStat>
          </ToolbarStatus>
        </>
      }
    >
      {error && (
        <div className="mx-3 mt-3 flex items-start gap-2 rounded-[8px] border border-danger/30 bg-danger/10 px-3 py-2 text-12 text-danger">
          <span className="min-w-0 flex-1 break-words">{error}</span>
          <button
            type="button"
            aria-label={t("Copy error message")}
            title={t("Copy error message")}
            className="flex h-6 shrink-0 items-center gap-1 rounded-[6px] px-1.5 text-11 text-danger/80 hover:bg-danger/10 hover:text-danger"
            onClick={() => void navigator.clipboard.writeText(error)}
          >
            <Copy size={12} />
            {t("Copy")}
          </button>
        </div>
      )}

      {!loading && !error && units.length === 0 ? (
        <ModuleEmpty
          title={t("No services found")}
          hint={t("This machine may not be a systemd system, or the current user cannot list units.")}
        />
      ) : visible.length === 0 && !loading ? (
        <ModuleEmpty title={t("No matching services")} hint={t("Try different filters or clear the search.")} />
      ) : (
        <ServiceTable
          units={visible}
          busyUnit={busyUnit}
          onRowContextMenu={rowMenu}
          onDetail={(unit) => void showDetail(unit)}
        />
      )}

      <ContextMenu {...menu.props} />

      <ConfirmDialog
        open={pendingAction !== null}
        title={
          pendingAction?.action === "restart"
            ? t("Restart service {{unit}}", { unit: pendingUnit?.unit ?? "" })
            : t("Stop service {{unit}}", { unit: pendingUnit?.unit ?? "" })
        }
        description={
          pendingAction?.action === "restart"
            ? t("Restart \"{{unit}}\"? The service will be briefly interrupted.", { unit: pendingUnit?.unit ?? "" })
            : t("Stop \"{{unit}}\"? The service will be unavailable until started again.", {
                unit: pendingUnit?.unit ?? "",
              })
        }
        confirmLabel={pendingAction?.action === "restart" ? t("Restart") : t("Stop")}
        danger
        onConfirm={() => {
          if (pendingAction) void runAction(pendingAction.unit, pendingAction.action);
          setPendingAction(null);
        }}
        onCancel={() => setPendingAction(null)}
      />

      {detail && (
        <DetailSheet
          unit={detail.unit}
          text={detail.text}
          onClose={() => setDetail(null)}
          onReload={() => {
            setDetail(null);
            void load();
          }}
        />
      )}
    </ModuleFrame>
  );
}

function ServiceTable({
  units,
  busyUnit,
  onRowContextMenu,
  onDetail,
}: {
  units: ServiceUnit[];
  busyUnit: string | null;
  onRowContextMenu: (unit: ServiceUnit) => (event: React.MouseEvent) => void;
  onDetail: (unit: ServiceUnit) => void;
}) {
  const { t } = useTranslation();
  return (
    <table className="w-full text-11">
      <thead className="sticky top-0 z-10 bg-surface-2 text-fg-subtle">
        <tr>
          <th className="w-[34px] px-3 py-1.5" />
          <th className="px-2 py-1.5 text-left font-semibold">{t("Service unit")}</th>
          <th className="w-[150px] px-2 py-1.5 text-left font-semibold">{t("Run state")}</th>
          <th className="w-[92px] px-2 py-1.5 text-left font-semibold">{t("Autostart")}</th>
          <th className="px-3 py-1.5 text-left font-semibold">{t("Description")}</th>
        </tr>
      </thead>
      <tbody>
        {units.map((unit) => (
          <tr
            key={unit.unit}
            className="cursor-default border-t border-line hover:bg-surface-hover"
            onContextMenu={onRowContextMenu(unit)}
            onDoubleClick={() => onDetail(unit)}
          >
            <td className="px-3 py-1.5">
              <span className={cn("block h-[6px] w-[6px] rounded-full", activeTone(unit))} />
            </td>
            <td className="px-2 py-1.5 font-mono text-fg">
              {unit.unit}
              {busyUnit === unit.unit && (
                <RotateCw size={10} className="ml-1.5 inline animate-spin text-accent" />
              )}
            </td>
            <td className="px-2 py-1.5">
              <span className={cn("inline-flex items-center rounded-full px-2 py-0.5 text-10", unit.active === "active" && unit.sub === "running" ? "bg-success/12 text-success" : unit.active === "failed" || unit.sub === "failed" ? "bg-danger/12 text-danger" : "bg-surface-3 text-fg-subtle")}>
                {activeLabel(unit, t)}
              </span>
            </td>
            <td className="px-2 py-1.5 text-fg-muted">{enabledLabel(unit, t)}</td>
            <td className="max-w-0 truncate px-3 py-1.5 text-fg-subtle" title={unit.description}>
              {unit.description}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** `systemctl status` output, verbatim — the operator's own view of the unit. */
function DetailSheet({
  unit,
  text,
  onClose,
  onReload,
}: {
  unit: string;
  text: string;
  onClose: () => void;
  onReload: () => void;
}) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);

  const copyDetail = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  };

  return (
    <div className="absolute inset-0 z-40 flex flex-col bg-app/80 backdrop-blur-sm">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-line bg-surface-1 px-3">
        <span className="text-12 font-semibold text-fg">{unit}</span>
        <span className="text-11 text-fg-subtle">systemctl status</span>
        <div className="ml-auto flex items-center gap-1">
          <Button variant="ghost" size="xs" onClick={() => void copyDetail()}>
            <Copy size={12} />
            {copied ? t("Copied") : t("Copy details")}
          </Button>
          <Button variant="ghost" size="xs" onClick={onReload}>
            {t("Refresh list")}
          </Button>
          <Button variant="ghost" size="xs" onClick={onClose}>
            {t("Close")}
          </Button>
        </div>
      </div>
      <pre className="flex-1 overflow-auto whitespace-pre-wrap p-3 font-mono text-11 leading-relaxed text-fg-muted">
        {text || t("(no output)")}
      </pre>
    </div>
  );
}
