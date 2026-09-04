/**
 * RemoteDirectoryProvider —— `cd` 的远程目录实时补全。
 *
 * 目录只从当前 SSH 会话的 SFTP 列目录取（见 `remote-listing`）：不读本地
 * 文件系统，也不执行并解析 `ls` 文本。
 *
 * 三条硬规则：
 * 1. 只提示目录（含符号链接 —— `cd` 能进去），普通文件一律不出现；
 * 2. 只有输入以 `.` 开头时才显示隐藏目录；
 * 3. 没有匹配时明确提示"没有匹配的远程目录"，**绝不显示上一次的缓存结果**。
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

/** 视为"能 cd 进去"的 kind。 */
export const DIRECTORY_KINDS = new Set(["directory", "symlink"]);

export interface RemoteDirectoryOptions {
  /** 自定义列目录实现（测试用）。 */
  list?: (args: { sessionId: string; path: string }) => Promise<RemoteFileEntry[]>;
}

export function createRemoteDirectoryProvider(
  options: RemoteDirectoryOptions = {},
): CompletionProvider {
  // 包装成"两参数"签名：默认走共享的 SFTP 列表层，测试可替换。
  const read: (sessionId: string, path: string) => Promise<RemoteFileEntry[]> = options.list
    ? (sessionId, path) => options.list!({ sessionId, path })
    : listDirectory;

  return {
    id: "remote-directory",
    matches(parsed: ParsedLine): boolean {
      // 只有 `cd` 的第一个参数归它管。
      return parsed.command === "cd" && parsed.index === 1;
    },
    async complete(ctx: CompletionContext, parsed: ParsedLine): Promise<CompletionResult> {
      const input = analyzePathInput(parsed.prefix, ctx.cwd, ctx.home);
      const requestKey = `cd:${input?.dir ?? "?"}:${input?.partial ?? ""}`;

      if (!input) {
        return {
          items: [],
          notice: "还不知道当前远程目录，无法补全（等 Shell Integration 上报或执行一次 cd 后即可）",
          requestKey,
        };
      }
      if (input.needsHome) {
        return { items: [], notice: "还不知道远程家目录，无法补全 ~", requestKey };
      }

      let entries: RemoteFileEntry[];
      try {
        entries = await read(ctx.sessionId, input.dir);
      } catch (cause) {
        return {
          items: [],
          notice: `读取远程目录失败：${cause instanceof Error ? cause.message : String(cause)}`,
          requestKey,
        };
      }

      const directories = entries.filter((entry) => DIRECTORY_KINDS.has(entry.kind));
      const { partial } = input;
      const lower = partial.toLowerCase();
      // 始终是**前缀**匹配，绝不把"包含"当匹配（否则 `cd o` 会冒出一堆无关目录）。
      let matched = directories.filter((entry) => entry.name.startsWith(partial));
      if (matched.length === 0 && partial !== "") {
        matched = directories.filter((entry) => entry.name.toLowerCase().startsWith(lower));
      }
      // 隐藏目录只在输入以 `.` 开头时出现。
      const visible = matched
        .filter((entry) => !entry.hidden || input.showHidden)
        .sort((a, b) => a.name.localeCompare(b.name));

      if (visible.length === 0) {
        return { items: [], notice: "没有匹配的远程目录", requestKey };
      }

      const start = ctx.cursor - partial.length;
      const items: CompletionItem[] = visible.map((entry, index) => ({
        label: entry.name,
        // 目录保留结尾 `/`，补全后能继续提示下一层。
        insertText: quotePathSegment(entry.name, input.quote, true),
        detail: displayRelativePath(input.dir, entry.name, ctx.cwd),
        icon: "directory",
        type: "directory",
        replaceRange: { start, end: ctx.cursor },
        // 大小写精确匹配优先，其余按名字排。
        priority: (entry.name.startsWith(partial) ? 100 : 50) - index,
        source: "remote-directory",
        highlight: partial ? { start: 0, length: partial.length } : undefined,
      }));

      return { items, requestKey };
    },
  };
}
