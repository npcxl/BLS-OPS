import type { DirectorySizeResult } from "@/api/ops-api";
import { formatCount, formatSize } from "@/lib/format";
import { fileKind } from "@/lib/file-kind";

/** Pure POSIX path ops — remote paths never follow the local OS's rules. */
export function parentOf(path: string): string {
  const cut = path.lastIndexOf("/");
  if (cut <= 0) return "/";
  return path.slice(0, cut);
}

/** Lexically joins + resolves `.` / `..` (used for `cd` following). */
export function joinPath(base: string, target: string): string {
  const raw = target.startsWith("/") ? target : `${base}/${target}`;
  const parts: string[] = [];
  for (const component of raw.split("/")) {
    if (component === "" || component === ".") continue;
    if (component === "..") parts.pop();
    else parts.push(component);
  }
  return parts.length === 0 ? "/" : `/${parts.join("/")}`;
}

export const DIR_SIZE_STATUS_LABEL: Record<string, string> = {
  pending: "排队中",
  computing: "计算中…",
  completed: "已完成",
  partial: "部分统计",
  permission_denied: "权限不足",
  cancelled: "已取消",
  timed_out: "计算超时",
  session_gone: "连接已断开",
  failed: "计算失败",
};

/**
 * Renders the second line for a directory row from its size result.
 *
 * Folders never report a content size over SFTP (only their own ~4096 B
 * metadata). Before the user asks for the size — or if the probe failed for a
 * benign reason (no `du`, session gone) — we keep the second line as a plain
 * "文件夹" so the row doesn't look broken. While computing we show progress;
 * once done we show "1.26 GB · 12,586 个文件" and warn when some entries were
 * skipped. Genuinely terminal errors (permission denied, timed out, cancelled,
 * failed) are surfaced so the user knows why no size is shown.
 */
export function dirSizeSummary(result: DirectorySizeResult | undefined): string {
  if (!result) return "文件夹";
  switch (result.status) {
    case "computing":
    case "pending":
      return "计算中…";
    case "completed":
      return `${formatSize(result.sizeBytes)} · ${formatCount(result.fileCount)} 个文件`;
    case "partial":
      return `${formatSize(result.sizeBytes)} · ${formatCount(result.fileCount)} 个文件 · 部分统计`;
    case "permission_denied":
    case "timed_out":
    case "cancelled":
    case "failed":
    case "session_gone":
      return `文件夹 · ${DIR_SIZE_STATUS_LABEL[result.status] ?? result.status}`;
    default:
      return "文件夹";
  }
}

/** Rejects empty names and anything containing a path separator. */
export function validateName(name: string): string | null {
  const trimmed = name.trim();
  if (!trimmed) return "名称不能为空";
  if (trimmed.includes("/")) return "名称不能包含 /";
  if (trimmed === "." || trimmed === "..") return "名称不能是 . 或 ..";
  return null;
}

export type PanelStatus =
  | { state: "idle" }
  | { state: "loading" }
  | { state: "ready" }
  | { state: "empty" }
  | { state: "error"; message: string }
  | { state: "disconnected" };

export interface FilePanelFollow {
  nonce: number;
  /** Raw argument of the `cd` command: "", "~", "-", "..", "/x", "dir". */
  arg: string;
}

/** Name prompt for the create/rename dialogs (replaces window.prompt). */
export type NameDialog = {
  title: string;
  label: string;
  initial: string;
  submitLabel: string;
  /** Validates the typed name; returns an error message or null. */
  validate: (name: string) => string | null;
  onConfirm: (name: string) => Promise<unknown>;
};

/** The in-app editor target, when open. */
export type EditorTarget = {
  path: string;
  name: string;
  language?: ReturnType<typeof fileKind>["language"];
};
