/**
 * FileProvider —— 需要**文件参数**的命令（`cat`、`unzip`、`tar`、`rm` …）。
 *
 * 与 `RemoteDirectoryProvider` 的区别只有一个：这里**文件和目录都给**
 * （`cat nginx.conf` 与 `cat /etc/nginx/` 同样合法）。目录保留结尾 `/`，
 * 文件不加 —— 用户一眼能看出补全的是哪一种。
 *
 * 关键增强：**按命令语义过滤文件类型**。
 * `unzip` 只该看到 `.zip`，`tar -xf` 只该看到 `.tar*`，`gunzip` 只该看到
 * `.gz` —— 否则候选里混着一堆 `.log`、`.conf`，等于没补全。目录永远保留
 * （可以继续往里走）。
 */

import type { RemoteFileEntry } from "@/api/ops-api";
import { analyzePathInput, displayRelativePath, quotePathSegment } from "../path-input";
import { listDirectory } from "../remote-listing";
import type {
  CompletionContext,
  CompletionItem,
  CompletionProvider,
  CompletionResult,
  ParsedLine,
} from "../types";

interface FileCommandSpec {
  /** 该命令的第几个参数是路径（1 = 第一个参数）。 */
  positions: number[];
  /**
   * 只保留这些后缀的文件（小写比较）。不传 = 不过滤。
   * 目录永远保留，不管后缀。
   */
  extensions?: string[];
}

const ARCHIVE = [".zip", ".tar", ".tar.gz", ".tgz", ".tar.xz", ".txz", ".tar.bz2", ".tbz2", ".tar.zst"];

/** 需要文件参数的命令 → 参数位与可接受的后缀。 */
const FILE_COMMANDS: Record<string, FileCommandSpec> = {
  cat: { positions: [1] },
  less: { positions: [1] },
  more: { positions: [1] },
  head: { positions: [1] },
  tail: { positions: [1] },
  vim: { positions: [1] },
  vi: { positions: [1] },
  nano: { positions: [1] },
  sed: { positions: [1] },
  grep: { positions: [2] },
  rm: { positions: [1] },
  cp: { positions: [1, 2] },
  mv: { positions: [1, 2] },
  touch: { positions: [1] },
  chmod: { positions: [2] },
  chown: { positions: [2] },
  ln: { positions: [1] },
  stat: { positions: [1] },
  file: { positions: [1] },
  wc: { positions: [1] },
  du: { positions: [1] },
  source: { positions: [1] },

  // -- 压缩 / 解压：按后缀过滤，这是"智能"的核心 --------------------------
  unzip: { positions: [1], extensions: [".zip"] },
  tar: { positions: [1, 2, 3, 4, 5], extensions: ARCHIVE },
  gunzip: { positions: [1], extensions: [".gz"] },
  zcat: { positions: [1], extensions: [".gz"] },
  unxz: { positions: [1], extensions: [".xz"] },
  xzcat: { positions: [1], extensions: [".xz"] },
  bunzip2: { positions: [1], extensions: [".bz2"] },
  bzcat: { positions: [1], extensions: [".bz2"] },
  unzstd: { positions: [1], extensions: [".zst"] },
  zstdcat: { positions: [1], extensions: [".zst"] },
  "7z": { positions: [1], extensions: ARCHIVE },
  "7za": { positions: [1], extensions: ARCHIVE },
  rar: { positions: [1], extensions: [".rar"] },
  unrar: { positions: [1], extensions: [".rar"] },

  // -- 校验和：只对文件有意义 ---------------------------------------------
  md5sum: { positions: [1, 2, 3] },
  sha1sum: { positions: [1, 2, 3] },
  sha256sum: { positions: [1, 2, 3] },
  sha512sum: { positions: [1, 2, 3] },
  md5: { positions: [1] },
  openssl: { positions: [3] },
};

function accepts(spec: FileCommandSpec, entry: RemoteFileEntry): boolean {
  // 目录（含符号链接）永远可以继续往里走。
  if (entry.kind === "directory" || entry.kind === "symlink") return true;
  if (!spec.extensions) return true;
  const name = entry.name.toLowerCase();
  return spec.extensions.some((extension) => name.endsWith(extension));
}

export function createFileProvider(options: {
  list?: (args: { sessionId: string; path: string }) => Promise<RemoteFileEntry[]>;
} = {}): CompletionProvider {
  const read: (sessionId: string, path: string) => Promise<RemoteFileEntry[]> = options.list
    ? (sessionId, path) => options.list!({ sessionId, path })
    : listDirectory;

  return {
    id: "file",
    matches(parsed: ParsedLine): boolean {
      const spec = FILE_COMMANDS[parsed.command];
      return spec !== undefined && spec.positions.includes(parsed.index);
    },
    async complete(ctx: CompletionContext, parsed: ParsedLine): Promise<CompletionResult> {
      const spec = FILE_COMMANDS[parsed.command]!;
      // cwd 未知时退回家目录，再不行退回根：宁可给"最可能的目录"，
      // 也不要让 unzip/tar 这类命令完全没有候选。
      const base = ctx.cwd ?? ctx.home ?? "/";
      const input = analyzePathInput(parsed.prefix, base, ctx.home ?? base);
      const requestKey = `file:${parsed.command}:${input?.dir ?? "?"}:${input?.partial ?? ""}`;
      if (!input || input.needsHome) return { items: [], requestKey };

      let entries: RemoteFileEntry[];
      try {
        entries = await read(ctx.sessionId, input.dir);
      } catch {
        // 文件补全只是辅助：读不到就安静地什么都不给，不用打扰用户。
        return { items: [], requestKey };
      }

      const { partial } = input;
      const matched = entries
        .filter((entry) => entry.name.startsWith(partial))
        .filter((entry) => !entry.hidden || input.showHidden)
        .filter((entry) => accepts(spec, entry))
        .sort((a, b) => a.name.localeCompare(b.name));

      const start = ctx.cursor - partial.length;
      const items: CompletionItem[] = matched.map((entry, index) => {
        const isDirectory = entry.kind === "directory" || entry.kind === "symlink";
        return {
          label: entry.name,
          insertText: quotePathSegment(entry.name, input.quote, isDirectory),
          detail: displayRelativePath(input.dir, entry.name, ctx.cwd),
          icon: isDirectory ? "directory" : "file",
          type: isDirectory ? "directory" : "file",
          replaceRange: { start, end: ctx.cursor },
          priority: (isDirectory ? 60 : 50) - index,
          source: "file",
          highlight: partial ? { start: 0, length: partial.length } : undefined,
        };
      });

      return {
        items,
        // 过滤后一个都没有时说明原因，避免用户以为补全坏了。
        notice:
          items.length === 0 && spec.extensions
            ? `当前目录没有 ${spec.extensions.join(" / ")} 文件`
            : undefined,
        requestKey,
      };
    },
  };
}
