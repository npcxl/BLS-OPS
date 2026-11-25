/**
 * 超能里的文件 / 服务图标 —— 统一走项目自带的 **vscode-icons**（离线内联）。
 *
 * `fileKind()` 只负责认出稳定的 `FileIconKey`（扩展名 / 特殊文件名 / 目录名），
 * 图形来自 `FILE_ICONS`（`@iconify/react` 直接渲染内联数据，不发网络请求）。
 * 图标层不参与业务判断：以后换图标集只动这一个文件和生成脚本。
 *
 * 为什么用它：比 Lucide 的通用文件图标"更全"—— `.conf`、`.log`、Dockerfile、
 * nginx、systemd、压缩包、Office、媒体文件各有自己的图形，附件树 / 文件变更 /
 * 日志来源一眼能分清是什么。
 */
import { Icon } from "@iconify/react";
import { cn } from "@/lib/cn";
import { fileKind, type FileIconKey } from "@/lib/file-kind";
import { FILE_ICONS } from "@/lib/icons/vscode-file-icons";
import type { LogSource } from "@/api/types/panel";

/** 直接按 key 画一个 vscode-icon（品牌图标：docker / nginx / systemd …）。 */
export function VscodeIcon({
  iconKey,
  size = 12,
  className,
  title,
}: {
  iconKey: FileIconKey;
  size?: number;
  className?: string;
  title?: string;
}) {
  return (
    <span
      className={cn("inline-flex shrink-0 items-center justify-center", className)}
      title={title}
      aria-hidden="true"
    >
      <Icon icon={FILE_ICONS[iconKey]} width={size} height={size} />
    </span>
  );
}

/** 按文件名 / 目录名认图标（附件树、文件变更树、产物按钮都走它）。 */
export function FileKindIcon({
  name,
  kind = "file",
  size = 12,
  className,
  title,
}: {
  name: string;
  /** 后端条目的 kind：`directory` 才会走目录图标。 */
  kind?: string;
  size?: number;
  className?: string;
  title?: string;
}) {
  const info = fileKind({ name, kind });
  return <VscodeIcon iconKey={info.iconKey} size={size} className={className} title={title} />;
}

/**
 * systemd 单元 / 容器名 → 品牌图标。
 *
 * 只认最常见的几种（nginx / docker / ssh / 数据库），其余用 systemd 的齿轮兜底：
 * 猜错品牌比给一个中性图标更糟。
 */
export function serviceIconKey(unit: string): FileIconKey {
  const name = unit.toLowerCase();
  if (name.includes("nginx")) return "nginx";
  if (name.includes("docker") || name.includes("containerd") || name.includes("podman")) {
    return "docker";
  }
  if (name.startsWith("ssh")) return "ssh";
  if (/(mysql|maria|postgres|mongo|redis|sql|db)/.test(name)) return "database";
  return "systemd";
}

/** 实时日志的来源 → 图标：容器 / Pod 是 Docker，单元看服务名，文件看扩展名。 */
export function logSourceIconKey(source: LogSource): FileIconKey {
  switch (source.kind) {
    case "docker":
      return "docker";
    case "k8s":
      return "docker";
    case "journal":
      return serviceIconKey(source.unit);
    default:
      return fileKind({ name: source.path, kind: "file" }).iconKey;
  }
}
