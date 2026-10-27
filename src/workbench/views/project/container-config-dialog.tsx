/**
 * 容器配置弹窗（只读）。
 *
 * 数据全部来自后端 `docker inspect` 的**安全子集**：没有环境变量、没有启动
 * 命令 —— 那里常见数据库密码与 token。弹窗底部明说这一点，免得用户以为
 * "怎么看不到 ENV"，然后去别处找。
 *
 * 宿主路径（挂载来源 / compose 文件）是可直接跳的入口：右键给
 * 「在文件面板中打开 / 在终端中跟踪 / 复制路径」，左键直接打开文件面板。
 * 容器内路径（工作目录、挂载目标）不提供跳转 —— 面板读的是宿主机。
 */
import { Copy, FolderOpen, TerminalSquare } from "lucide-react";
import { useTranslation } from "react-i18next";
import { ContextMenu, useContextMenu, type ContextMenuItem } from "@/components/ui/context-menu";
import { Modal } from "@/components/ui/modal";
import { cn } from "@/lib/cn";
import type { ContainerConfig } from "@/api/ops-api";

/** `2024-01-15T09:12:33.123456789Z` → `2024-01-15 09:12:33`（只去噪，不复原时区）。 */
function shortTime(value: string): string {
  if (!value) return "—";
  const cleaned = value.replace("T", " ");
  return cleaned.length > 19 ? cleaned.slice(0, 19) : cleaned;
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-start justify-between gap-3 border-b border-line/60 py-1 last:border-b-0">
      <span className="shrink-0 text-11 text-fg-subtle">{label}</span>
      <span className="min-w-0 break-all text-right font-mono text-11 text-fg">{value || "—"}</span>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mb-3 last:mb-0">
      <h3 className="mb-1 text-10 font-semibold tracking-[0.08em] text-fg-subtle uppercase">{title}</h3>
      <div className="rounded-[8px] border border-line bg-surface-2/60 px-3 py-1.5">{children}</div>
    </section>
  );
}

/** 宿主机路径：左键打开文件面板，右键给出完整动作。 */
function PathLine({
  path,
  onOpen,
  onContextMenu,
}: {
  path: string;
  onOpen?: () => void;
  onContextMenu: (event: React.MouseEvent) => void;
}) {
  return (
    <button
      type="button"
      title={path}
      onContextMenu={onContextMenu}
      onClick={onOpen}
      className={cn(
        "block max-w-full truncate rounded-[4px] px-1 text-left font-mono text-11 text-fg-muted transition-colors",
        // 不能跳的路径保持普通文本观感，但右键仍可用（复制 / 终端跟踪）。
        onOpen && "hover:bg-surface-hover hover:text-fg",
      )}
    >
      {path}
    </button>
  );
}

export function ContainerConfigDialog({
  open,
  config,
  onClose,
  onOpenPath,
  onTrackPath,
  onCopyPath,
}: {
  open: boolean;
  config: ContainerConfig | null;
  onClose: () => void;
  /** 在右侧文件面板打开宿主路径。 */
  onOpenPath?: (path: string) => void;
  /** 打开终端并 cd 到该目录。 */
  onTrackPath?: (path: string) => void;
  onCopyPath?: (path: string) => void;
}) {
  const { t } = useTranslation();
  const menu = useContextMenu();

  if (!config) return null;

  // 菜单项闭包持有这次右键的路径，不需要额外的"当前路径"状态。
  const openMenu = (path: string) => (event: React.MouseEvent) => {
    menu.onContextMenu(() => {
      const items: ContextMenuItem[] = [];
      if (onOpenPath) {
        items.push({
          id: "open",
          label: t("Open in file panel"),
          icon: FolderOpen,
          onSelect: () => {
            onOpenPath(path);
            onClose();
          },
        });
      }
      if (onTrackPath) {
        items.push({
          id: "track",
          label: t("Track in terminal"),
          icon: TerminalSquare,
          onSelect: () => {
            onTrackPath(path);
            onClose();
          },
        });
      }
      if (onCopyPath) {
        items.push({
          id: "copy",
          label: t("Copy path"),
          icon: Copy,
          onSelect: () => onCopyPath(path),
        });
      }
      return items;
    })(event);
  };

  const openPath = (path: string) => {
    if (!onOpenPath) return;
    onOpenPath(path);
    onClose();
  };

  return (
    <Modal
      open={open}
      width={560}
      title={t("Container config: {{name}}", { name: config.name })}
      description={config.image}
      onClose={onClose}
    >
      <Section title={t("State")}>
        <Row label={t("State")} value={config.state} />
        <Row label={t("Health")} value={config.health ?? "—"} />
        <Row label={t("Restart policy")} value={config.restart_policy} />
        <Row label={t("Created")} value={shortTime(config.created)} />
        <Row label={t("Started")} value={shortTime(config.started_at)} />
        <Row label={t("Finished")} value={shortTime(config.finished_at)} />
        <Row label={t("Exit code")} value={String(config.exit_code)} />
        {config.oom_killed && <Row label={t("OOM killed")} value={t("Yes")} />}
        <Row label={t("Working dir")} value={config.working_dir} />
      </Section>

      {config.compose_project && (
        <Section title={t("Docker Compose")}>
          <Row label={t("Project")} value={config.compose_project} />
          <Row label={t("Service")} value={config.compose_service ?? "—"} />
          <div className="border-b border-line/60 py-1 last:border-b-0">
            <div className="text-11 text-fg-subtle">{t("Compose files")}</div>
            {config.compose_files.length === 0 ? (
              <div className="font-mono text-11 text-fg">—</div>
            ) : (
              config.compose_files.map((file) => (
                <PathLine
                  key={file}
                  path={file}
                  onOpen={onOpenPath ? () => openPath(file) : undefined}
                  onContextMenu={openMenu(file)}
                />
              ))
            )}
          </div>
        </Section>
      )}

      <Section title={t("Ports")}>
        {config.ports.length === 0 ? (
          <p className="py-1 text-11 text-fg-subtle">{t("No published ports")}</p>
        ) : (
          config.ports.map((port, index) => (
            <Row
              key={`${port.container_port}-${port.host_port}-${index}`}
              label={port.container_port}
              value={port.host_port ? `${port.host_ip || "0.0.0.0"}:${port.host_port}` : t("Not published")}
            />
          ))
        )}
      </Section>

      <Section title={t("Mounts")}>
        {config.mounts.length === 0 ? (
          <p className="py-1 text-11 text-fg-subtle">{t("No mounts")}</p>
        ) : (
          config.mounts.map((mount, index) => (
            <div key={`${mount.destination}-${index}`} className="border-b border-line/60 py-1 last:border-b-0">
              <div className="break-all font-mono text-11 text-fg">{mount.destination}</div>
              {mount.source ? (
                <PathLine
                  path={mount.source}
                  onOpen={onOpenPath ? () => openPath(mount.source) : undefined}
                  onContextMenu={openMenu(mount.source)}
                />
              ) : null}
              <div className="px-1 text-10 text-fg-subtle">
                {mount.kind}
                {mount.read_only ? ` · ${t("read-only")}` : ""}
              </div>
            </div>
          ))
        )}
      </Section>

      <p className="mt-2 text-10 leading-relaxed text-fg-subtle">
        {onOpenPath ? `${t("Click a host path to open it in the file panel; right-click for more actions.")} ` : ""}
        {t(
          "Environment variables and the start command are intentionally hidden — they often carry passwords and tokens.",
        )}
      </p>

      <ContextMenu {...menu.props} />
    </Modal>
  );
}
