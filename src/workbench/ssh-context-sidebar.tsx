import { useState } from "react";
import { ArrowRight, ChevronDown, ChevronRight, Plug, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useWorkbenchStore } from "@/stores/workbench-store";
import { cn } from "@/lib/cn";

/**
 * SSH Context Sidebar — spec §9.
 * Quick Connect / Favorites / Groups / Active Sessions.
 * Server rows are two-line: status dot + name, host below.
 * Data is static mock until Phase 2 (Server CRUD + real sessions).
 */

type ServerStatus = "connected" | "idle" | "reconnect" | "error";

const STATUS_DOT: Record<ServerStatus, string> = {
  connected: "bg-success",
  idle: "bg-fg-subtle",
  reconnect: "bg-warning",
  error: "bg-danger",
};

interface MockServer {
  id: string;
  name: string;
  host: string;
  status: ServerStatus;
  group?: string;
}

const FAVORITES: MockServer[] = [
  { id: "s1", name: "API-01", host: "10.0.0.11", status: "connected" },
  { id: "s2", name: "WEB-01", host: "10.0.0.21", status: "idle" },
];

const GROUPS: { title: string; servers: MockServer[] }[] = [
  {
    title: "生产环境",
    servers: [
      { id: "s3", name: "API-01", host: "10.0.0.11", status: "connected" },
      { id: "s4", name: "API-02", host: "10.0.0.12", status: "connected" },
      { id: "s5", name: "WEB-01", host: "10.0.0.21", status: "idle" },
    ],
  },
  {
    title: "测试环境",
    servers: [
      { id: "s6", name: "TEST-01", host: "10.0.0.51", status: "idle" },
      { id: "s7", name: "TEST-02", host: "10.0.0.52", status: "error" },
    ],
  },
];

const ACTIVE_SESSIONS: MockServer[] = [
  { id: "s8", name: "api-prod", host: "10.0.0.11:22", status: "connected" },
  { id: "s9", name: "web-prod", host: "10.0.0.21:22", status: "connected" },
];

function SectionTitle({ children, actions }: { children: React.ReactNode; actions?: React.ReactNode }) {
  return (
    <div className="flex h-7 shrink-0 items-center justify-between px-2.5">
      <span className="text-11 font-semibold tracking-[0.08em] text-fg-subtle uppercase">{children}</span>
      {actions}
    </div>
  );
}

function ServerRow({ server, onOpen }: { server: MockServer; onOpen?: (s: MockServer) => void }) {
  return (
    <button
      type="button"
      className="group flex w-full flex-col gap-0.5 rounded-[6px] px-2.5 py-1.5 text-left hover:bg-surface-hover"
      onClick={() => onOpen?.(server)}
    >
      <div className="flex items-center gap-1.5">
        <span className={cn("h-[6px] w-[6px] shrink-0 rounded-full", STATUS_DOT[server.status])} />
        <span className="truncate text-12 text-fg group-hover:text-fg">{server.name}</span>
      </div>
      <span className="truncate pl-[13px] text-11 text-fg-subtle">{server.host}</span>
    </button>
  );
}

function CollapsibleGroup({ title, servers, defaultOpen }: { title: string; servers: MockServer[]; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen ?? true);
  return (
    <div className="shrink-0">
      <button
        type="button"
        className="flex h-7 w-full items-center gap-1 px-2.5 hover:bg-surface-hover"
        onClick={() => setOpen((v) => !v)}
      >
        {open ? <ChevronDown size={12} className="text-fg-subtle" /> : <ChevronRight size={12} className="text-fg-subtle" />}
        <span className="text-11 font-semibold tracking-[0.08em] text-fg-subtle uppercase">{title}</span>
      </button>
      {open && <div className="pb-1">{servers.map((s) => <ServerRow key={s.id} server={s} onOpen={openServer} />)}</div>}
    </div>
  );
}

function openServer(server: MockServer) {
  useWorkbenchStore.getState().openTab({
    id: crypto.randomUUID(),
    type: "terminal",
    title: server.name,
    subtitle: server.host,
    serverId: server.id,
    connected: server.status === "connected",
  });
}

export function SshContextSidebar() {
  const [qc, setQc] = useState("");
  return (
    <div className="flex flex-col gap-1 pb-3">
      {/* Quick Connect */}
      <div className="px-2.5 pt-1.5">
        <SectionTitle actions={<Plug size={12} className="text-fg-subtle" />}>快速连接</SectionTitle>
        <div className="mt-1 flex items-center gap-1">
          <input
            value={qc}
            onChange={(e) => setQc(e.target.value)}
            placeholder="user@host:22"
            spellCheck={false}
            className="h-[30px] min-w-0 flex-1 rounded-control border border-line bg-surface-2 px-2 text-12 text-fg outline-none placeholder:text-fg-subtle focus:border-accent"
          />
          <Button variant="primary" size="sm" className="h-[30px] px-2" aria-label="连接">
            <ArrowRight size={14} />
          </Button>
        </div>
      </div>

      {/* Favorites */}
      <div className="mt-2">
        <SectionTitle actions={<Plus size={12} className="text-fg-subtle" />}>收藏</SectionTitle>
        <div className="mt-0.5">{FAVORITES.map((s) => <ServerRow key={s.id} server={s} onOpen={openServer} />)}</div>
      </div>

      {/* Groups */}
      {GROUPS.map((g) => (
        <CollapsibleGroup key={g.title} title={g.title} servers={g.servers} />
      ))}

      {/* Active Sessions */}
      <div className="mt-2 border-t border-line pt-1">
        <SectionTitle>活跃会话</SectionTitle>
        <div className="mt-0.5">{ACTIVE_SESSIONS.map((s) => <ServerRow key={s.id} server={s} onOpen={openServer} />)}</div>
      </div>
    </div>
  );
}
