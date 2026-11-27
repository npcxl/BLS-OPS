/**
 * 本机附件内容缓存。
 *
 * # 为什么不能把内容放进 store
 *
 * 8.4 MB 的 `dist.zip` 转成 base64 是 11 MB 字符串：它会被渲染快照、写进
 * workspace 历史、再序列化进 SQLite。应用重启后这份"内容"还在，却已经无法
 * 证明它对应磁盘上的哪个文件 —— 上传时只能拿旧字节顶上，同名的新包就会被
 * 旧包替换。这里只缓存 **File 句柄**：
 *
 * * React store 里只留名称 / 大小 / 状态（可持久化、可跨重启）；
 * * 上传时按块读文件，内存里最多一个 chunk；
 * * 重启后句柄没了 = 明确提示"重新选择文件"，绝不拿旧内容冒充新文件。
 *
 * 小文件（≤ [`INLINE_BINARY_MAX`]）仍保留 base64 的 `data`：预览、导出和旧
 * 接口都还要用，几十 KB 占不住多少内存。
 */
import type { ExtremeAttachment } from "@/stores/extreme-store";
import { base64ToBytes } from "@/lib/preview/base64";

/** 超过这个大小的二进制不再在 store 里保留 base64。 */
export const INLINE_BINARY_MAX = 1024 * 1024;

const files = new Map<string, File>();

/** 记住一个本机文件（同 id 覆盖：附件 id 是身份）。 */
export function keepAttachmentFile(id: string, file: File): void {
  files.set(id, file);
}

export function attachmentFile(id: string): File | null {
  return files.get(id) ?? null;
}

/** 附件被移除 / 清理后丢弃句柄，避免大文件一直占着内存。 */
export function dropAttachmentFile(id: string): void {
  files.delete(id);
}

/** 这份附件现在还有没有可上传的字节（不读内容，只看来源）。 */
export function hasAttachmentPayload(item: ExtremeAttachment): boolean {
  return files.has(item.id) || typeof item.text === "string" || typeof item.data === "string";
}

/** 一块待上传的字节，带总长度（进度按它算）。 */
export interface AttachmentSource {
  /** 总字节数（文本按 UTF-8 编码后的长度，不是原文件名大小）。 */
  total: number;
  /** 读 `[offset, offset + length)`；越界会被截短。 */
  read: (offset: number, length: number) => Promise<Uint8Array>;
}

function bytesSource(bytes: Uint8Array): AttachmentSource {
  return {
    total: bytes.length,
    read: async (offset, length) => bytes.subarray(offset, Math.min(bytes.length, offset + length)),
  };
}

/**
 * 取一个附件的字节来源。
 *
 * 返回 `null` 表示**本机没有内容了**（应用重启 / 用户删了原文件）：调用方
 * 必须提示"重新选择文件"，不能拿远程路径或旧缓存顶替。
 */
export function attachmentSource(item: ExtremeAttachment): AttachmentSource | null {
  const file = files.get(item.id);
  if (file) {
    return {
      total: file.size,
      read: async (offset, length) => {
        const slice = file.slice(offset, Math.min(file.size, offset + length));
        return new Uint8Array(await slice.arrayBuffer());
      },
    };
  }
  if (typeof item.text === "string") {
    /*
     * 截断过的上下文不是完整文件：重启后没有句柄时**宁可报"请重新选择"**，
     * 也不能拿这半截去覆盖服务器上的完整副本。
     */
    if (item.textPartial) return null;
    return bytesSource(new TextEncoder().encode(item.text));
  }
  if (typeof item.data === "string") {
    try {
      return bytesSource(base64ToBytes(item.data));
    } catch {
      return null;
    }
  }
  return null;
}

/** `Uint8Array` → base64（分块，避免超长参数导致调用栈溢出）。 */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunk) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunk));
  }
  return btoa(binary);
}
