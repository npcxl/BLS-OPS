/**
 * 附件的**读取层**：从 `File` 得到工作区条目。
 *
 * 这里只有纯逻辑 —— 不碰 React、不碰 Tauri，便于单测，也让
 * `ExtremeCoreView` 只保留"什么时候读、读到的结果放哪"。
 */
import type { TFunction } from "i18next";
import { formatSize } from "@/lib/format";
import type { ExtremeAttachment } from "@/stores/extreme-store";
import { INLINE_BINARY_MAX, keepAttachmentFile } from "./attachments/payload";

/** 文本文件读取上限：再大就不该整份塞进上下文。 */
export const MAX_READ_BYTES = 512 * 1024;
/**
 * 二进制附件**不设业务上限**。
 *
 * 之前 8 MB 的硬限制把常见的 `dist.zip`（刚过 8 MB，界面还显示 8.0 MB）
 * 直接判成「读取失败」，用户完全不知道为什么。现在能读多大就读多大，
 * 真正的边界只有 WebView / 进程内存；读失败会把系统错误原样显示出来。
 */
/** 单个文本附件发给模型的字符上限。 */
export const MAX_ATTACH_CHARS = 8_000;
/** 焦点附件（右键「添加到对话」选中）的额度，比普通附件大。 */
export const MAX_FOCUS_CHARS = 24_000;
/** 所有文本附件加起来的上限。 */
export const MAX_TOTAL_ATTACH_CHARS = 32_000;

/** `ArrayBuffer` → base64（分块拼接，避免超长参数导致调用栈溢出）。 */
export function toBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunk = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunk) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunk));
  }
  return btoa(binary);
}

/**
 * 按文件名判断是否文本。
 *
 * **必须包含前端产物**：部署静态站点时 `index.html`、`*.css`、`*.js` 是最
 * 重要的文件。漏掉它们的话，`dist/index.html` 会被当成二进制 —— 既读不到
 * 内容，模型也拿不到页面结构，无法判断站点该怎么托管。
 */
export function isTextFile(name: string): boolean {
  if (
    /\.(sh|bash|zsh|yml|yaml|json|conf|cfg|ini|env|log|txt|md|toml|properties|html?|css|scss|sass|less|js|mjs|cjs|ts|tsx|jsx|vue|svelte|xml|svg|sql|gradle|lock|service|rules|cnf|pem|pub|crt|key|list|repo|desktop|plist|ps1|bat|cmd|fish|awk|sed|py|rb|go|rs|java|kt|php|pl|lua)$/i.test(
      name,
    )
  ) {
    return true;
  }
  // 无后缀的常见配置 / 构建文件。
  return /^(dockerfile|makefile|procfile|caddyfile|jenkinsfile|vagrantfile|gemfile|rakefile)$/i.test(name);
}

/**
 * 读一个文件成工作区条目。
 *
 * 文本：读内容（供模型阅读；超大文本只留前 512 KB 作上下文，**整份文件仍可
 * 上传**）。二进制：内容不进 store，只把 `File` 句柄放进 payload 缓存；小文件
 * 额外留一份 base64 供预览，大文件不留 —— 8 MB 的 zip 不应该变成 11 MB 的
 * 字符串常驻副本。
 */
export async function readAttachment(
  file: File,
  options: { id: string; path?: string; t: TFunction },
): Promise<ExtremeAttachment> {
  const { id, path, t } = options;
  const base: ExtremeAttachment = {
    id,
    name: file.name,
    size: file.size,
    // 文件夹里的文件保留相对路径：部署时要按同样的层级放上去。
    ...(path && path !== file.name ? { path } : {}),
    state: "pending",
  };

  if (!isTextFile(file.name)) {
    // 句柄先记住：后面上传按块读它，store 里不再有整份 base64。
    keepAttachmentFile(id, file);
    try {
      const inline = file.size <= INLINE_BINARY_MAX;
      return {
        ...base,
        state: "ready",
        binary: true,
        ...(inline ? { data: toBase64(await file.arrayBuffer()) } : {}),
      };
    } catch (cause) {
      return {
        ...base,
        state: "failed",
        error: cause instanceof Error ? cause.message : t("读取失败"),
      };
    }
  }

  /*
   * 文本也保留本机句柄：上下文只取前 512 KB，但**上传必须是完整文件**。
   * 按 `text` 重编码还会改掉 BOM / CRLF / 非法 UTF-8，字节数对不上。
   */
  keepAttachmentFile(id, file);
  /*
   * 大文本不再整份判失败。
   *
   * 之前超过 512 KB 直接 `state: failed`，用户拖进来一个日志文件就"读取失败"，
   * 也无法上传。现在只截取上下文，文件本身仍通过 payload 缓存完整上传。
   */
  if (file.size > MAX_READ_BYTES) {
    try {
      const head = await file.slice(0, MAX_READ_BYTES).text();
      return {
        ...base,
        state: "ready",
        textPartial: true,
        text: `${head}\n…（超过 ${formatSize(MAX_READ_BYTES)}，只显示前一段；完整文件仍会上传）`,
      };
    } catch (cause) {
      return {
        ...base,
        state: "failed",
        error: cause instanceof Error ? cause.message : t("读取失败"),
      };
    }
  }
  try {
    return { ...base, state: "ready", text: await file.text() };
  } catch (cause) {
    return {
      ...base,
      state: "failed",
      error: cause instanceof Error ? cause.message : t("读取失败"),
    };
  }
}

/**
 * 递归展开拖入的**文件夹**。
 *
 * `dataTransfer.files` 只给文件，目录会被静默丢掉；`webkitGetAsEntry()` 能
 * 拿到目录句柄，逐层读出文件并保留相对路径（部署要按原层级上传）。
 * `readEntries` 一次最多返回 100 条，必须循环读到空为止。
 */
export async function collectDroppedEntries(
  transfer: DataTransfer,
): Promise<{ file: File; path: string }[]> {
  const out: { file: File; path: string }[] = [];

  const readEntry = async (entry: FileSystemEntry, prefix: string): Promise<void> => {
    if (entry.isFile) {
      const file = await new Promise<File | null>((resolve) => {
        (entry as FileSystemFileEntry).file(resolve, () => resolve(null));
      });
      if (file) out.push({ file, path: `${prefix}${file.name}` });
      return;
    }
    if (!entry.isDirectory) return;
    const reader = (entry as FileSystemDirectoryEntry).createReader();
    const dir = `${prefix}${entry.name}/`;
    for (;;) {
      const batch = await new Promise<FileSystemEntry[]>((resolve) => {
        reader.readEntries(resolve, () => resolve([]));
      });
      if (batch.length === 0) break;
      for (const child of batch) await readEntry(child, dir);
    }
  };

  const entries: FileSystemEntry[] = [];
  for (const item of Array.from(transfer.items)) {
    if (item.kind !== "file") continue;
    const entry = item.webkitGetAsEntry?.();
    if (entry) entries.push(entry);
  }

  if (entries.length === 0) {
    // 不支持 Entry API：退回普通文件列表，但仍尽量保留相对路径。
    return Array.from(transfer.files).map((file) => ({
      file,
      path: file.webkitRelativePath || file.name,
    }));
  }
  for (const entry of entries) await readEntry(entry, "");
  return out;
}

/* ------------------------------------------------------------------------- *
 * 服务器上的文件（右键「添加到对话」）
 * ------------------------------------------------------------------------- */

/**
 * 远程文件附件的 id：**会话 + 绝对路径**。
 *
 * 两台服务器上同一条路径不是同一个文件；同一个文件反复右键也只该有一份 ——
 * 复用与新建都靠这个 id 判定。
 */
export function remoteAttachmentId(sessionId: string, path: string): string {
  return `remote-${sessionId}-${path}`;
}

/**
 * 一行远程文件 → 附件。
 *
 * `uploadState: "uploaded"` 是**事实不是猜测**：文件本来就在服务器上，模型能
 * 按路径直接读、部署能就地 `cp`。正文还没读时标 `pending`，读完（或读失败、
 * 二进制）由调用方回写 —— 这里只给一个诚实的起点。
 */
export function remoteAttachment(
  entry: { name: string; path: string; size: number; kind?: string },
  sessionId: string,
): ExtremeAttachment {
  return {
    id: remoteAttachmentId(sessionId, entry.path),
    name: entry.name,
    path: entry.path,
    size: entry.size,
    // 目录没有"正文"这回事：直接可用。
    state: entry.kind === "directory" ? "ready" : "pending",
    remotePath: entry.path,
    uploadState: "uploaded",
  };
}

/**
 * 这个附件到底读到了什么（**只判定，不改数据**）。
 *
 * "读不到正文"不等于不能用：路径仍然有效，工具能自己读。界面与请求都应
 * 按这个结论说话，而不是把"没有 text"当成失败。
 */
export function attachmentReadState(
  item: ExtremeAttachment,
): "text" | "binary" | "failed" | "pending" {
  if (item.error) return "failed";
  if (item.binary) return "binary";
  if (typeof item.text === "string") return "text";
  return "pending";
}
