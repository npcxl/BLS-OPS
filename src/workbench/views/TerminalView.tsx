import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import {
  Columns2,
  Eraser,
  History,
  PlugZap,
  Rows2,
  Search,
  Unplug,
  WifiOff,
} from "lucide-react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { Button } from "@/components/ui/button";
import { opsApi, toErrorMessage, type ServerRecord } from "@/api/ops-api";
import { useDomainStore } from "@/stores/domain-store";
import { useSessionStore } from "@/stores/session-store";
import { useWorkbenchStore } from "@/stores/workbench-store";
import type { WorkspaceTab } from "@/workbench/types";
import { cn } from "@/lib/cn";

const KEEPALIVE_MS = 30_000;

type Phase = "idle" | "connecting" | "connected" | "error" | "closed";

function ToolbarIcon({
  label,
  icon: Icon,
  active,
  disabled,
  onClick,
}: {
  label: string;
  icon: React.ElementType;
  active?: boolean;
  disabled?: boolean;
  onClick?: () => void;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "flex h-6 w-6 items-center justify-center rounded-[5px] text-fg-muted hover:bg-surface-hover hover:text-fg",
        active && "text-accent",
        disabled && "pointer-events-none opacity-40",
      )}
    >
      <Icon size={14} strokeWidth={1.75} />
    </button>
  );
}

/** Real interactive SSH terminal: input, output, resize, reconnect, keepalive. */
export function TerminalView({ tab }: { tab: WorkspaceTab }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  // A tab created without a connection still needs a stable id; once the user
  // picks a target the tab carries its own session id.
  const fallbackSessionRef = useRef<string | null>(null);
  if (!fallbackSessionRef.current) fallbackSessionRef.current = crypto.randomUUID();
  const sessionId = tab.sessionId ?? fallbackSessionRef.current;
  const connectingRef = useRef(false);

  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState<string | null>(null);
  const [connectMs, setConnectMs] = useState<number | null>(null);
  const [fingerprint, setFingerprint] = useState<string | null>(null);
  const [size, setSize] = useState({ cols: 0, rows: 0 });
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchState, setSearchState] = useState<{ index: number; total: number } | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);

  const splitPane = useWorkbenchStore((s) => s.splitPane);
  const servers = useDomainStore((s) => s.servers);
  const register = useSessionStore((s) => s.register);
  const setStatus = useSessionStore((s) => s.setStatus);
  const removeSession = useSessionStore((s) => s.remove);
  const raiseChallenge = useSessionStore((s) => s.raiseChallenge);

  const hasTarget = Boolean(tab.serverId || tab.quickTarget);
  const server = useMemo(
    () => servers.find((item) => item.id === tab.serverId),
    [servers, tab.serverId],
  );

  // Keeps track of the line being typed so it can be stored as command history.
  const lineRef = useRef("");

  const connect = useCallback(async () => {
    if (connectingRef.current) return;
    connectingRef.current = true;
    setPhase("connecting");
    setError(null);

    const instance = terminalRef.current;
    const cols = instance?.cols ?? 120;
    const rows = instance?.rows ?? 32;
    const startedAt = performance.now();

    register({
      sessionId,
      tabId: tab.id,
      title: tab.title,
      subtitle: tab.subtitle,
      serverId: tab.serverId,
    });

    try {
      const result = await opsApi.sshConnect({
        sessionId,
        serverId: tab.serverId,
        target: tab.quickTarget,
        credentialId: tab.credentialId,
        cols,
        rows,
      });

      if (result.status === "connected") {
        const elapsed = Math.round(performance.now() - startedAt);
        setConnectMs(elapsed);
        setFingerprint(result.fingerprint);
        setPhase("connected");
        setStatus(sessionId, "connected", { connectMs: elapsed, connectedAt: Date.now() });
        instance?.writeln(`\r\n已连接 ${result.host}:${result.port}（${result.fingerprint_type}）`);
        return;
      }

      // Host key needs a human decision — never silently accepted.
      setPhase("error");
      setError(
        result.status === "host_key_changed"
          ? `${result.hop} 的主机指纹已变化，请确认后再连接`
          : `首次连接 ${result.hop}，请确认主机指纹`,
      );
      setStatus(sessionId, "error", { error: "等待主机指纹确认" });
      raiseChallenge({
        sessionId,
        kind: result.status === "host_key_changed" ? "changed" : "unknown",
        host: result.host,
        port: result.port,
        hop: result.hop,
        fingerprint: result.fingerprint,
        fingerprintType: result.fingerprint_type,
        knownFingerprint: "known_fingerprint" in result ? result.known_fingerprint : undefined,
        retry: () => void connect(),
        cancel: () => {
          setPhase("closed");
          setStatus(sessionId, "closed");
        },
      });
    } catch (cause) {
      const message = toErrorMessage(cause);
      setPhase("error");
      setError(message);
      setStatus(sessionId, "error", { error: message });
      instance?.writeln(`\r\n\x1b[31m连接失败：${message}\x1b[0m`);
    } finally {
      connectingRef.current = false;
    }
  }, [raiseChallenge, register, sessionId, setStatus, tab.credentialId, tab.id, tab.quickTarget, tab.serverId, tab.subtitle, tab.title]);

  // Terminal instance + data plumbing.
  useEffect(() => {
    if (!containerRef.current || !hasTarget) return;

    const instance = new Terminal({
      convertEol: true,
      cursorBlink: true,
      fontSize: 13,
      scrollback: 5000,
      theme: { background: "#090c10", foreground: "#c7d0dc" },
    });
    const fit = new FitAddon();
    instance.loadAddon(fit);
    instance.open(containerRef.current);
    fit.fit();
    terminalRef.current = instance;
    fitRef.current = fit;
    setSize({ cols: instance.cols, rows: instance.rows });

    const dataSubscription = instance.onData((data) => {
      if (data === "\r") {
        const command = lineRef.current.trim();
        lineRef.current = "";
        if (command && (tab.serverId || tab.quickTarget)) {
          void opsApi
            .recordHistory(sessionId, tab.serverId ?? "", tab.title, command)
            .catch(() => undefined);
        }
      } else if (data === "\u007f") {
        lineRef.current = lineRef.current.slice(0, -1);
      } else if (data >= " " || data === "\t") {
        lineRef.current += data;
      }
      void opsApi.sshInput(sessionId, data).catch(() => undefined);
    });

    const resizeObserver = new ResizeObserver(() => {
      try {
        fit.fit();
      } catch {
        return;
      }
      setSize({ cols: instance.cols, rows: instance.rows });
      if (instance.cols > 0 && instance.rows > 0) {
        void opsApi.sshResize(sessionId, instance.cols, instance.rows).catch(() => undefined);
      }
    });
    resizeObserver.observe(containerRef.current);

    let disposed = false;
    const unlistenOutput = listen<string>(`ssh-output-${sessionId}`, (event) => {
      if (!disposed) instance.write(event.payload);
    });
    const unlistenClosed = listen<string>(`ssh-closed-${sessionId}`, () => {
      if (disposed) return;
      setPhase((current) => (current === "connected" ? "closed" : current));
      setStatus(sessionId, "closed");
    });

    const keepalive = window.setInterval(() => {
      opsApi.sshKeepalive(sessionId).catch(() => undefined);
    }, KEEPALIVE_MS);

    void connect();

    return () => {
      disposed = true;
      window.clearInterval(keepalive);
      resizeObserver.disconnect();
      dataSubscription.dispose();
      void unlistenOutput.then((fn) => fn());
      void unlistenClosed.then((fn) => fn());
      void opsApi.sshDisconnect(sessionId).catch(() => undefined);
      removeSession(sessionId);
      instance.dispose();
      terminalRef.current = null;
      fitRef.current = null;
    };
    // Reconnecting on target change is intentional; `connect` is stable per mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasTarget, sessionId]);

  const runSearch = useCallback(() => {
    const instance = terminalRef.current;
    if (!instance || !searchQuery.trim()) {
      setSearchState(null);
      return;
    }
    const needle = searchQuery.toLowerCase();
    const buffer = instance.buffer.active;
    let total = 0;
    let firstLine: number | null = null;
    for (let i = 0; i < buffer.length; i += 1) {
      const text = buffer.getLine(i)?.translateToString(true).toLowerCase() ?? "";
      if (text.includes(needle)) {
        total += 1;
        firstLine ??= i;
      }
    }
    if (firstLine === null) {
      setSearchState({ index: 0, total: 0 });
      return;
    }
    // Walk forward from the current position so repeated searches advance.
    const start = (searchState?.index ?? 0) % Math.max(total, 1);
    let seen = -1;
    let target = firstLine;
    for (let i = 0; i < buffer.length && seen < start; i += 1) {
      const text = buffer.getLine(i)?.translateToString(true).toLowerCase() ?? "";
      if (!text.includes(needle)) continue;
      seen += 1;
      target = i;
    }
    instance.scrollToLine(target);
    setSearchState({ index: (seen + 1) % Math.max(total, 1), total });
  }, [searchQuery, searchState]);

  if (!hasTarget) {
    return <TerminalPicker tabId={tab.id} servers={servers} />;
  }

  const statusLabel =
    phase === "connected"
      ? "已连接"
      : phase === "connecting"
        ? "连接中"
        : phase === "closed"
          ? "已断开"
          : phase === "error"
            ? "连接失败"
            : "未连接";

  return (
    <div className="flex h-full min-h-0 flex-col bg-app">
      <div className="flex h-8 shrink-0 items-center gap-2 border-b border-line bg-surface-1 px-3">
        <span
          className={cn(
            "h-[6px] w-[6px] rounded-full",
            phase === "connected" ? "bg-success" : phase === "error" ? "bg-danger" : "bg-warning",
          )}
        />
        <span className="text-12 font-semibold text-fg">{tab.title}</span>
        {tab.subtitle && <span className="truncate text-11 text-fg-subtle">{tab.subtitle}</span>}
        {server && (
          <span className="ml-auto truncate text-11 text-fg-subtle">
            {server.username}@{server.host}:{server.port}
            {server.proxy_jump_id ? " · 经跳板机" : ""}
          </span>
        )}
      </div>

      <div className="flex h-9 shrink-0 items-center gap-0.5 border-b border-line bg-surface-1 px-1.5">
        <ToolbarIcon label="查找" icon={Search} active={searchOpen} onClick={() => setSearchOpen((v) => !v)} />
        <ToolbarIcon label="垂直分栏" icon={Columns2} onClick={() => splitPane(useWorkbenchStore.getState().focusedPaneId ?? "", "horizontal")} />
        <ToolbarIcon label="水平分栏" icon={Rows2} onClick={() => splitPane(useWorkbenchStore.getState().focusedPaneId ?? "", "vertical")} />
        <ToolbarIcon label="清空屏幕" icon={Eraser} onClick={() => terminalRef.current?.clear()} />
        <ToolbarIcon label="命令历史" icon={History} active={historyOpen} onClick={() => setHistoryOpen((v) => !v)} />
        <div className="mx-1.5 h-4 w-px bg-line" />
        {phase === "connected" ? (
          <ToolbarIcon
            label="断开连接"
            icon={Unplug}
            onClick={() => {
              void opsApi.sshDisconnect(sessionId).catch(() => undefined);
              setPhase("closed");
              setStatus(sessionId, "closed");
            }}
          />
        ) : (
          <ToolbarIcon label="重新连接" icon={PlugZap} disabled={phase === "connecting"} onClick={() => void connect()} />
        )}

        {searchOpen && (
          <div className="ml-2 flex items-center gap-1">
            <input
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") runSearch();
              }}
              placeholder="在回滚缓冲中查找"
              spellCheck={false}
              className="h-[24px] w-48 rounded-[5px] border border-line bg-surface-2 px-2 text-11 text-fg outline-none placeholder:text-fg-subtle focus:border-accent"
            />
            <Button variant="ghost" size="xs" onClick={runSearch}>
              查找
            </Button>
            {searchState && (
              <span className="text-11 text-fg-subtle">
                {searchState.total === 0 ? "无匹配" : `${searchState.index + 1}/${searchState.total}`}
              </span>
            )}
          </div>
        )}
      </div>

      {error && (
        <div className="flex shrink-0 items-center gap-2 border-b border-danger/30 bg-danger/10 px-3 py-1.5 text-11 text-danger">
          <WifiOff size={12} />
          <span className="min-w-0 flex-1 truncate">{error}</span>
          <Button variant="ghost" size="xs" onClick={() => void connect()}>
            重试
          </Button>
        </div>
      )}

      <div className="flex min-h-0 flex-1">
        <div ref={containerRef} className="min-h-0 min-w-0 flex-1 overflow-hidden bg-[#090c10] p-2" data-selectable />
        {historyOpen && <CommandHistoryPanel sessionId={sessionId} onPick={(command) => void opsApi.sshInput(sessionId, `${command}\n`)} />}
      </div>

      <div className="flex h-6 shrink-0 items-center gap-3 border-t border-line bg-surface-1 px-3 text-11 text-fg-subtle">
        <span className="flex items-center gap-1">
          <span
            className={cn(
              "h-[5px] w-[5px] rounded-full",
              phase === "connected" ? "bg-success" : phase === "error" ? "bg-danger" : "bg-fg-subtle",
            )}
          />
          {statusLabel}
        </span>
        {connectMs !== null && <span>握手 {connectMs} ms</span>}
        {fingerprint && <span className="truncate">{fingerprint}</span>}
        <span className="ml-auto">
          {size.cols}×{size.rows}
        </span>
        <span>UTF-8</span>
        <span>keepalive 30s</span>
      </div>
    </div>
  );
}

function CommandHistoryPanel({
  sessionId,
  onPick,
}: {
  sessionId: string;
  onPick: (command: string) => void;
}) {
  const [items, setItems] = useState<{ id: string; command: string; timestamp: number }[]>([]);

  useEffect(() => {
    void opsApi
      .listHistory(200)
      .then((rows) =>
        setItems(
          rows
            .filter((row) => row.session_id === sessionId || row.source === "terminal")
            .map((row) => ({ id: row.id, command: row.command, timestamp: row.timestamp })),
        ),
      )
      .catch(() => setItems([]));
  }, [sessionId]);

  return (
    <aside className="flex w-56 shrink-0 flex-col border-l border-line bg-surface-1">
      <div className="flex h-7 shrink-0 items-center px-2.5 text-11 font-semibold tracking-[0.08em] text-fg-subtle uppercase">
        命令历史
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {items.length === 0 ? (
          <p className="px-2.5 py-2 text-11 text-fg-subtle">暂无记录</p>
        ) : (
          items.map((item) => (
            <button
              key={item.id}
              type="button"
              title={item.command}
              className="block w-full truncate px-2.5 py-1 text-left text-11 text-fg-muted hover:bg-surface-hover hover:text-fg"
              onClick={() => onPick(item.command)}
            >
              {item.command}
            </button>
          ))
        )}
      </div>
    </aside>
  );
}

/** Shown when a terminal tab has no connection target yet. */
function TerminalPicker({ tabId, servers }: { tabId: string; servers: ServerRecord[] }) {
  const updateTab = useWorkbenchStore((s) => s.updateTab);
  const closeTabById = useWorkbenchStore((s) => s.closeTabById);

  const attach = (server: ServerRecord) =>
    updateTab(tabId, {
      title: server.name,
      subtitle: `${server.host}:${server.port}`,
      serverId: server.id,
      sessionId: crypto.randomUUID(),
      connected: false,
    });

  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 bg-app">
      <p className="text-13 text-fg-muted">选择一个服务器以开始 SSH 会话</p>
      {servers.length === 0 ? (
        <p className="text-12 text-fg-subtle">左侧“服务器”中还没有任何条目，请先新增服务器。</p>
      ) : (
        <div className="flex max-h-[50vh] w-72 flex-col overflow-y-auto rounded-[8px] border border-line bg-surface-1">
          {servers.map((server) => (
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
          ))}
        </div>
      )}
      <Button variant="ghost" size="sm" onClick={() => closeTabById(tabId)}>
        关闭此标签
      </Button>
    </div>
  );
}
