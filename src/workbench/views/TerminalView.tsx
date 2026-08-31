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
import { LineEditor } from "@/lib/terminal-line-editor";
import type { WorkspaceTab } from "@/workbench/types";
import { cn } from "@/lib/cn";

const KEEPALIVE_MS = 30_000;
/** Consecutive failed probes before the session is declared dead. */
const KEEPALIVE_MAX_FAILURES = 2;

type Phase = "idle" | "connecting" | "connected" | "error" | "closed";

/** xterm palette matching the app theme (light-first, follows system). */
function terminalTheme(dark: boolean): Record<string, string> {
  return dark
    ? {
        background: "#0d1117",
        foreground: "#c9d1d9",
        cursor: "#5b9cff",
        cursorAccent: "#0d1117",
        selectionBackground: "rgba(91,156,255,0.35)",
        black: "#16181d",
        red: "#f26057",
        green: "#4fd186",
        yellow: "#f0bb4e",
        blue: "#5b9cff",
        magenta: "#b39dff",
        cyan: "#6bd5e1",
        white: "#c7d0dc",
        brightBlack: "#6b7380",
        brightRed: "#ff7b72",
        brightGreen: "#7ee2a8",
        brightYellow: "#ffd484",
        brightBlue: "#9ecbff",
        brightMagenta: "#d2c5ff",
        brightCyan: "#9be8f0",
        brightWhite: "#eceef2",
      }
    : {
        background: "#ffffff",
        foreground: "#1f2329",
        cursor: "#3175f1",
        cursorAccent: "#ffffff",
        selectionBackground: "rgba(49,117,241,0.25)",
        black: "#24292f",
        red: "#cf222e",
        green: "#1a7f37",
        yellow: "#9a6700",
        blue: "#0969da",
        magenta: "#8250df",
        cyan: "#1b7c83",
        white: "#6e7781",
        brightBlack: "#57606a",
        brightRed: "#d1242f",
        brightGreen: "#116329",
        brightYellow: "#7d4e00",
        brightBlue: "#0a68cf",
        brightMagenta: "#6639ba",
        brightCyan: "#126d73",
        brightWhite: "#24292f",
      };
}

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
        "flex h-7 w-7 items-center justify-center rounded-[8px] border border-transparent text-fg-muted transition-all duration-150 ease-out hover:border-line hover:bg-surface-2 hover:text-fg active:scale-[0.98]",
        active && "border-line bg-surface-active text-accent shadow-[inset_0_1px_0_rgb(255_255_255/0.45)]",
        disabled && "pointer-events-none opacity-40",
      )}
    >
      <Icon size={13} strokeWidth={1.75} />
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
  const updateTab = useWorkbenchStore((s) => s.updateTab);
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

  // Recovers the command being typed from the raw keystroke stream so it can be
  // recorded as history. Created once per session.
  const lineEditorRef = useRef<LineEditor | null>(null);
  if (!lineEditorRef.current) lineEditorRef.current = new LineEditor();

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
        password: tab.oneTimePassword,
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
        // The one-time password has served its purpose; drop it from tab state
        // so it is not kept in memory or reused for a later reconnect.
        if (tab.oneTimePassword) updateTab(tab.id, { oneTimePassword: undefined });
        return;
      }

      // Host key needs a human decision — never silently accepted.
      // With ProxyJump `challenge_host` is a jump host, so the copy has to
      // name the endpoint being trusted rather than the tab's destination.
      const challengeLabel = `${result.challenge_host}:${result.challenge_port}`;
      const isJumpHop = challengeLabel !== `${result.host}:${result.port}`;
      setPhase("error");
      setError(
        result.status === "host_key_changed"
          ? `${challengeLabel} 的主机指纹已变化，请确认后再连接`
          : `首次连接 ${challengeLabel}，请确认主机指纹`,
      );
      setStatus(sessionId, "error", { error: "等待主机指纹确认" });
      raiseChallenge({
        sessionId,
        kind: result.status === "host_key_changed" ? "changed" : "unknown",
        challengeHost: result.challenge_host,
        challengePort: result.challenge_port,
        targetHost: result.host,
        targetPort: result.port,
        isJumpHop,
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
  }, [
    raiseChallenge,
    register,
    sessionId,
    setStatus,
    tab.credentialId,
    tab.id,
    tab.oneTimePassword,
    tab.quickTarget,
    tab.serverId,
    tab.subtitle,
    tab.title,
    updateTab,
  ]);

  // Terminal instance + data plumbing.
  useEffect(() => {
    if (!containerRef.current || !hasTarget) return;

    const isDark = document.documentElement.dataset.theme === "dark";
    const instance = new Terminal({
      convertEol: true,
      cursorBlink: true,
      fontSize: 13,
      scrollback: 5000,
      theme: terminalTheme(isDark),
    });
    const fit = new FitAddon();
    instance.loadAddon(fit);
    instance.open(containerRef.current);
    fit.fit();
    terminalRef.current = instance;
    fitRef.current = fit;
    setSize({ cols: instance.cols, rows: instance.rows });

    // Follow the app theme live (system theme can change while running).
    const themeObserver = new MutationObserver(() => {
      instance.options.theme = terminalTheme(document.documentElement.dataset.theme === "dark");
    });
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });

    const dataSubscription = instance.onData((data) => {
      // Recover whole commands from the raw stream; arrow keys, Ctrl+C, pastes
      // and line continuations are handled by the editor.
      const commands = lineEditorRef.current?.feed(data) ?? [];
      for (const command of commands) {
        if (tab.serverId || tab.quickTarget) {
          void opsApi
            .recordHistory(sessionId, tab.serverId ?? "", tab.title, command)
            .catch(() => undefined);
        }
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

    void connect();

    return () => {
      disposed = true;
      resizeObserver.disconnect();
      themeObserver.disconnect();
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

  // Keepalive only runs while the session is actually connected. Consecutive
  // failures flip the session to "closed" so the UI stops claiming a live
  // connection that the server has already dropped.
  useEffect(() => {
    if (phase !== "connected") return;

    let failures = 0;
    const timer = window.setInterval(() => {
      opsApi.sshKeepalive(sessionId).then(
        () => {
          failures = 0;
        },
        (cause) => {
          failures += 1;
          if (failures < KEEPALIVE_MAX_FAILURES) return;
          window.clearInterval(timer);
          const message = `连接已断开：${toErrorMessage(cause)}`;
          setPhase("closed");
          setError(message);
          setStatus(sessionId, "closed", { error: message });
          terminalRef.current?.writeln(`\r\n\x1b[31m${message}\x1b[0m`);
        },
      );
    }, KEEPALIVE_MS);

    return () => window.clearInterval(timer);
  }, [phase, sessionId, setStatus]);

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

      <div className="flex h-10 shrink-0 items-center gap-1 border-b border-line bg-surface-1/60 px-2 backdrop-blur-xl">
        <ToolbarIcon label="查找" icon={Search} active={searchOpen} onClick={() => setSearchOpen((v) => !v)} />
        <ToolbarIcon label="垂直分栏" icon={Columns2} onClick={() => splitPane(useWorkbenchStore.getState().focusedPaneId ?? "", "horizontal")} />
        <ToolbarIcon label="水平分栏" icon={Rows2} onClick={() => splitPane(useWorkbenchStore.getState().focusedPaneId ?? "", "vertical")} />
        <ToolbarIcon label="清空屏幕" icon={Eraser} onClick={() => terminalRef.current?.clear()} />
        <ToolbarIcon label="命令历史" icon={History} active={historyOpen} onClick={() => setHistoryOpen((v) => !v)} />
        <div className="mx-1 h-4 w-px bg-line" />
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
              className="h-[26px] w-48 rounded-[7px] border border-line bg-surface-2 px-2 text-11 text-fg outline-none placeholder:text-fg-subtle focus:border-accent"
            />
            <Button variant="ghost" size="xs" className="rounded-[7px]" onClick={runSearch}>
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
        <div ref={containerRef} className="min-h-0 min-w-0 flex-1 overflow-hidden bg-app p-2" data-selectable />
        {historyOpen && (
          <CommandHistoryPanel
            sessionId={sessionId}
            serverId={tab.serverId}
            onPick={(command) => void opsApi.sshInput(sessionId, `${command}\n`)}
          />
        )}
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

/**
 * Commands recorded for this session, falling back to earlier sessions on the
 * same server. Clicking one sends it to the shell.
 */
function CommandHistoryPanel({
  sessionId,
  serverId,
  onPick,
}: {
  sessionId: string;
  serverId?: string;
  onPick: (command: string) => void;
}) {
  const [items, setItems] = useState<{ id: string; command: string; timestamp: number }[]>([]);

  useEffect(() => {
    void opsApi
      .listHistory(200)
      .then((rows) =>
        setItems(
          rows
            .filter((row) => row.session_id === sessionId || (!!serverId && row.server_id === serverId))
            .map((row) => ({ id: row.id, command: row.command, timestamp: row.timestamp })),
        ),
      )
      .catch(() => setItems([]));
  }, [serverId, sessionId]);

  return (
    <aside className="flex w-56 shrink-0 flex-col border-l border-line bg-surface-1">
      <div className="flex h-7 shrink-0 items-center justify-between px-2.5 text-11 font-semibold tracking-[0.08em] text-fg-subtle uppercase">
        命令历史
        <span>{items.length}</span>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {items.length === 0 ? (
          <p className="px-2.5 py-2 text-11 text-fg-subtle">在此终端执行的命令会记录下来</p>
        ) : (
          items.map((item) => (
            <button
              key={item.id}
              type="button"
              title={`${item.command}\n${new Date(item.timestamp).toLocaleString()}`}
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
