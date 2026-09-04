/**
 * Shared chrome for the P3 management modules.
 *
 * Every module page is session-driven and needs the same things: a header
 * showing which host the numbers came from, honest banners for each
 * connection state, a server picker when the tab has no server yet, and a
 * scroll area. Putting that here keeps five views from drifting apart — and
 * keeps "connection lost" looking the same everywhere.
 */
import { type InputHTMLAttributes, type ReactNode, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Activity,
  Loader2,
  PlugZap,
  RefreshCw,
  TriangleAlert,
  WifiOff,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/cn";
import { useDomainStore } from "@/stores/domain-store";
import { useWorkbenchStore } from "@/stores/workbench-store";
import type { CommandSession } from "@/hooks/use-command-session";

/** Shown when a module tab has no server attached yet. */
export function ServerPicker({ tabId }: { tabId: string }) {
  const { t } = useTranslation();
  const servers = useDomainStore((s) => s.servers);
  const updateTab = useWorkbenchStore((s) => s.updateTab);
  const closeTabById = useWorkbenchStore((s) => s.closeTabById);
  const [filter, setFilter] = useState("");

  const visible = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    if (!needle) return servers;
    return servers.filter(
      (server) =>
        server.name.toLowerCase().includes(needle) ||
        server.host.toLowerCase().includes(needle) ||
        server.username.toLowerCase().includes(needle),
    );
  }, [filter, servers]);

  const attach = (server: { id: string; name: string; host: string; port: number }) =>
    updateTab(tabId, {
      title: server.name,
      subtitle: `${server.host}:${server.port}`,
      serverId: server.id,
      sessionId: crypto.randomUUID(),
    });

  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 bg-surface-1 px-6">
      <p className="text-13 text-fg-muted">{t("Select a server to start")}</p>
      {servers.length === 0 ? (
        <p className="max-w-sm text-center text-12 text-fg-subtle">
          {t("No entries under \"Servers\" on the left yet — add a server first.")}
        </p>
      ) : (
        <div className="flex w-80 flex-col gap-2">
          <input
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            placeholder={t("Search servers…")}
            className="h-[28px] rounded-[7px] border border-line bg-surface-2 px-2 text-12 text-fg outline-none placeholder:text-fg-subtle focus:border-accent"
          />
          <div className="flex max-h-[45vh] flex-col overflow-y-auto rounded-[8px] border border-line bg-surface-1">
            {visible.length === 0 ? (
              <p className="px-3 py-4 text-center text-12 text-fg-subtle">{t("No matching servers")}</p>
            ) : (
              visible.map((server) => (
                <button
                  key={server.id}
                  type="button"
                  className="flex flex-col items-start gap-0.5 border-b border-line px-3 py-2 text-left last:border-b-0 hover:bg-surface-hover"
                  onClick={() => attach(server)}
                >
                  <span className="text-12 text-fg">{server.name}</span>
                  <span className="text-11 text-fg-subtle">
                    {server.username}@{server.host}:{server.port}
                  </span>
                </button>
              ))
            )}
          </div>
        </div>
      )}
      <Button variant="ghost" size="sm" onClick={() => closeTabById(tabId)}>
        {t("Close this tab")}
      </Button>
    </div>
  );
}

export function ModuleFrame({
  tab,
  session,
  icon,
  toolbar,
  toolbar2,
  children,
}: {
  tab: { id: string; title: string; subtitle?: string };
  session: CommandSession;
  /** Optional leading glyph in the header row. Omit for a plain toolbar. */
  icon?: ReactNode | React.ElementType;
  /** Primary actions on the first (top) row: refresh, follow, status sum-up. */
  toolbar?: ReactNode;
  /** Secondary row (filter bar) shown beneath the first row when present. */
  toolbar2?: ReactNode;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  const Glyph = icon as React.ElementType | undefined;
  const closeTabById = useWorkbenchStore((s) => s.closeTabById);

  if (!session.hasTarget) {
    // The module view is wrapped in `ModuleWithSidebar`, which already shows the
    // server list on the left. A full-screen picker here would just duplicate it,
    // so we only point the user at the sidebar and let them close a stray tab.
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 bg-surface-1 px-6">
        <p className="text-13 text-fg-muted">{t("Pick a server from the left sidebar")}</p>
        <p className="max-w-sm text-center text-12 text-fg-subtle">
          {t(
            "Logs, containers, gateways and other modules run on a specific server. Pick one from the left list to view its content here.",
          )}
        </p>
        <Button variant="ghost" size="sm" onClick={() => closeTabById(tab.id)}>
          {t("Close tab")}
        </Button>
      </div>
    );
  }

  const banner = () => {
    if (session.phase === "connecting") {
      return (
        <div className="flex shrink-0 items-center gap-2 border-b border-line bg-surface-2 px-3 py-2 text-12 text-fg-muted">
          <Activity size={13} className="shrink-0 animate-pulse text-accent" />
          <span>{t("Establishing connection (no interactive terminal allocated)…")}</span>
        </div>
      );
    }
    if (session.phase === "error") {
      return (
        <div className="flex shrink-0 items-start gap-2 border-b border-danger/30 bg-danger/10 px-3 py-2 text-12 text-danger">
          <TriangleAlert size={13} className="mt-0.5 shrink-0" />
          <span className="min-w-0 flex-1">{session.error ?? t("Connection failed")}</span>
          <Button variant="ghost" size="xs" onClick={session.connect}>
            {t("Retry")}
          </Button>
        </div>
      );
    }
    if (session.phase === "closed") {
      return (
        <div className="flex shrink-0 items-center gap-2 border-b border-line bg-surface-2 px-3 py-2 text-12 text-fg-muted">
          <WifiOff size={13} className="shrink-0" />
          <span className="min-w-0 flex-1">{session.error ?? t("SSH connection closed")}</span>
          <Button variant="ghost" size="xs" onClick={session.connect}>
            {t("Reconnect")}
          </Button>
        </div>
      );
    }
    return null;
  };

  return (
    <div className="flex h-full min-h-0 flex-col bg-surface-1">
      {/* One compact header row: icon + toolbar (filters/actions). The server
          name itself lives on the tab, so we don't repeat it here — this row
          is purely the module's controls. Connection problems surface via the
          banner below, not a permanent status badge. */}
      <div className="flex h-10 shrink-0 items-center gap-1 overflow-hidden border-b border-line bg-transparent px-2">
        {Glyph && <Glyph size={13} className="shrink-0 text-fg-subtle" />}
        {toolbar && <div className="flex min-w-0 flex-1 items-center gap-1">{toolbar}</div>}
      </div>

      {banner()}

      {toolbar2 && (
        <div className="flex h-9 shrink-0 items-center gap-1.5 overflow-hidden border-b border-line bg-transparent px-2">
          {toolbar2}
        </div>
      )}

      <div className="ops-scroll min-h-0 flex-1 overflow-y-scroll overflow-x-hidden">{children}</div>
    </div>
  );
}

/**
 * Right-aligned summary text in a module toolbar.
 *
 * This is the part that gives up space first when the window narrows: the row
 * itself is fixed at one line, so the summary shrinks while the controls keep
 * their full size. Each piece is a {@link ToolbarStat} so it ellipsizes and
 * keeps the full text in a tooltip.
 */
export function ToolbarStatus({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    
    <span
      className={cn(
        "ml-auto flex min-w-0 shrink items-center gap-2 overflow-hidden text-11 text-fg-subtle",
        className,
      )}
    >
      {children}
    </span>
  );
}

/**
 * One piece of a {@link ToolbarStatus}.
 *
 * `shrink-0` marks a piece as essential — it never ellipsizes, so reserve it
 * for the one number the user actually reads (a row count, say).
 */
export function ToolbarStat({
  children,
  title,
  className,
}: {
  children: ReactNode;
  /** Overrides the tooltip; defaults to the text when it is plain. */
  title?: string;
  className?: string;
}) {
  return (
    <span
      className={cn("truncate", className)}
      title={title ?? (typeof children === "string" ? children : undefined)}
    >
      {children}
    </span>
  );
}

/**
 * A compact toolbar input.
 *
 * `width` is a *maximum*: the field is the first control to narrow when the
 * toolbar runs out of room, because a slightly shorter box still works while
 * a clipped button does not.
 */
export function ToolbarInput({
  width = "w-44",
  className,
  ...props
}: InputHTMLAttributes<HTMLInputElement> & { width?: string }) {
  return (
    <input
      {...props}
      className={cn(
        "h-[24px] min-w-[72px] shrink rounded-[6px] border border-line bg-surface-2 px-2 text-11 text-fg outline-none placeholder:text-fg-subtle focus:border-accent",
        width,
        className,
      )}
    />
  );
}

/** A toolbar refresh button that shows a spinner while work is in flight. */
export function RefreshButton({
  busy,
  onClick,
  label = "Refresh",
}: {
  busy: boolean;
  onClick: () => void;
  label?: string;
}) {
  const { t } = useTranslation();
  return (
    <Button variant="ghost" size="xs" disabled={busy} onClick={onClick}>
      {busy ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />}
      {t(label)}
    </Button>
  );
}

/** A "no data yet" / "nothing matches" placeholder for module tables. */
export function ModuleEmpty({
  icon: Icon = PlugZap,
  title,
  hint,
  action,
}: {
  icon?: React.ElementType;
  title: string;
  hint?: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 px-6 py-12 text-center">
      <Icon size={20} className="text-fg-subtle" />
      <p className="text-13 text-fg-muted">{title}</p>
      {hint && <p className="max-w-md text-12 text-fg-subtle">{hint}</p>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}
