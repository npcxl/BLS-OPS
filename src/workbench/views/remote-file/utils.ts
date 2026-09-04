import type { DirectorySizeResult } from "@/api/ops-api";
import { formatCount, formatSize } from "@/lib/format";
import { fileKind } from "@/lib/file-kind";
import { i18n } from "@/i18n";

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

/** 目录大小状态 → 英文 key（渲染处统一 `i18n.t`，key 与语言包逐字一致）。 */
export const DIR_SIZE_STATUS_LABEL: Record<string, string> = {
  pending: "Queued",
  computing: "Computing…",
  completed: "Completed",
  partial: "Partial size",
  permission_denied: "Permission denied",
  cancelled: "Cancelled",
  timed_out: "Timed out",
  session_gone: "Session disconnected",
  failed: "Computation failed",
};

/**
 * Renders the second line for a directory row from its size result.
 *
 * Folders never report a content size over SFTP (only their own ~4096 B
 * metadata). Before the size is known — or if the probe failed for a benign
 * reason (no `du`, session gone) — we keep the second line as a plain
 * "文件夹" so the row doesn't look broken. While computing we show progress;
 * once done we show "1.26 GB · 12,586 个文件" and warn when some entries were
 * skipped. Genuinely terminal errors (permission denied, timed out, cancelled,
 * failed) are surfaced so the user knows why no size is shown.
 *
 * 文件计数只有 SFTP 递归回退才有（`du` 只报字节数）：结果里 `file_count` 为 0
 * 时只渲染大小，绝不显示误导性的"0 个文件"。
 */
export function dirSizeSummary(result: DirectorySizeResult | undefined): string {
  if (!result) return i18n.t("Folder");
  switch (result.status) {
    // 后端的并发闸（每会话 2 个）会把排队中的任务报成 `pending`，
    // 与真正在跑的 `computing` 区分开，用户才能看出"在排队"还是"在算"。
    case "pending":
      return i18n.t("Queued…");
    case "computing":
      return i18n.t("Computing…");
    case "completed":
    case "partial": {
      const parts = [formatSize(result.sizeBytes)];
      if (result.fileCount > 0) {
        parts.push(i18n.t("{{name}} files", { name: formatCount(result.fileCount) }));
      }
      if (result.status === "partial") parts.push(i18n.t("Partial size"));
      return parts.join(" · ");
    }
    case "permission_denied":
    case "timed_out":
    case "cancelled":
    case "failed":
    case "session_gone":
      return i18n.t("Folder · {{status}}", {
        status: i18n.t(DIR_SIZE_STATUS_LABEL[result.status] ?? result.status),
      });
    default:
      return i18n.t("Folder");
  }
}

/** Rejects empty names and anything containing a path separator. */
export function validateName(name: string): string | null {
  const trimmed = name.trim();
  if (!trimmed) return i18n.t("Name cannot be empty");
  if (trimmed.includes("/")) return i18n.t("Name cannot contain /");
  if (trimmed === "." || trimmed === "..") return i18n.t("Name cannot be . or ..");
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
