/**
 * 把本机文件夹读成工作区附件（欢迎页的可选入口）。
 *
 * 后端只接受**用户在系统选择器里选中的**目录，并且跳过 `.git` / `node_modules`
 * / `.env` / 私钥这类内容（见 `commands::extreme::extreme_pick_workspace_folders`）。
 * 前端这里只做"base64 → File → 附件"的形状转换，不做任何路径猜测。
 */
import { invoke } from "@tauri-apps/api/core";
import type { TFunction } from "i18next";
import { base64ToBytes } from "@/lib/preview/base64";
import type { ExtremeAttachment } from "@/stores/extreme-store";
import { readAttachment } from "./attachments";

export interface FolderImport {
  folder: string;
  files: { path: string; data: string }[];
  limited: boolean;
}

/** 打开系统文件夹选择器并读出内容（用户取消时返回空数组）。 */
export function pickWorkspaceFolders(): Promise<FolderImport[]> {
  return invoke<FolderImport[]>("extreme_pick_workspace_folders");
}

/**
 * 文件夹 → 附件列表。
 *
 * 每个文件夹用**自己的名字**做根，重名时加 `-2`、`-3`：两个 `dist/` 不能
 * 互相覆盖（部署时按相对路径落盘）。
 */
export async function foldersToAttachments(
  folders: FolderImport[],
  t: TFunction,
): Promise<ExtremeAttachment[]> {
  const usedRoots = new Set<string>();
  const attachments: ExtremeAttachment[] = [];
  for (const folder of folders) {
    const name = folder.files[0]?.path.split("/")[0] ?? "workspace";
    let root = name;
    for (let suffix = 2; usedRoots.has(root); suffix += 1) root = `${name}-${suffix}`;
    usedRoots.add(root);
    for (const entry of folder.files) {
      const path = root + entry.path.slice(name.length);
      const bytes = base64ToBytes(entry.data);
      const file = new File(
        [Uint8Array.from(bytes)],
        path.slice(path.lastIndexOf("/") + 1),
      );
      attachments.push(await readAttachment(file, { id: crypto.randomUUID(), path, t }));
    }
  }
  return attachments;
}
