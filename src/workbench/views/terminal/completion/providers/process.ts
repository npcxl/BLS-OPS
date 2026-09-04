/**
 * ProcessProvider —— `kill` / `killall` 的进程参数补全。
 *
 * 进程列表来自服务器的 `ps`（只取可执行名，不含命令行 —— 命令行里可能有
 * 密码）。补全值是 **PID**（`kill` 只认 PID）；`killall` 补进程名。
 */

import { opsApi, type ProcessInfo } from "@/api/ops-api";
import { i18n } from "@/i18n";
import { quotePathSegment } from "../path-input";
import type {
  CompletionContext,
  CompletionItem,
  CompletionProvider,
  CompletionResult,
  ParsedLine,
} from "../types";

const CACHE_TTL_MS = 5_000;
let cache: { sessionId: string; at: number; processes: ProcessInfo[] } | null = null;

export function invalidateProcessCache(): void {
  cache = null;
}

export type ProcessLister = (sessionId: string) => Promise<ProcessInfo[]>;

let lister: ProcessLister = (sessionId) => opsApi.monitorProcesses(sessionId);
export function setProcessLister(next: ProcessLister | null): void {
  lister = next ?? ((sessionId: string) => opsApi.monitorProcesses(sessionId));
}

async function listProcesses(sessionId: string): Promise<ProcessInfo[]> {
  if (cache && cache.sessionId === sessionId && Date.now() - cache.at < CACHE_TTL_MS) {
    return cache.processes;
  }
  const processes = await lister(sessionId);
  cache = { sessionId, at: Date.now(), processes };
  return processes;
}

export function createProcessProvider(): CompletionProvider {
  return {
    id: "process",
    matches(parsed: ParsedLine): boolean {
      // `kill <pid>` / `killall <name>`：第一个参数位。
      return (parsed.command === "kill" || parsed.command === "killall") && parsed.index === 1;
    },
    async complete(ctx: CompletionContext, parsed: ParsedLine): Promise<CompletionResult> {
      const partial = parsed.prefix;
      const byName = parsed.command === "killall";
      const requestKey = `process:${ctx.sessionId}:${byName ? "name" : "pid"}:${partial}`;

      let processes: ProcessInfo[];
      try {
        processes = await listProcesses(ctx.sessionId);
      } catch (cause) {
        return {
          items: [],
          notice: i18n.t("Failed to read process list: {{message}}", {
            message: cause instanceof Error ? cause.message : String(cause),
          }),
          requestKey,
        };
      }

      const start = ctx.cursor - partial.length;
      if (byName) {
        const names = [...new Set(processes.map((item) => item.command))]
          .filter((name) => name.startsWith(partial))
          .sort((a, b) => a.localeCompare(b));
        if (names.length === 0) return { items: [], notice: "No matching processes", requestKey };
        const items: CompletionItem[] = names.map((name, index) => ({
          label: name,
          insertText: quotePathSegment(name, null, false),
          detail: "Process name",
          icon: "process",
          type: "process",
          replaceRange: { start, end: ctx.cursor },
          priority: 100 - index,
          source: "process",
          highlight: partial ? { start: 0, length: partial.length } : undefined,
        }));
        return { items, requestKey };
      }

      const matched = processes.filter((item) => String(item.pid).startsWith(partial));
      if (matched.length === 0) return { items: [], notice: "No matching processes", requestKey };
      const items: CompletionItem[] = matched.map((item, index) => ({
        label: String(item.pid),
        insertText: String(item.pid),
        detail: `${item.command} · CPU ${item.cpu_percent.toFixed(1)}%`,
        icon: "process",
        type: "process",
        replaceRange: { start, end: ctx.cursor },
        priority: 100 - index,
        source: "process",
        highlight: partial ? { start: 0, length: partial.length } : undefined,
      }));
      return { items, requestKey };
    },
  };
}
