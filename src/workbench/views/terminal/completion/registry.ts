/**
 * 补全注册表 —— **唯一决定"这一次补全归谁管"的地方**。
 *
 * 想加一种新的补全，写一个新的 Provider 塞进 `defaultProviders()` 即可，
 * 渲染层与 TerminalView 都不用动（以前是在 `TerminalSuggest` 里加 if/else）。
 *
 * 顺序即优先级：越靠前越具体。`knowledge` 永远在最后 —— 它只在没有更具体
 * 的提供器接管时兜底。
 */

import { parseLine } from "./path-input";
import { createEnvironmentProvider } from "./providers/environment";
import { createDockerResourceProvider } from "./providers/docker-resource";
import { createServiceProvider } from "./providers/service";
import { createProcessProvider } from "./providers/process";
import { createRemoteDirectoryProvider } from "./providers/remote-directory";
import { createFileProvider } from "./providers/file";
import { createKnowledgeProvider } from "./providers/knowledge";
import type {
  CompletionContext,
  CompletionProvider,
  CompletionResult,
  ParsedLine,
} from "./types";

/** 空结果（带 requestKey，调度器据此丢弃过期响应）。 */
function empty(requestKey: string, notice?: string): CompletionResult {
  return { items: [], notice, requestKey };
}

/** 默认提供器顺序：环境 → Docker → 服务 → 进程 → cd 目录 → 文件 → 知识库。 */
export function defaultProviders(): CompletionProvider[] {
  return [
    createEnvironmentProvider(),
    createDockerResourceProvider(),
    createServiceProvider(),
    createProcessProvider(),
    createRemoteDirectoryProvider(),
    createFileProvider(),
    createKnowledgeProvider(),
  ];
}

/** 按命令 + 光标位置挑出接管这次补全的提供器。 */
export function providerFor(
  parsed: ParsedLine,
  providers: CompletionProvider[],
): CompletionProvider | null {
  return providers.find((provider) => provider.matches(parsed)) ?? null;
}

export interface ResolveOptions {
  providers?: CompletionProvider[];
}

/**
 * 解析一次补全。
 *
 * 光标位置来自调用方（终端里是"已输入行的末尾"），**按光标所在参数位**
 * 决定提供器，而不是只看整行结尾。
 */
export async function resolveCompletions(
  ctx: CompletionContext,
  options: ResolveOptions = {},
): Promise<CompletionResult> {
  const providers = options.providers ?? defaultProviders();
  if (ctx.line.trim().length === 0) return empty("empty");

  const parsed = parseLine(ctx.line, ctx.cursor);
  const provider = providerFor(parsed, providers);
  if (!provider) return empty(`none:${ctx.line}`);

  return provider.complete(ctx, parsed);
}
