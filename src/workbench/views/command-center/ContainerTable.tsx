import { useMemo, useState } from "react";
import { cn } from "@/lib/cn";
import type { DockerContainerRow } from "@/api/ops-api";

type StatusFilter = "all" | "running" | "exited";
type SortKey = "name" | "state" | "created_at";

/**
 * `docker ps -a` 结构化表格（P4.3.1/4.3.2）。
 *
 * 摘要（总计/运行/停止）+ 状态筛选 + 名称/时间排序；点击行打开底部详情
 * （完整 64 位 ID、镜像、状态、端口映射、创建时间）。容器 ID 缩写显示，
 * 完整值在详情里。当前数据源单次 ≤ 数百行，直接渲染安全；虚拟滚动在
 * 数据量实际超限时再引入（YAGNI）。
 */
export function ContainerTable({ containers }: { containers: DockerContainerRow[] }) {
  const [filter, setFilter] = useState<StatusFilter>("all");
  const [sortKey, setSortKey] = useState<SortKey>("created_at");
  const [ascending, setAscending] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const summary = useMemo(() => {
    const running = containers.filter((row) => row.state === "running").length;
    const exited = containers.filter((row) => row.state === "exited").length;
    return { total: containers.length, running, exited, other: containers.length - running - exited };
  }, [containers]);

  const rows = useMemo(() => {
    const filtered =
      filter === "all" ? containers : containers.filter((row) => (filter === "running" ? row.state === "running" : row.state === "exited"));
    const sorted = [...filtered].sort((a, b) => {
      const factor = ascending ? 1 : -1;
      if (sortKey === "created_at") return a.created_at.localeCompare(b.created_at) * factor;
      return a[sortKey].localeCompare(b[sortKey]) * factor;
    });
    return sorted;
  }, [containers, filter, sortKey, ascending]);

  const selected = useMemo(
    () => containers.find((row) => row.id === selectedId) ?? null,
    [containers, selectedId],
  );

  const setSort = (key: SortKey) => {
    if (key === sortKey) setAscending((current) => !current);
    else {
      setSortKey(key);
      setAscending(key === "name");
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* 摘要 + 筛选 */}
      <div className="flex shrink-0 flex-wrap items-center gap-1.5 border-b border-line px-3 py-1.5">
        <span className="text-11 text-fg-muted">
          总计 {summary.total}
          <span className="mx-1 text-fg-subtle">·</span>
          <span className="text-success">运行中 {summary.running}</span>
          <span className="mx-1 text-fg-subtle">·</span>
          已停止 {summary.exited}
          {summary.other > 0 && (
            <>
              <span className="mx-1 text-fg-subtle">·</span>其他 {summary.other}
            </>
          )}
        </span>
        <div className="ml-auto flex items-center gap-0.5">
          {(["all", "running", "exited"] as const).map((key) => (
            <button
              key={key}
              type="button"
              onClick={() => setFilter(key)}
              className={cn(
                "rounded-full px-2 py-0.5 text-10 transition-colors",
                filter === key ? "bg-accent/12 text-accent" : "text-fg-subtle hover:text-fg",
              )}
            >
              {key === "all" ? "全部" : key === "running" ? "运行中" : "已停止"}
            </button>
          ))}
        </div>
      </div>

      {/* 表格 */}
      <div className="min-h-0 flex-1 overflow-auto">
        <table className="w-full border-collapse text-left text-11">
          <thead className="sticky top-0 z-10 bg-surface-2/90 backdrop-blur">
            <tr className="text-fg-subtle">
              <th className="px-3 py-1.5 font-medium">状态</th>
              <th className="cursor-pointer px-3 py-1.5 font-medium hover:text-fg" onClick={() => setSort("name")}>
                容器名称 {sortKey === "name" && (ascending ? "↑" : "↓")}
              </th>
              <th className="px-3 py-1.5 font-medium">镜像</th>
              <th className="px-3 py-1.5 font-medium">端口</th>
              <th
                className="cursor-pointer px-3 py-1.5 font-medium hover:text-fg"
                onClick={() => setSort("created_at")}
              >
                创建时间 {sortKey === "created_at" && (ascending ? "↑" : "↓")}
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr
                key={row.id}
                onClick={() => setSelectedId((current) => (current === row.id ? null : row.id))}
                className={cn(
                  "cursor-pointer border-t border-line/60 transition-colors hover:bg-surface-hover/60",
                  selectedId === row.id && "bg-accent/8",
                )}
                title="点击查看完整信息"
              >
                <td className="whitespace-nowrap px-3 py-1.5">
                  <span className="inline-flex items-center gap-1.5">
                    <span
                      className={cn(
                        "size-1.5 rounded-full",
                        row.state === "running" ? "bg-success" : "bg-fg-subtle/50",
                      )}
                    />
                    <span className={row.state === "running" ? "text-success" : "text-fg-subtle"}>
                      {row.state === "running" ? "运行中" : stateLabel(row)}
                    </span>
                  </span>
                </td>
                <td className="px-3 py-1.5">
                  <span className="block max-w-[240px] truncate text-fg" title={row.name}>
                    {row.name}
                  </span>
                  <span className="font-mono text-9 text-fg-subtle">{row.short_id}</span>
                </td>
                <td className="max-w-[220px] truncate px-3 py-1.5 font-mono text-fg-muted" title={row.image}>
                  {row.image}
                </td>
                <td className="max-w-[180px] truncate px-3 py-1.5 font-mono text-fg-muted" title={row.ports || "无端口映射"}>
                  {row.ports || "—"}
                </td>
                <td className="whitespace-nowrap px-3 py-1.5 text-fg-subtle">{row.created_at}</td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={5} className="px-3 py-6 text-center text-fg-subtle">
                  该筛选下没有容器。
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* 行详情：完整 ID / 镜像 / 状态 / 端口 / 创建时间。 */}
      {selected && (
        <div className="shrink-0 border-t border-line bg-surface-2/60 px-4 py-2.5">
          <div className="flex flex-wrap items-center gap-1.5">
            <strong className="text-12 text-fg">{selected.name}</strong>
            <span className={cn("rounded px-1.5 py-0.5 text-10", selected.state === "running" ? "bg-success/12 text-success" : "bg-surface-3 text-fg-subtle")}>
              {selected.state === "running" ? "运行中" : stateLabel(selected)}
            </span>
            <button
              type="button"
              onClick={() => setSelectedId(null)}
              className="ml-auto rounded p-0.5 text-10 text-fg-subtle hover:text-fg"
            >
              关闭
            </button>
          </div>
          <dl className="mt-1.5 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-10">
            <dt className="text-fg-subtle">完整 ID</dt>
            <dd className="break-all font-mono text-fg-muted">{selected.id}</dd>
            <dt className="text-fg-subtle">镜像</dt>
            <dd className="break-all font-mono text-fg-muted">{selected.image}</dd>
            <dt className="text-fg-subtle">状态</dt>
            <dd className="text-fg-muted">{selected.status}</dd>
            <dt className="text-fg-subtle">端口映射</dt>
            <dd className="break-all font-mono text-fg-muted">{selected.ports || "无"}</dd>
            <dt className="text-fg-subtle">创建时间</dt>
            <dd className="text-fg-muted">{selected.created_at}</dd>
          </dl>
        </div>
      )}
    </div>
  );
}

function stateLabel(row: DockerContainerRow): string {
  if (row.state === "exited") return "已退出";
  if (row.state === "paused") return "已暂停";
  if (row.state === "created") return "已创建";
  if (row.state === "restarting") return "重启中";
  return row.state;
}
