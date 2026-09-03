import type { CommandExecutionResult, DockerContainerRow } from "@/api/ops-api";
import { CommandResultPanel } from "@/workbench/views/command-result/CommandResultPanel";

/**
 * P4.4 结果面板 —— 交给**统一输出适配引擎**渲染。
 *
 * 旧实现在这里用 `if (adapter === "...")` 逐个分发到专用组件；新增命令就要
 * 同时改后端 match 与前端分支。现在只透传结果：
 *
 * ```text
 * 后端 registry（三层解析）→ StructuredCommandResult（统一协议）
 *   → CommandResultPanel → CommandResultRenderer（按 view 分发）
 * ```
 *
 * 原始输出、实际执行命令、耗时仍由 CommandResultPanel 永久保留。
 */
export function ResultPanel({ result }: { result: CommandExecutionResult }) {
  return <CommandResultPanel result={result} />;
}

/** docker ps 摘要（保留给其他视图复用）。 */
export function containerSummary(containers: DockerContainerRow[]) {
  const running = containers.filter((row) => row.state === "running").length;
  const stopped = containers.filter((row) => row.state === "exited").length;
  const other = containers.length - running - stopped;
  return { total: containers.length, running, stopped, other };
}
