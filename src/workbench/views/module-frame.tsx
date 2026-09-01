/**
 * Shared chrome for the P3 management modules.
 *
 * Every module page is session-driven and needs the same things: a header
 * showing which host the numbers came from, honest banners for each
 * connection state, a server picker when the tab has no server yet, and a
 * scroll area. Putting that here keeps five views from drifting apart — and
 * keeps "connection lost" looking the same everywhere.
 */
import { type ReactNode, useMemo, useState } from "react";
import {
  Activity,
  Loader2,
  PlugZap,
  RefreshCw,
  Server as ServerIcon,
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
    <div className="flex h-full flex-col items-center justify-center gap-3 bg-app px-6">
      <p className="text-13 text-fg-muted">选择一个服务器以开始</p>
      {servers.length === 0 ? (
        <p className="max-w-sm text-center text-12 text-fg-subtle">
          左侧“服务器”中还没有任何条目，请先新增服务器。
        </p>
      ) : (
        <div className="flex w-80 flex-col gap-2">
          <input
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            placeholder="搜索服务器…"
            className="h-[28px] rounded-[7px] border border-line bg-surface-2 px-2 text-12 text-fg outline-none placeholder:text-fg-subtle focus:border-accent"
          />
          <div className="flex max-h-[45vh] flex-col overflow-y-auto rounded-[8px] border border-line bg-surface-1">
            {visible.length === 0 ? (
              <p className="px-3 py-4 text-center text-12 text-fg-subtle">没有匹配的服务器</p>
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
        关闭此标签
      </Button>
    </div>
  );
}

const PHASE_TONE: Record<string, string> = {
  connected: "bg-success",
  connecting: "bg-warning",
  error: "bg-danger",
  closed: "bg-danger",
  idle: "bg-fg-subtle",
};

const PHASE_LABEL: Record<string, string> = {
  connected: "已连接",
  connecting: "连接中",
  error: "连接失败",
  closed: "已断开",
  idle: "未连接",
};

export function ModuleFrame({
  tab,
  session,
  icon: Icon,
  toolbar,
  children,
}: {
  tab: { id: string; title: string; subtitle?: string };
  session: CommandSession;
  icon: ReactNode | React.ElementType;
  /** Right-hand controls: refresh, filters, actions. */
  toolbar?: ReactNode;
  children: ReactNode;
}) {
  const Glyph = Icon as React.ElementType;

  if (!session.hasTarget) {
    return <ServerPicker tabId={tab.id} />;
  }

  const banner = () => {
    if (session.phase === "connecting") {
      return (
        <div className="flex shrink-0 items-center gap-2 border-b border-line bg-surface-2 px-3 py-2 text-12 text-fg-muted">
          <Activity size={13} className="shrink-0 animate-pulse text-accent" />
          <span>正在建立连接（不分配交互式终端）…</span>
        </div>
      );
    }
    if (session.phase === "error") {
      return (
        <div className="flex shrink-0 items-start gap-2 border-b border-danger/30 bg-danger/10 px-3 py-2 text-12 text-danger">
          <TriangleAlert size={13} className="mt-0.5 shrink-0" />
          <span className="min-w-0 flex-1">{session.error ?? "连接失败"}</span>
          <Button variant="ghost" size="xs" onClick={session.connect}>
            重试
          </Button>
        </div>
      );
    }
    if (session.phase === "closed") {
      return (
        <div className="flex shrink-0 items-center gap-2 border-b border-line bg-surface-2 px-3 py-2 text-12 text-fg-muted">
          <WifiOff size={13} className="shrink-0" />
          <span className="min-w-0 flex-1">{session.error ?? "SSH 连接已断开"}</span>
          <Button variant="ghost" size="xs" onClick={session.connect}>
            重新连接
          </Button>
        </div>
      );
    }
    return null;
  };

  return (
    <div className="flex h-full min-h-0 flex-col bg-app">
      <div className="flex h-8 shrink-0 items-center gap-2 border-b border-line bg-surface-1 px-3">
        <span
          className={cn(
            "h-[6px] w-[6px] shrink-0 rounded-full",
            PHASE_TONE[session.phase] ?? "bg-fg-subtle",
          )}
        />
        <Glyph size={13} className="shrink-0 text-fg-subtle" />
        <span className="truncate text-12 font-semibold text-fg">{tab.title}</span>
        {tab.subtitle && (
          <span className="truncate text-11 text-fg-subtle">{tab.subtitle}</span>
        )}
        <span className="ml-auto flex shrink-0 items-center gap-2 text-11 text-fg-subtle">
          {session.phase === "connected" && (
            <ServerIcon size={11} className="text-fg-subtle" />
          )}
          <span>{PHASE_LABEL[session.phase] ?? session.phase}</span>
        </span>
      </div>

      {toolbar && (
        <div className="flex h-10 shrink-0 flex-wrap items-center gap-1 border-b border-line bg-surface-1/60 px-2 backdrop-blur-xl">
          {toolbar}
        </div>
      )}

      {banner()}

      <div className="min-h-0 flex-1 overflow-auto">{children}</div>
    </div>
  );
}

/** A toolbar refresh button that shows a spinner while work is in flight. */
export function RefreshButton({
  busy,
  onClick,
  label = "刷新",
}: {
  busy: boolean;
  onClick: () => void;
  label?: string;
}) {
  return (
    <Button variant="ghost" size="xs" disabled={busy} onClick={onClick}>
      {busy ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />}
      {label}
    </Button>
  );
}

/** A "no data yet" / "nothing matches" placeholder for module tables. */
export function ModuleEmpty({
  icon: Icon = PlugZap,
  title,
  hint,
}: {
  icon?: React.ElementType;
  title: string;
  hint?: string;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 px-6 py-12 text-center">
      <Icon size={20} className="text-fg-subtle" />
      <p className="text-13 text-fg-muted">{title}</p>
      {hint && <p className="max-w-md text-12 text-fg-subtle">{hint}</p>}
    </div>
  );
}
