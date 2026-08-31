import { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { ChevronDown, Columns2, Eraser, FileText, MonitorCog, Rows2, Search, Sparkles } from "lucide-react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { Button } from "@/components/ui/button";
import { opsApi } from "@/api/ops-api";
import type { WorkspaceTab } from "@/workbench/types";
import { cn } from "@/lib/cn";

function ToolbarIcon({ label, icon: Icon, active }: { label: string; icon: React.ElementType; active?: boolean }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      className={cn(
        "flex h-6 w-6 items-center justify-center rounded-[5px] text-fg-muted hover:bg-surface-hover hover:text-fg",
        active && "text-accent",
      )}
    >
      <Icon size={14} strokeWidth={1.75} />
    </button>
  );
}

export function TerminalView({ tab }: { tab: WorkspaceTab }) {
  const terminalRef = useRef<HTMLDivElement>(null);
  const terminal = useRef<Terminal | null>(null);
  const sessionId = useRef(tab.sessionId ?? crypto.randomUUID());
  const [status, setStatus] = useState(tab.serverId ? "未连接" : "本地终端");

  useEffect(() => {
    if (!terminalRef.current) return;
    const instance = new Terminal({ convertEol: true, cursorBlink: true, fontSize: 13, theme: { background: "#090c10", foreground: "#c7d0dc" } });
    const fit = new FitAddon();
    instance.loadAddon(fit);
    instance.open(terminalRef.current);
    fit.fit();
    terminal.current = instance;
    instance.writeln("运维终端 — 交互式 SSH 会话");
    instance.write("$ ");
    let currentInput = "";
    const input = instance.onData(async (data) => {
      if (data === "\r") {
        instance.write("\r\n");
        if (tab.serverId) await opsApi.sshInput(sessionId.current, `${currentInput}\n`);
        currentInput = "";
      } else if (data === "\u007f") {
        if (currentInput.length > 0) { currentInput = currentInput.slice(0, -1); instance.write("\b \b"); }
      } else if (data === "\u001b[A" || data === "\u001b[B" || data === "\u001b[C" || data === "\u001b[D") {
        if (tab.serverId) await opsApi.sshInput(sessionId.current, data);
      } else if (data >= " ") { currentInput += data; instance.write(data); }
    });
    const resize = () => { fit.fit(); if (tab.serverId) void opsApi.sshResize(sessionId.current, instance.cols, instance.rows); };
    window.addEventListener("resize", resize);
    resize();
    let unlistenOutput: (() => void) | undefined;
    const bootstrap = async () => {
      if (!tab.serverId) {
        setStatus("本地终端");
        return;
      }
      try {
        await opsApi.sshConnect(sessionId.current, tab.serverId);
        setStatus("已连接");
        unlistenOutput = await listen<string>(`ssh-output-${sessionId.current}`, (event) => {
          instance.write(event.payload);
        });
      } catch (error) {
        setStatus("连接失败");
        instance.writeln(`\\r\\n连接失败：${String(error)}`);
      }
    };
    void bootstrap();
    return () => { input.dispose(); window.removeEventListener("resize", resize); unlistenOutput?.(); if (tab.serverId) void opsApi.sshDisconnect(sessionId.current); instance.dispose(); terminal.current = null; };
  }, [tab.serverId]);

  return (
    <div className="flex h-full min-h-0 flex-col bg-app">
      <div className="flex h-8 shrink-0 items-center gap-2 border-b border-line bg-surface-1 px-3">
        <span className={cn("h-[6px] w-[6px] rounded-full", status === "已连接" ? "bg-success" : "bg-warning")} />
        <span className="text-12 font-semibold text-fg">{tab.title}</span>
        {tab.subtitle && <span className="truncate text-11 text-fg-subtle">{tab.subtitle}</span>}
        <span className="ml-auto flex items-center gap-1 rounded-control border border-line bg-surface-2 px-2 py-0.5 text-11 text-fg-muted">
          Ubuntu 24.04 · 4 核 CPU · 内存 42%
        </span>
      </div>

      <div className="flex h-9 shrink-0 items-center gap-0.5 border-b border-line bg-surface-1 px-1.5">
        <ToolbarIcon label="搜索" icon={Search} />
        <ToolbarIcon label="垂直分栏" icon={Columns2} />
        <ToolbarIcon label="水平分栏" icon={Rows2} />
        <ToolbarIcon label="清空" icon={Eraser} />
        <div className="mx-1.5 h-4 w-px bg-line" />
        <Button variant="ghost" size="xs" className="gap-1 text-11">
          <ChevronDown size={12} />
          <span>API-01</span>
        </Button>
        <div className="ml-auto flex items-center gap-0.5">
          <ToolbarIcon label="文件" icon={FileText} />
          <ToolbarIcon label="监控" icon={MonitorCog} />
          <ToolbarIcon label="智能助手" icon={Sparkles} />
        </div>
      </div>

      <div ref={terminalRef} className="min-h-0 flex-1 overflow-hidden bg-[#090c10] p-3" data-selectable />

      <div className="flex h-6 shrink-0 items-center gap-3 border-t border-line bg-surface-1 px-3 text-11 text-fg-subtle">
        <span className="flex items-center gap-1">
          <span className="h-[5px] w-[5px] rounded-full bg-success" />
          {status}
        </span>
        <span>18 ms</span>
        <span className="ml-auto">UTF-8</span>
        <span>CRLF</span>
        <span>xterm</span>
      </div>
    </div>
  );
}
