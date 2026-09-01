/**
 * Docker 管家 — containers, images and live stats (P3-1.3, P3-3.3).
 *
 * The whole page comes from one `docker_snapshot` call: containers, images and
 * stats are read concurrently on the server. When Docker is missing or the
 * daemon is down the page says so — it never shows an empty list that looks
 * like "you have no containers".
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import {
  Boxes,
  Container as ContainerIcon,
  Play,
  RotateCw,
  Square,
  Trash2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { ContextMenu, useContextMenu } from "@/components/ui/context-menu";
import { cn } from "@/lib/cn";
import {
  opsApi,
  toErrorMessage,
  type ContainerActionName,
  type ContainerInfo,
  type DockerSnapshot,
  type ImageInfo,
} from "@/api/ops-api";
import { useCommandSession } from "@/hooks/use-command-session";
import {
  ModuleEmpty,
  ModuleFrame,
  RefreshButton,
  ToolbarStat,
  ToolbarStatus,
} from "@/workbench/views/module-frame";
import type { WorkspaceTab } from "@/workbench/types";

type DetailTab = "containers" | "images" | "stats";

const TABS: { id: DetailTab; label: string }[] = [
  { id: "containers", label: "容器" },
  { id: "images", label: "镜像" },
  { id: "stats", label: "资源占用" },
];

/** An untagged image has no name, so its id is the only handle on it. */
function isDangling(image: ImageInfo): boolean {
  return image.repository === "<none>" || image.repository === "";
}

function stateTone(state: string): string {
  if (state === "running") return "bg-success";
  if (state === "exited" || state === "dead") return "bg-fg-subtle";
  if (state === "restarting" || state === "paused") return "bg-warning";
  return "bg-danger";
}

export function DockerManagerView({ tab }: { tab: WorkspaceTab }) {
  const session = useCommandSession(tab);

  const [snapshot, setSnapshot] = useState<DockerSnapshot | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [panel, setPanel] = useState<DetailTab>("containers");
  const [busy, setBusy] = useState<string | null>(null);
  const [pending, setPending] = useState<
    | { kind: "container"; action: ContainerActionName; container: ContainerInfo }
    | { kind: "image"; image: ImageInfo }
    | { kind: "prune" }
    | null
  >(null);
  const [logs, setLogs] = useState<{ title: string; text: string } | null>(null);

  const load = useCallback(async () => {
    if (!session.ready) return;
    setLoading(true);
    setError(null);
    try {
      setSnapshot(await opsApi.dockerSnapshot(session.sessionId));
    } catch (cause) {
      setError(toErrorMessage(cause));
    } finally {
      setLoading(false);
    }
  }, [session.ready, session.sessionId]);

  useEffect(() => {
    void load();
  }, [load]);

  // Every container/image action changes the daemon state, so reload after it.
  useEffect(() => {
    const unlisten = listen<string>(`docker-changed-${session.sessionId}`, () => {
      void load();
    });
    return () => void unlisten.then((fn) => fn());
  }, [load, session.sessionId]);

  const runAction = useCallback(
    async (action: ContainerActionName, container: string) => {
      setBusy(container);
      setError(null);
      try {
        await opsApi.dockerContainerAction(session.sessionId, action, container);
        await load();
      } catch (cause) {
        setError(toErrorMessage(cause));
      } finally {
        setBusy(null);
      }
    },
    [load, session.sessionId],
  );

  const runImageRemove = useCallback(
    async (image: string) => {
      setBusy(image);
      setError(null);
      try {
        await opsApi.dockerImageRemove(session.sessionId, image);
        await load();
      } catch (cause) {
        setError(toErrorMessage(cause));
      } finally {
        setBusy(null);
      }
    },
    [load, session.sessionId],
  );

  const runPrune = useCallback(async () => {
    setBusy("prune");
    setError(null);
    try {
      await opsApi.dockerPrune(session.sessionId);
      await load();
    } catch (cause) {
      setError(toErrorMessage(cause));
    } finally {
      setBusy(null);
    }
  }, [load, session.sessionId]);

  const showLogs = useCallback(
    async (container: ContainerInfo) => {
      setBusy(container.name);
      try {
        const text = await opsApi.dockerLogs(session.sessionId, container.name, 500);
        setLogs({ title: container.name, text });
      } catch (cause) {
        setError(toErrorMessage(cause));
      } finally {
        setBusy(null);
      }
    },
    [session.sessionId],
  );

  const menu = useContextMenu();
  const containerMenu = (container: ContainerInfo) =>
    menu.onContextMenu(() => {
      const running = container.state === "running";
      return [
        { id: "logs", label: "查看日志", onSelect: () => void showLogs(container) },
        { id: "sep1", separator: true },
        {
          id: "start",
          label: "启动",
          icon: Play,
          disabled: running || busy !== null,
          onSelect: () => void runAction("start", container.name),
        },
        {
          id: "stop",
          label: "停止",
          icon: Square,
          disabled: !running || busy !== null,
          danger: true,
          onSelect: () => setPending({ kind: "container", action: "stop", container }),
        },
        {
          id: "restart",
          label: "重启",
          icon: RotateCw,
          disabled: busy !== null,
          danger: true,
          onSelect: () => setPending({ kind: "container", action: "restart", container }),
        },
        { id: "sep2", separator: true },
        {
          id: "remove",
          label: "删除容器",
          icon: Trash2,
          danger: true,
          disabled: busy !== null,
          onSelect: () => setPending({ kind: "container", action: "remove", container }),
        },
      ];
    });

  const imageMenu = (image: ImageInfo) =>
    menu.onContextMenu(() => [
      {
        id: "remove",
        label: "删除镜像",
        icon: Trash2,
        danger: true,
        disabled: busy !== null,
        onSelect: () => setPending({ kind: "image", image }),
      },
    ]);

  const containers = snapshot?.containers ?? [];
  const images = snapshot?.images ?? [];
  const stats = snapshot?.stats ?? [];
  const runningCount = useMemo(
    () => containers.filter((container) => container.state === "running").length,
    [containers],
  );

  return (
    <ModuleFrame
      tab={tab}
      session={session}
      icon={ContainerIcon}
      toolbar={
        <>
          <RefreshButton busy={loading} onClick={() => void load()} />
          <div className="mx-1 h-4 w-px bg-line" />
          {TABS.map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => setPanel(item.id)}
              className={cn(
                "h-[24px] rounded-[6px] px-2 text-11 transition-colors",
                panel === item.id
                  ? "bg-surface-active text-fg"
                  : "text-fg-muted hover:bg-surface-hover hover:text-fg",
              )}
            >
              {item.label}
              <span className="ml-1 text-fg-subtle">
                {item.id === "containers"
                  ? containers.length
                  : item.id === "images"
                    ? images.length
                    : stats.length}
              </span>
            </button>
          ))}
          <div className="mx-1 h-4 w-px bg-line" />
          <Button variant="ghost" size="xs" disabled={busy !== null} onClick={() => setPending({ kind: "prune" })}>
            <Trash2 size={12} />
            清理无用资源
          </Button>
          <ToolbarStatus>
            <ToolbarStat>
              {snapshot?.available ? `${runningCount} / ${containers.length} 个容器运行中` : ""}
            </ToolbarStat>
          </ToolbarStatus>
        </>
      }
    >
      {error && (
        <div className="mx-3 mt-3 rounded-[8px] border border-danger/30 bg-danger/10 px-3 py-2 text-12 text-danger">
          {error}
        </div>
      )}

      {/* Docker missing is a fact, not an empty list. */}
      {snapshot && !snapshot.available ? (
        <ModuleEmpty
          icon={Boxes}
          title="Docker 不可用"
          hint={snapshot.unavailable_reason ?? "这台服务器上没有可用的 Docker。"}
        />
      ) : !snapshot && !loading ? (
        <ModuleEmpty icon={Boxes} title="还没有读取到 Docker 数据" />
      ) : panel === "containers" ? (
        <ContainerTable
          containers={containers}
          busy={busy}
          onRowContextMenu={containerMenu}
          onOpenLogs={(container) => void showLogs(container)}
        />
      ) : panel === "images" ? (
        <ImageTable images={images} busy={busy} onRowContextMenu={imageMenu} />
      ) : (
        <StatsTable stats={stats} />
      )}

      <ContextMenu {...menu.props} />

      <ConfirmDialog
        open={pending !== null}
        title={
          pending?.kind === "container"
            ? pending.action === "remove"
              ? `删除容器 ${pending.container.name}`
              : pending.action === "restart"
                ? `重启容器 ${pending.container.name}`
                : `停止容器 ${pending.container.name}`
            : pending?.kind === "image"
              ? `删除镜像 ${pending.image.display_name}`
              : "清理无用资源"
        }
        description={
          pending?.kind === "container"
            ? pending.action === "remove"
              ? `确定强制删除容器“${pending.container.name}”？未持久化的数据会丢失。`
              : pending.action === "restart"
                ? `确定重启容器“${pending.container.name}”？服务会短暂中断。`
                : `确定停止容器“${pending.container.name}”？`
            : pending?.kind === "image"
              ? `确定删除镜像“${pending.image.display_name}”？依赖它的容器将无法再启动。`
              : "将删除所有已停止的容器与悬空镜像。此操作不可撤销。"
        }
        confirmLabel={
          pending?.kind === "container" && pending.action === "restart" ? "重启" : "删除"
        }
        danger
        onConfirm={() => {
          if (!pending) return;
          if (pending.kind === "container") void runAction(pending.action, pending.container.name);
          else if (pending.kind === "image") void runImageRemove(pending.image.id);
          else void runPrune();
          setPending(null);
        }}
        onCancel={() => setPending(null)}
      />

      {logs && <LogSheet {...logs} onClose={() => setLogs(null)} />}
    </ModuleFrame>
  );
}

function ContainerTable({
  containers,
  busy,
  onRowContextMenu,
  onOpenLogs,
}: {
  containers: ContainerInfo[];
  busy: string | null;
  onRowContextMenu: (container: ContainerInfo) => (event: React.MouseEvent) => void;
  onOpenLogs: (container: ContainerInfo) => void;
}) {
  if (containers.length === 0) {
    return <ModuleEmpty icon={ContainerIcon} title="没有容器" hint="这台机器上还没有创建任何容器。" />;
  }
  return (
    <table className="w-full text-11">
      <thead className="sticky top-0 z-10 bg-surface-2 text-fg-subtle">
        <tr>
          <th className="w-[34px] px-3 py-1.5" />
          <th className="px-2 py-1.5 text-left font-semibold">名称</th>
          <th className="w-[104px] px-2 py-1.5 text-left font-semibold">ID</th>
          <th className="px-2 py-1.5 text-left font-semibold">镜像</th>
          <th className="w-[168px] px-2 py-1.5 text-left font-semibold">状态</th>
          <th className="px-3 py-1.5 text-left font-semibold">端口</th>
        </tr>
      </thead>
      <tbody>
        {containers.map((container) => (
          <tr
            key={container.id}
            className="cursor-default border-t border-line hover:bg-surface-hover"
            onContextMenu={onRowContextMenu(container)}
            onDoubleClick={() => onOpenLogs(container)}
          >
            <td className="px-3 py-1.5">
              <span className={cn("block h-[6px] w-[6px] rounded-full", stateTone(container.state))} />
            </td>
            <td className="px-2 py-1.5 font-mono text-fg">
              {container.name}
              {busy === container.name && (
                <RotateCw size={10} className="ml-1.5 inline animate-spin text-accent" />
              )}
            </td>
            <td className="px-2 py-1.5 font-mono text-fg-subtle">{container.short_id}</td>
            <td className="px-2 py-1.5 font-mono text-fg-muted">{container.image}</td>
            <td className="px-2 py-1.5 text-fg-muted" title={container.status}>
              {container.status}
            </td>
            <td className="max-w-0 truncate px-3 py-1.5 font-mono text-fg-subtle" title={container.ports}>
              {container.ports || "—"}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function ImageTable({
  images,
  busy,
  onRowContextMenu,
}: {
  images: ImageInfo[];
  busy: string | null;
  onRowContextMenu: (image: ImageInfo) => (event: React.MouseEvent) => void;
}) {
  if (images.length === 0) {
    return <ModuleEmpty icon={Boxes} title="没有镜像" hint="这台机器上还没有拉取任何镜像。" />;
  }
  return (
    <table className="w-full text-11">
      <thead className="sticky top-0 z-10 bg-surface-2 text-fg-subtle">
        <tr>
          <th className="px-3 py-1.5 text-left font-semibold">镜像</th>
          <th className="w-[104px] px-2 py-1.5 text-left font-semibold">ID</th>
          <th className="w-[92px] px-2 py-1.5 text-left font-semibold">大小</th>
          <th className="w-[128px] px-2 py-1.5 text-left font-semibold">创建于</th>
          <th className="w-[92px] px-3 py-1.5 text-left font-semibold">标签</th>
        </tr>
      </thead>
      <tbody>
        {images.map((image) => (
          <tr
            key={image.id}
            className="cursor-default border-t border-line hover:bg-surface-hover"
            onContextMenu={onRowContextMenu(image)}
          >
            <td className="px-3 py-1.5 font-mono text-fg">
              {image.display_name}
              {busy === image.id && (
                <RotateCw size={10} className="ml-1.5 inline animate-spin text-accent" />
              )}
            </td>
            <td className="px-2 py-1.5 font-mono text-fg-subtle">{image.short_id}</td>
            <td className="px-2 py-1.5 text-fg-muted">{image.size}</td>
            <td className="px-2 py-1.5 text-fg-muted">{image.created_since}</td>
            <td className="px-3 py-1.5">
              {isDangling(image) ? (
                <span className="text-warning">悬空</span>
              ) : (
                <span className="text-fg-subtle">—</span>
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function StatsTable({ stats }: { stats: { name: string; cpu_percent: number; memory_usage: string; memory_percent: number; net_io: string; block_io: string }[] }) {
  if (stats.length === 0) {
    return (
      <ModuleEmpty
        icon={Boxes}
        title="没有资源占用数据"
        hint="只有正在运行的容器才有实时统计；若全部容器已停止，这里就是空的。"
      />
    );
  }
  return (
    <table className="w-full text-11">
      <thead className="sticky top-0 z-10 bg-surface-2 text-fg-subtle">
        <tr>
          <th className="px-3 py-1.5 text-left font-semibold">容器</th>
          <th className="w-[92px] px-2 py-1.5 text-left font-semibold">CPU</th>
          <th className="w-[188px] px-2 py-1.5 text-left font-semibold">内存</th>
          <th className="w-[76px] px-2 py-1.5 text-left font-semibold">内存占比</th>
          <th className="px-2 py-1.5 text-left font-semibold">网络 I/O</th>
          <th className="px-3 py-1.5 text-left font-semibold">磁盘 I/O</th>
        </tr>
      </thead>
      <tbody>
        {stats.map((stat) => (
          <tr key={stat.name} className="border-t border-line hover:bg-surface-hover">
            <td className="px-3 py-1.5 font-mono text-fg">{stat.name}</td>
            <td className="px-2 py-1.5 font-mono text-fg-muted">{stat.cpu_percent.toFixed(2)}%</td>
            <td className="px-2 py-1.5 font-mono text-fg-muted">{stat.memory_usage}</td>
            <td className="px-2 py-1.5 font-mono text-fg-muted">
              {stat.memory_percent.toFixed(2)}%
            </td>
            <td className="px-2 py-1.5 font-mono text-fg-subtle">{stat.net_io}</td>
            <td className="px-3 py-1.5 font-mono text-fg-subtle">{stat.block_io}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function LogSheet({
  title,
  text,
  onClose,
}: {
  title: string;
  text: string;
  onClose: () => void;
}) {
  return (
    <div className="absolute inset-0 z-40 flex flex-col bg-app/80 backdrop-blur-sm">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-line bg-surface-1 px-3">
        <span className="text-12 font-semibold text-fg">{title}</span>
        <span className="text-11 text-fg-subtle">docker logs（最后 500 行）</span>
        <Button variant="ghost" size="xs" className="ml-auto" onClick={onClose}>
          关闭
        </Button>
      </div>
      <pre className="flex-1 overflow-auto whitespace-pre-wrap p-3 font-mono text-11 leading-relaxed text-fg-muted">
        {text || "（容器没有产生任何输出）"}
      </pre>
    </div>
  );
}
