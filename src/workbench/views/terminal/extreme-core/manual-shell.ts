/**
 * 右栏「手动终端」的会话管理。
 *
 * 生命周期**不放在标签组件里**：xterm 实例、PTY 通道和输出订阅都缓存在
 * 这里，按 workspace 索引。切到「实时日志」「执行输出」再切回来时，组件
 * 只是把同一个 DOM 容器重新挂上去，输入、回显、`cd` 状态都还在。
 *
 * SSH 通道是**独立的一条**（`ssh_shell_open`），与主终端、AI 执行都分开。
 */
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import { listen } from "@tauri-apps/api/event";
import "@xterm/xterm/css/xterm.css";

import { opsApi } from "@/api/ops-api";
import { sshShellClosedEvent, sshShellOutputEvent } from "@/lib/events";

interface ManualShell {
  shellId: string;
  sessionId: string;
  term: Terminal;
  fit: FitAddon;
  host: HTMLDivElement;
  disposers: Array<() => void>;
  resizeObserver?: ResizeObserver;
}

const shells = new Map<string, ManualShell>();

function terminalTheme() {
  const raw = getComputedStyle(document.documentElement).getPropertyValue("--fg").trim();
  return {
    background: "#00000000",
    foreground: raw ? `rgb(${raw})` : "#c9d1d9",
    cursor: "#58a6ff",
  };
}

/** 确保这个会话有一条可用的手动终端（已存在就复用）。 */
export async function ensureManualShell(
  workspaceId: string,
  sessionId: string,
): Promise<void> {
  const existing = shells.get(workspaceId);
  if (existing && existing.sessionId === sessionId) return;
  if (existing) disposeManualShell(workspaceId);

  const term = new Terminal({
    fontSize: 11,
    fontFamily: 'var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace)',
    cursorBlink: true,
    scrollback: 2000,
    allowTransparency: true,
    convertEol: true,
    theme: terminalTheme(),
  });
  const fit = new FitAddon();
  term.loadAddon(fit);

  const host = document.createElement("div");
  host.className = "h-full w-full";
  term.open(host);

  const shellId = `manual-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const entry: ManualShell = {
    shellId,
    sessionId,
    term,
    fit,
    host,
    disposers: [],
  };
  shells.set(workspaceId, entry);

  term.onData((data) => {
    term.scrollToBottom();
    void opsApi.sshShellInput(shellId, data).catch(() => undefined);
  });

  const offOutput = await listen<string>(sshShellOutputEvent(shellId), (event) => {
    const { baseY, viewportY } = term.buffer.active;
    term.write(event.payload, () => {
      if (viewportY === baseY && term.buffer.active.viewportY >= baseY) term.scrollToBottom();
    });
  });
  const offClosed = await listen(sshShellClosedEvent(shellId), () => {
    term.write("\r\n[连接已关闭]\r\n");
  });
  entry.disposers.push(offOutput, offClosed);

  await opsApi
    .sshShellOpen(sessionId, shellId, term.cols, term.rows)
    .catch((cause: unknown) => {
      term.write(`\r\n${cause instanceof Error ? cause.message : String(cause)}\r\n`);
    });
}

/** 把终端挂到面板容器上（组件卸载时只摘掉 DOM，不销毁实例）。 */
export function attachManualShell(workspaceId: string, container: HTMLElement): void {
  const entry = shells.get(workspaceId);
  if (!entry) return;
  container.appendChild(entry.host);

  const sync = () => {
    const { baseY, viewportY } = entry.term.buffer.active;
    entry.fit.fit();
    if (viewportY === baseY) entry.term.scrollToBottom();
    void opsApi
      .sshShellResize(entry.shellId, entry.term.cols, entry.term.rows)
      .catch(() => undefined);
  };
  requestAnimationFrame(() => {
    sync();
    entry.term.focus();
  });

  entry.resizeObserver?.disconnect();
  entry.resizeObserver = new ResizeObserver(sync);
  entry.resizeObserver.observe(container);
}

export function detachManualShell(workspaceId: string, container: HTMLElement): void {
  const entry = shells.get(workspaceId);
  if (!entry) return;
  entry.resizeObserver?.disconnect();
  entry.resizeObserver = undefined;
  if (entry.host.parentElement === container) container.removeChild(entry.host);
}

/** 关闭并销毁（换会话 / 退出超能时调用）。 */
export function disposeManualShell(workspaceId: string): void {
  const entry = shells.get(workspaceId);
  if (!entry) return;
  shells.delete(workspaceId);
  entry.resizeObserver?.disconnect();
  for (const off of entry.disposers) off();
  entry.host.remove();
  entry.term.dispose();
  void opsApi.sshShellClose(entry.shellId).catch(() => undefined);
}

/** 退出超能时清掉所有会话。 */
export function disposeAllManualShells(): void {
  for (const workspaceId of [...shells.keys()]) disposeManualShell(workspaceId);
}

/** 当前会话的终端通道 id（没有就是 null）。 */
export function manualShellId(workspaceId: string): string | null {
  return shells.get(workspaceId)?.shellId ?? null;
}

/**
 * 读最近输出（命令回显 + 返回），作为 AI 的上下文。
 *
 * 由后端缓冲提供：即使 xterm 已经滚掉，AI 也能看到最近 2000 行。
 */
export async function manualShellTail(workspaceId: string, lines = 120): Promise<string> {
  const shellId = manualShellId(workspaceId);
  if (!shellId) return "";
  return opsApi.sshShellTail(shellId, lines).catch(() => "");
}

/**
 * 把一条命令写进真实终端（不等待返回）。
 *
 * 用于 `tail -F` / `journalctl -f` 这类要一直跑的监听：命令在 PTY 里常驻，
 * 输出持续显示在右栏，AI 之后用 `ssh_shell_tail` 读最近内容。
 */
export async function manualShellSend(
  workspaceId: string,
  command: string,
): Promise<boolean> {
  const entry = shells.get(workspaceId);
  if (!entry) return false;
  entry.term.scrollToBottom();
  try {
    await opsApi.sshShellInput(entry.shellId, `${command}\n`);
  } catch {
    return false;
  }
  entry.term.focus();
  return true;
}
