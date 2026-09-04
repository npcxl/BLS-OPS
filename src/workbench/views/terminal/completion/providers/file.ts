/**
 * FileProvider —— 需要**文件参数**的命令（`cat`、`tail`、`vim`、`rm` …）。
 *
 * 与 `RemoteDirectoryProvider` 的区别只有一个：这里**文件和目录都给**
 * （`cat nginx.conf` 与 `cat /etc/nginx/` 同样合法）。目录保留结尾 `/`，
 * 文件不加 —— 用户一眼能看出补全的是哪一种。
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

/** 需要文件参数的命令 → 该命令的第几个参数是路径（1 = 第一个参数）。 */
const FILE_COMMANDS: Record<string, number[]> = {
  cat: [1],
  less: [1],
  more: [1],
  head: [1],
  tail: [1],
  vim: [1],
  vi: [1],
  nano: [1],
  sed: [1],
  grep: [2],
  rm: [1],
  cp: [1, 2],
  mv: [1, 2],
  touch: [1],
  chmod: [2],
  chown: [2],
  ln: [1],
  stat: [1],
  file: [1],
  wc: [1],
  du: [1],
  source: [1],
};

export function createFileProvider(options: {
  list?: (args: { sessionId: string; path: string }) => Promise<RemoteFileEntry[]>;
} = {}): CompletionProvider {
  const read: (sessionId: string, path: string) => Promise<RemoteFileEntry[]> = options.list
    ? (sessionId, path) => options.list!({ sessionId, path })
    : listDirectory;

  return {
    id: "file",
    matches(parsed: ParsedLine): boolean {
      const positions = FILE_COMMANDS[parsed.command];
      return positions !== undefined && positions.includes(parsed.index);
    },
    async complete(ctx: CompletionContext, parsed: ParsedLine): Promise<CompletionResult> {
      const input = analyzePathInput(parsed.prefix, ctx.cwd, ctx.home);
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

      return { items, requestKey };
    },
  };
}
