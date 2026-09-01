/**
 * 日志中心 — journald log queries (P3-3.2).
 *
 * Filtering by priority happens on the server (`journalctl -p`), so asking for
 * errors only never ships the whole journal over the wire. Rows are real
 * records with their real priority; nothing is synthesised.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowDownToLine, Filter, Loader2, RefreshCw, ScrollText } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/cn";
import {
  JOURNAL_PRIORITIES,
  opsApi,
  priorityLabel,
  toErrorMessage,
  type JournalDiskUsage,
  type JournalEntry,
} from "@/api/ops-api";
import { useCommandSession } from "@/hooks/use-command-session";
import { ModuleEmpty, ModuleFrame, RefreshButton } from "@/workbench/views/module-frame";
import type { WorkspaceTab } from "@/workbench/types";

const LINE_CHOICES = [100, 200, 500, 1000, 5000];

/** Tone per syslog priority. Errors and worse are called out; the rest recede. */
function priorityTone(priority: number): string {
  if (priority <= 3) return "text-danger";
  if (priority === 4) return "text-warning";
  if (priority === 5) return "text-accent";
  return "text-fg-subtle";
}

function rowTone(priority: number): string {
  return priority <= 3 ? "bg-danger/[0.06]" : "";
}

export function LogCenterView({ tab }: { tab: WorkspaceTab }) {
  const session = useCommandSession(tab);

  const [entries, setEntries] = useState<JournalEntry[]>([]);
  const [usage, setUsage] = useState<JournalDiskUsage | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [unit, setUnit] = useState("");
  const [lines, setLines] = useState(500);
  const [priority, setPriority] = useState<number | null>(null);
  const [search, setSearch] = useState("");
  /** `true` keeps the newest at the bottom and follows along after a refresh. */
  const [followTail, setFollowTail] = useState(true);

  const scrollRef = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    if (!session.ready) return;
    setLoading(true);
    setError(null);
    try {
      const [records, disk] = await Promise.all([
        opsApi.journalQuery({
          sessionId: session.sessionId,
          unit: unit.trim() || null,
          lines,
          priority,
        }),
        // Disk usage is a nice-to-have; failing the query for it would be wrong.
        opsApi.journalDiskUsage(session.sessionId).catch(() => null),
      ]);
      setEntries(records);
      setUsage(disk);
    } catch (cause) {
      setError(toErrorMessage(cause));
    } finally {
      setLoading(false);
    }
  }, [lines, priority, session.ready, session.sessionId, unit]);

  useEffect(() => {
    void load();
  }, [load]);

  // Keep the newest line in view when following.
  useEffect(() => {
    if (!followTail || entries.length === 0) return;
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [entries, followTail]);

  const visible = useMemo(() => {
    const needle = search.trim().toLowerCase();
    if (!needle) return entries;
    return entries.filter(
      (entry) =>
        entry.message.toLowerCase().includes(needle) ||
        entry.unit.toLowerCase().includes(needle),
    );
  }, [entries, search]);

  const errorCount = useMemo(
    () => entries.filter((entry) => entry.priority <= 3).length,
    [entries],
  );

  return (
    <ModuleFrame
      tab={tab}
      session={session}
      icon={ScrollText}
      toolbar={
        <>
          <RefreshButton busy={loading} onClick={() => void load()} />
          <div className="mx-1 h-4 w-px bg-line" />
          <input
            value={unit}
            onChange={(event) => setUnit(event.target.value)}
            onKeyDown={(event) => event.key === "Enter" && void load()}
            placeholder="单元名，如 nginx.service"
            className="h-[24px] w-52 rounded-[6px] border border-line bg-surface-2 px-2 font-mono text-11 text-fg outline-none placeholder:font-sans placeholder:text-fg-subtle focus:border-accent"
          />
          <label className="flex items-center gap-1 text-11 text-fg-subtle">
            <Filter size={11} />
            <select
              value={priority === null ? "" : String(priority)}
              onChange={(event) =>
                setPriority(event.target.value === "" ? null : Number(event.target.value))
              }
              className="h-[24px] rounded-[6px] border border-line bg-surface-2 px-1.5 text-11 text-fg outline-none focus:border-accent"
            >
              {JOURNAL_PRIORITIES.map((item) => (
                <option key={item.label} value={item.value === null ? "" : String(item.value)}>
                  {item.label}
                </option>
              ))}
            </select>
          </label>
          <select
            value={lines}
            onChange={(event) => setLines(Number(event.target.value))}
            className="h-[24px] rounded-[6px] border border-line bg-surface-2 px-1.5 text-11 text-fg outline-none focus:border-accent"
          >
            {LINE_CHOICES.map((choice) => (
              <option key={choice} value={choice}>
                {choice} 行
              </option>
            ))}
          </select>
          <div className="mx-1 h-4 w-px bg-line" />
          <input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="在结果中搜索…"
            className="h-[24px] w-44 rounded-[6px] border border-line bg-surface-2 px-2 text-11 text-fg outline-none placeholder:text-fg-subtle focus:border-accent"
          />
          <Button
            variant="ghost"
            size="xs"
            onClick={() => setFollowTail((value) => !value)}
            title={followTail ? "停止跟随最新" : "跟随最新"}
          >
            <ArrowDownToLine size={12} className={followTail ? "text-accent" : undefined} />
            {followTail ? "跟随中" : "已停止跟随"}
          </Button>
          <span className="ml-auto flex items-center gap-2 text-11 text-fg-subtle">
            {errorCount > 0 && <span className="text-danger">{errorCount} 条错误及以上</span>}
            {usage?.raw && <span className="truncate">占用 {usage.raw}</span>}
            <span>{visible.length} 条</span>
          </span>
        </>
      }
    >
      {error && (
        <div className="mx-3 mt-3 rounded-[8px] border border-danger/30 bg-danger/10 px-3 py-2 text-12 text-danger">
          {error}
        </div>
      )}

      {!loading && !error && entries.length === 0 ? (
        <ModuleEmpty
          icon={ScrollText}
          title="没有读取到日志"
          hint={
            unit.trim()
              ? `单元 ${unit.trim()} 没有匹配的记录，或当前用户无权读取 journal。`
              : "这台机器可能没有 journald，或者当前用户不在 systemd-journal 组中。"
          }
        />
      ) : (
        <div ref={scrollRef} className="h-full overflow-auto">
          <table className="w-full text-11">
            <thead className="sticky top-0 z-10 bg-surface-2 text-fg-subtle">
              <tr>
                <th className="w-[168px] px-3 py-1.5 text-left font-semibold">时间 (UTC)</th>
                <th className="w-[56px] px-2 py-1.5 text-left font-semibold">级别</th>
                <th className="w-[148px] px-2 py-1.5 text-left font-semibold">单元</th>
                <th className="px-3 py-1.5 text-left font-semibold">消息</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((entry, index) => (
                <tr
                  key={`${entry.timestamp}-${entry.unit}-${index}`}
                  className={cn("border-t border-line align-top", rowTone(entry.priority))}
                >
                  <td className="px-3 py-1.5 whitespace-nowrap font-mono text-fg-subtle">
                    {entry.timestamp || "—"}
                  </td>
                  <td className={cn("px-2 py-1.5 whitespace-nowrap", priorityTone(entry.priority))}>
                    {priorityLabel(entry.priority)}
                  </td>
                  <td className="px-2 py-1.5 font-mono text-fg-muted">{entry.unit}</td>
                  <td className="px-3 py-1.5 whitespace-pre-wrap font-mono text-fg">
                    {entry.message || "（无消息正文）"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {loading && (
            <div className="flex items-center justify-center gap-2 py-4 text-11 text-fg-subtle">
              <Loader2 size={12} className="animate-spin" />
              读取中…
            </div>
          )}
          {!loading && visible.length === 0 && search.trim() !== "" && (
            <div className="py-6 text-center text-12 text-fg-subtle">
              没有匹配“{search.trim()}”的记录
              <Button variant="ghost" size="xs" className="ml-2" onClick={() => void load()}>
                <RefreshCw size={11} />
                重新读取
              </Button>
            </div>
          )}
        </div>
      )}
    </ModuleFrame>
  );
}
