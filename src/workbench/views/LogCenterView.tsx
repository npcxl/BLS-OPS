/**
 * 日志中心 — journald log queries (P3-3.2).
 *
 * Filtering by priority happens on the server (`journalctl -p`), so asking for
 * errors only never ships the whole journal over the wire. Rows are real
 * records with their real priority; nothing is synthesised.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ArrowDownToLine, Copy, Filter, Loader2, RefreshCw, ScrollText } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/cn";
import { copyText } from "@/lib/clipboard";
import { ContextMenu, useContextMenu, type ContextMenuItem } from "@/components/ui/context-menu";
import {
  JOURNAL_PRIORITIES,
  opsApi,
  priorityLabel,
  toErrorMessage,
  type JournalDiskUsage,
  type JournalEntry,
} from "@/api/ops-api";
import { useCommandSession } from "@/hooks/use-command-session";
import {
  ModuleEmpty,
  ModuleFrame,
  RefreshButton,
  ToolbarInput,
  ToolbarStat,
  ToolbarStatus,
} from "@/workbench/views/module-frame";
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
  const { t } = useTranslation();
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

  // -- row context menu -----------------------------------------------------
  const menu = useContextMenu();

  /** One log row as plain text, matching what the table shows. */
  const rowText = (entry: JournalEntry) =>
    [entry.timestamp || "—", priorityLabel(entry.priority), entry.unit, entry.message]
      .filter(Boolean)
      .join("  ");

  const copyRow = (entry: JournalEntry) => void copyText(rowText(entry));

  const copyAll = () =>
    void copyText(visible.map(rowText).join("\n"));

  const rowMenu = (entry: JournalEntry) =>
    menu.onContextMenu((): ContextMenuItem[] => {
      const levelLabel = priorityLabel(entry.priority);
      return [
        { id: "copy-row", label: t("Copy this line"), icon: Copy, onSelect: () => copyRow(entry) },
        { id: "copy-all", label: t("Copy all ({{count}})", { count: visible.length }), onSelect: copyAll },
        { id: "sep-filter", separator: true },
        {
          id: "filter-priority",
          label: t("Show \"{{level}}\" and above", { level: levelLabel }),
          icon: Filter,
          // Re-applying the filter the row already has would be a no-op that
          // looks like a broken menu item.
          disabled: priority === entry.priority,
          hint: priority === entry.priority ? t("Current") : undefined,
          onSelect: () => setPriority(entry.priority),
        },
        {
          id: "filter-unit",
          label: t("Show unit {{unit}}", { unit: entry.unit }),
          disabled: unit.trim() === entry.unit,
          hint: unit.trim() === entry.unit ? t("Current") : undefined,
          onSelect: () => setUnit(entry.unit),
        },
        {
          id: "search-unit",
          label: t("Search this message in results"),
          disabled: entry.message.trim() === "",
          onSelect: () => setSearch(entry.message),
        },
        { id: "sep-clear", separator: true },
        {
          id: "clear-filters",
          label: t("Clear filters"),
          disabled: priority === null && unit.trim() === "" && search.trim() === "",
          onSelect: () => {
            setPriority(null);
            setUnit("");
            setSearch("");
          },
        },
      ];
    });

  return (
    <ModuleFrame
      tab={tab}
      session={session}
      toolbar={
        <>
          <RefreshButton busy={loading} onClick={() => void load()} />
          <div className="mx-1 h-4 w-px bg-line" />
          <Button
            variant="ghost"
            size="xs"
            className="min-w-0 shrink"
            onClick={() => setFollowTail((value) => !value)}
            title={followTail ? t("Stop following latest") : t("Follow latest")}
          >
            <ArrowDownToLine
              size={12}
              className={cn("shrink-0", followTail ? "text-accent" : undefined)}
            />
            <span className="truncate">{followTail ? t("Following") : t("Not following")}</span>
          </Button>
          <ToolbarStatus>
            {errorCount > 0 && (
              <ToolbarStat className="text-danger">{t("{{count}} errors and above", { count: errorCount })}</ToolbarStat>
            )}
            {usage?.raw && <ToolbarStat>{t("Disk usage {{usage}}", { usage: usage.raw })}</ToolbarStat>}
            {/* The row count is what the user reads, so it never ellipsizes. */}
            <ToolbarStat className="shrink-0">{t("{{count}} rows", { count: visible.length })}</ToolbarStat>
          </ToolbarStatus>
        </>
      }
      toolbar2={
        <>
          <ToolbarInput
            value={unit}
            onChange={(event) => setUnit(event.target.value)}
            onKeyDown={(event) => event.key === "Enter" && void load()}
            placeholder={t("Unit name, e.g. nginx.service")}
            width="w-52"
            className="font-mono placeholder:font-sans"
          />
          <label className="flex shrink-0 items-center gap-1 text-11 text-fg-subtle">
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
          <label className="flex shrink-0 items-center gap-1 text-11 text-fg-subtle">
            {t("Lines")}
            <select
              value={lines}
              onChange={(event) => setLines(Number(event.target.value))}
              className="h-[24px] rounded-[6px] border border-line bg-surface-2 px-1.5 text-11 text-fg outline-none focus:border-accent"
            >
              {LINE_CHOICES.map((choice) => (
                <option key={choice} value={choice}>
                  {choice}
                </option>
              ))}
            </select>
          </label>
          <ToolbarInput
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder={t("Search in results…")}
            className="flex-1"
          />
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
          title={t("No logs read")}
          hint={
            unit.trim()
              ? t("Unit {{unit}} has no matching records, or the current user cannot read the journal.", {
                  unit: unit.trim(),
                })
              : t("This machine may not have journald, or the current user is not in the systemd-journal group.")
          }
        />
      ) : (
        <div ref={scrollRef} className="h-full overflow-auto">
          <table className="w-full text-11">
            <thead className="sticky top-0 z-10 bg-surface-2 text-fg-subtle">
              <tr>
                <th className="w-[168px] px-3 py-1.5 text-left font-semibold">{t("Time (UTC)")}</th>
                <th className="w-[56px] px-2 py-1.5 text-left font-semibold">{t("Level")}</th>
                <th className="w-[148px] px-2 py-1.5 text-left font-semibold">{t("Unit")}</th>
                <th className="px-3 py-1.5 text-left font-semibold">{t("Message")}</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((entry, index) => (
                <tr
                  key={`${entry.timestamp}-${entry.unit}-${index}`}
                  data-testid="log-row"
                  className={cn("border-t border-line align-top", rowTone(entry.priority))}
                  onContextMenu={rowMenu(entry)}
                >
                  <td className="px-3 py-1.5 whitespace-nowrap font-mono text-fg-subtle">
                    {entry.timestamp || "—"}
                  </td>
                  <td className={cn("px-2 py-1.5 whitespace-nowrap", priorityTone(entry.priority))}>
                    {priorityLabel(entry.priority)}
                  </td>
                  <td className="px-2 py-1.5 font-mono text-fg-muted">{entry.unit}</td>
                  <td className="px-3 py-1.5 whitespace-pre-wrap font-mono text-fg">
                    {entry.message || t("(no message body)")}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {loading && (
            <div className="flex items-center justify-center gap-2 py-4 text-11 text-fg-subtle">
              <Loader2 size={12} className="animate-spin" />
              {t("Reading…")}
            </div>
          )}
          {!loading && visible.length === 0 && search.trim() !== "" && (
            <div className="py-6 text-center text-12 text-fg-subtle">
              {t("No records matching \"{{query}}\"", { query: search.trim() })}
              <Button variant="ghost" size="xs" className="ml-2" onClick={() => void load()}>
                <RefreshCw size={11} />
                {t("Read again")}
              </Button>
            </div>
          )}
        </div>
      )}

      <ContextMenu {...menu.props} title={t("Logs")} />
    </ModuleFrame>
  );
}
