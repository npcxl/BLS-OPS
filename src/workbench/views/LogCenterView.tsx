/**
 * 日志中心 — journald log queries (P3-3.2).
 *
 * Filtering by priority happens on the server (`journalctl -p`), so asking for
 * errors only never ships the whole journal over the wire. Rows are real
 * records with their real priority; nothing is synthesised.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  ArrowDownToLine,
  Copy,
  Eraser,
  Filter,
  RefreshCw,
  ScrollText,
  Search,
  Server,
} from "@/components/icons";
import { Button } from "@/components/ui/button";
import { LoadingState } from "@/components/ui/loading";
import { SearchField } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { cn } from "@/lib/cn";
import { copyText } from "@/lib/clipboard";
import { ContextMenu, useContextMenu, type ContextMenuItem } from "@/components/ui/context-menu";
import {
  JOURNAL_PRIORITIES,
  opsApi,
  priorityLabel,
  type JournalDiskUsage,
  type JournalEntry,
} from "@/api/ops-api";
import { ErrorState } from "@/components/ui/error-state";
import { useActionError } from "@/hooks/use-action-error";
import { useCommandSession } from "@/hooks/use-command-session";
import {
  ModuleEmpty,
  ModuleFrame,
  RefreshButton,
  ToolbarInput,
  ToolbarStat,
  ToolbarStatus,
} from "@/workbench/views/module-frame";
import { PageToolbarDivider } from "@/workbench/page-layout";
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
  // 原始异常 + 可重试：journalctl 失败常常是权限（adm/systemd-journal 组）或机器不可达。
  const { error, fail, clear, retry } = useActionError();

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
    clear();
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
      fail(cause, () => void load());
    } finally {
      setLoading(false);
    }
  }, [lines, priority, session.ready, session.sessionId, unit, clear, fail]);

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
        {
          id: "copy-all",
          label: t("Copy all ({{count}})", { count: visible.length }),
          icon: Copy,
          onSelect: copyAll,
        },
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
          icon: Server,
          disabled: unit.trim() === entry.unit,
          hint: unit.trim() === entry.unit ? t("Current") : undefined,
          onSelect: () => setUnit(entry.unit),
        },
        {
          id: "search-unit",
          label: t("Search this message in results"),
          icon: Search,
          disabled: entry.message.trim() === "",
          onSelect: () => setSearch(entry.message),
        },
        { id: "sep-clear", separator: true },
        {
          id: "clear-filters",
          label: t("Clear filters"),
          icon: Eraser,
          disabled: priority === null && unit.trim() === "" && search.trim() === "",
          onSelect: () => {
            setPriority(null);
            setUnit("");
            setSearch("");
          },
        },
      ];
    });

  // First load owns the page; later refreshes keep the existing rows in place.
  const initialLoading = loading && entries.length === 0;
  const noMatches = entries.length > 0 && visible.length === 0;

  return (
    <ModuleFrame
      session={session}
      contentRef={scrollRef}
      toolbar={
        <>
          <RefreshButton busy={loading} onClick={() => void load()} />
          <PageToolbarDivider />
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
          <span className="flex shrink-0 items-center gap-1 text-11 text-fg-subtle">
            <Filter size={11} />
            {/* "" 表示"全部优先级"，不要用 0 顶替 —— syslog 的 0 是 emerg。 */}
            <Select
              size="xs"
              className="w-[112px]"
              ariaLabel={t("优先级")}
              value={priority === null ? "" : String(priority)}
              onChange={(value) => setPriority(value === "" ? null : Number(value))}
              options={JOURNAL_PRIORITIES.map((item) => ({
                value: item.value === null ? "" : String(item.value),
                label: item.label,
              }))}
            />
          </span>
          <span className="flex shrink-0 items-center gap-1 text-11 text-fg-subtle">
            {t("Lines")}
            <Select
              size="xs"
              className="w-[84px]"
              ariaLabel={t("行数")}
              value={String(lines)}
              onChange={(value) => setLines(Number(value))}
              options={LINE_CHOICES.map((choice) => ({
                value: String(choice),
                label: String(choice),
              }))}
            />
          </span>
          <SearchField
            containerClassName="flex-1"
            value={search}
            onChange={setSearch}
            placeholder={t("Search in results…")}
          />
        </>
      }
    >
      {error ? (
        <div className="page-content">
          <ErrorState error={error} compact onRetry={retry} />
        </div>
      ) : initialLoading ? (
        <div className="page-content">
          <LoadingState label={t("Reading…")} />
        </div>
      ) : !error && entries.length === 0 ? (
        <div className="page-content page-content--reading">
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
            action={
              unit.trim() ? (
                <Button variant="ghost" size="xs" onClick={() => setUnit("")}>
                  {t("Clear filters")}
                </Button>
              ) : undefined
            }
          />
        </div>
      ) : noMatches ? (
        <div className="page-content page-content--reading">
          <ModuleEmpty
            icon={ScrollText}
            title={t("No records matching \"{{query}}\"", { query: search.trim() })}
            hint={t("Search only covers the rows already read from the journal.")}
            action={
              <div className="page-actions">
                <Button variant="ghost" size="xs" onClick={() => setSearch("")}>
                  {t("Clear search")}
                </Button>
                <Button variant="ghost" size="xs" onClick={() => void load()}>
                  <RefreshCw size={11} />
                  {t("Read again")}
                </Button>
              </div>
            }
          />
        </div>
      ) : (
        <table className="page-table text-11" aria-busy={loading || undefined}>
          <thead>
            <tr>
              <th className="w-[168px]">{t("Time (UTC)")}</th>
              <th className="w-[56px]">{t("Level")}</th>
              <th className="w-[148px]">{t("Unit")}</th>
              <th>{t("Message")}</th>
            </tr>
          </thead>
          <tbody>
            {visible.map((entry, index) => (
              <tr
                key={`${entry.timestamp}-${entry.unit}-${index}`}
                data-testid="log-row"
                className={cn("border-t border-line/70 align-top", rowTone(entry.priority))}
                onContextMenu={rowMenu(entry)}
              >
                <td className="whitespace-nowrap font-mono text-fg-subtle">
                  {entry.timestamp || "—"}
                </td>
                <td className={cn("whitespace-nowrap", priorityTone(entry.priority))}>
                  {priorityLabel(entry.priority)}
                </td>
                <td className="font-mono text-fg-muted">{entry.unit}</td>
                <td className="whitespace-pre-wrap font-mono text-fg">
                  {entry.message || t("(no message body)")}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <ContextMenu {...menu.props} title={t("Logs")} />
    </ModuleFrame>
  );
}
