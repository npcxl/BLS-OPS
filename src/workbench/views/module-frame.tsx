/**
 * Shared chrome for the P3 management modules.
 *
 * Every module page is session-driven and needs the same things: a header
 * showing which host the numbers came from, honest banners for each
 * connection state, a server picker when the tab has no server yet, and a
 * scroll area. Putting that here keeps five views from drifting apart — and
 * keeps "connection lost" looking the same everywhere.
 */
import { type InputHTMLAttributes, type ReactNode, type Ref, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Activity,
  Loader2,
  PlugZap,
  RefreshCw,
  TriangleAlert,
  WifiOff,
} from "@/components/icons";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/cn";
import { PageNotice, PageScroll, PageSurface, PageToolbar, PageWorkspace } from "@/workbench/page-layout";
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
    <PageSurface>
      <PageWorkspace className="items-center justify-center">
        <div className="flex w-full max-w-[400px] flex-col gap-3 px-6">
          {servers.length === 0 ? (
            <EmptyState
              icon={<PlugZap size={18} strokeWidth={1.5} />}
              title={t("No servers yet")}
              description={t("No entries under \"Servers\" on the left yet — add a server first.")}
            />
          ) : (
            <>
              <p className="text-center text-13 text-fg-muted">{t("Select a server to start")}</p>
              <Input
                value={filter}
                onChange={(event) => setFilter(event.target.value)}
                placeholder={t("Search servers…")}
                aria-label={t("Search servers…")}
                size="xs"
              />
              <div className="page-form-list max-h-[45vh] overflow-y-auto">
                {visible.length === 0 ? (
                  <EmptyState
                    title={t("No matching servers")}
                    className="min-h-24 py-4"
                    action={
                      <Button variant="ghost" size="xs" onClick={() => setFilter("")}>
                        {t("Clear search")}
                      </Button>
                    }
                  />
                ) : (
                  visible.map((server) => (
                    <button
                      key={server.id}
                      type="button"
                      className="page-form-row w-full flex-col items-start gap-0.5 text-left hover:bg-surface-hover"
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
            </>
          )}
          <Button variant="ghost" size="sm" className="self-center" onClick={() => closeTabById(tabId)}>
            {t("Close this tab")}
          </Button>
        </div>
      </PageWorkspace>
    </PageSurface>
  );
}

export function ModuleFrame({
  session,
  icon,
  toolbar,
  toolbar2,
  contentScroll = true,
  contentRef,
  children,
}: {
  session: CommandSession;
  /** Optional leading glyph in the header row. Omit for a plain toolbar. */
  icon?: ReactNode | React.ElementType;
  /** Primary actions on the first (top) row: refresh, follow, status sum-up. */
  toolbar?: ReactNode;
  /** Secondary row (filter bar) shown beneath the first row when present. */
  toolbar2?: ReactNode;
  /** Pages with their own scrollable panes (project tabs, split workspaces) opt out. */
  contentScroll?: boolean;
  /** The page's single scroll viewport (follow-tail logs, scroll restore). */
  contentRef?: Ref<HTMLDivElement>;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  const Glyph = icon as React.ElementType | undefined;

  if (!session.hasTarget) {
    // The module view is wrapped in `ModuleWithSidebar`, which already shows the
    // server list on the left. A full-screen picker here would just duplicate it,
    // so we only point the user at the sidebar; the tab itself closes from its
    // own close button.
    return (
      <PageSurface>
        <PageWorkspace className="items-center justify-center">
          <EmptyState
            icon={<PlugZap size={18} strokeWidth={1.5} />}
            title={t("Pick a server from the left sidebar")}
            description={t(
              "Logs, containers, gateways and other modules run on a specific server. Pick one from the left list to view its content here.",
            )}
            className="min-h-0 py-0"
          />
        </PageWorkspace>
      </PageSurface>
    );
  }

  const banner = () => {
    if (session.phase === "connecting") {
      return (
        <PageNotice icon={<Activity size={13} className="animate-pulse text-accent" />}>
          {t("Establishing connection (no interactive terminal allocated)…")}
        </PageNotice>
      );
    }
    if (session.phase === "error") {
      return (
        <PageNotice
          tone="danger"
          centered
          icon={<TriangleAlert size={13} />}
          action={
            <Button variant="ghost" size="xs" onClick={session.connect}>
              {t("Retry")}
            </Button>
          }
        >
          {session.error ?? t("Connection failed")}
        </PageNotice>
      );
    }
    if (session.phase === "closed") {
      return (
        <PageNotice
          centered
          icon={<WifiOff size={13} />}
          action={
            <Button variant="ghost" size="xs" onClick={session.connect}>
              {t("Reconnect")}
            </Button>
          }
        >
          {session.error ?? t("SSH connection closed")}
        </PageNotice>
      );
    }
    return null;
  };

  return (
    <PageSurface>
      {/* One compact control row: icon + filters/actions. The server name lives
          on the work tab, so it is not repeated here; connection problems use
          the notice slot below instead of a permanent badge. */}
      <PageToolbar>
        {Glyph && <Glyph size={13} className="shrink-0 text-fg-subtle" />}
        {toolbar ? <div className="flex min-w-0 flex-1 items-center gap-1">{toolbar}</div> : <div className="page-toolbar-grow" />}
      </PageToolbar>

      {banner()}

      {toolbar2 && <PageToolbar variant="secondary">{toolbar2}</PageToolbar>}

      {contentScroll ? (
        <PageScroll padded={false} viewportRef={contentRef}>
          {children}
        </PageScroll>
      ) : (
        <PageWorkspace>{children}</PageWorkspace>
      )}
    </PageSurface>
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
        "page-toolbar-summary ml-auto flex min-w-0 shrink items-center gap-2 overflow-hidden text-11 text-fg-subtle",
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
/**
 * 模块工具栏输入框：`Input` 的 xs 档位 + 固定最小宽度。
 *
 * 以前这里自己写了一套 24px 的边框/圆角/焦点样式，与表单里的 `Input`
 * 高 6px、圆角不同 —— 同一个应用两套输入框。现在只保留"宽度"这一层
 * 页面级决策，其余全部走公共控件。
 */
export function ToolbarInput({
  width = "w-44",
  className,
  size: _unusedSize,
  ...props
}: InputHTMLAttributes<HTMLInputElement> & { width?: string }) {
  return <Input {...props} size="xs" className={cn("min-w-[72px] shrink", width, className)} />;
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

/**
 * A "no data yet" / "nothing matches" placeholder for module tables.
 *
 * 视觉统一到 `<EmptyState>`：图标底块、字号、间距只有一处定义。历史调用点
 * 保持原签名（`icon` 传组件类型），不需要逐个改。
 */
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
    <EmptyState
      icon={<Icon size={18} strokeWidth={1.5} />}
      title={title}
      description={hint}
      action={action}
      className="min-h-40"
    />
  );
}
