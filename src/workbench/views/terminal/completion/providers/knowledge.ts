/**
 * KnowledgeCommandProvider —— 知识库命令补全（兜底提供器）。
 *
 * 只有当**没有更具体的提供器接管**时才轮到它（见 `registry.ts` 的顺序）：
 * 光标落在命令词上 → 检索知识库；`docker logs <cursor>` 这种具体参数位由
 * DockerResourceProvider 接管，这里不插手。
 *
 * 命中项带 `hit`，渲染层据此走原有的占位符 / 二级参数选择流程 ——
 * 未解析的 `<unit>` 绝不会写进 shell。
 */

import { opsApi, toErrorMessage, type CommandSearchHit } from "@/api/ops-api";
import type {
  CompletionContext,
  CompletionItem,
  CompletionProvider,
  CompletionResult,
  ParsedLine,
} from "../types";

export type KnowledgeSearcher = (query: string, limit: number) => Promise<CommandSearchHit[]>;

let searcher: KnowledgeSearcher = (query, limit) => opsApi.commandSearch(query, limit);

/** 替换检索实现（测试用）。 */
export function setKnowledgeSearcher(next: KnowledgeSearcher | null): void {
  searcher = next ?? ((query: string, limit: number) => opsApi.commandSearch(query, limit));
}

export function createKnowledgeProvider(options: { limit?: number } = {}): CompletionProvider {
  const limit = options.limit ?? 8;

  return {
    id: "knowledge",
    matches(parsed: ParsedLine): boolean {
      // 命令词（第 0 个 token）永远归知识库。
      if (parsed.index === 0) return parsed.prefix.trim().length > 0;
      // 第一个参数只在"像子命令"时接管：`docker <cursor>` 该给 `docker ps`
      // 这类候选，而 `free -h` 里的 `-h` 不是命令。
      if (parsed.index === 1) return !parsed.prefix.startsWith("-");
      // 更后面的参数位（容器名、单元名、远程路径…）由各自的 Provider 接管。
      return false;
    },
    async complete(ctx: CompletionContext, _parsed: ParsedLine): Promise<CompletionResult> {
      // `docker <cursor>` 要把 `docker ` 一起检索（补的是子命令），
      // 所以查询串是"光标之前的整行"，不是单个 token。
      const query = ctx.line.slice(0, ctx.cursor);
      const requestKey = `knowledge:${query}`;
      let hits: CommandSearchHit[];
      try {
        hits = await searcher(query, limit);
      } catch (cause) {
        return { items: [], notice: toErrorMessage(cause), requestKey };
      }

      const items: CompletionItem[] = hits.map((hit, index) => ({
        label: hit.syntax,
        insertText: hit.syntax,
        detail: hit.title,
        icon: "command",
        type: "command",
        // 整行替换：后续由 `completionKeys` / `keysForReplace` 算最小按键序列。
        replaceRange: { start: 0, end: ctx.cursor },
        priority: 100 - index,
        source: "knowledge",
        hit,
        highlight: highlightFor(hit.syntax, query.trim()),
      }));

      return { items, requestKey };
    },
  };
}

/** 命中项与查询串有公共前缀才高亮，避免把不相干的字也标出来。 */
function highlightFor(
  syntax: string,
  query: string,
): { start: number; length: number } | undefined {
  if (!query) return undefined;
  return syntax.toLowerCase().startsWith(query.toLowerCase())
    ? { start: 0, length: query.length }
    : undefined;
}
