import type { ExtremeMessage } from "@/stores/extreme-store";
import type { TaskCardModel } from "./task-view";

/** Rebuild historical choices and recorded results in their original order. */
export function sessionFacts(
  history: ExtremeMessage[],
  tasks: Record<string, TaskCardModel>,
  workspaceId: string,
  serverId: string | null,
): string {
  const facts: string[] = [];
  const seenSteps = new Set<string>();
  for (const message of history) {
    for (const part of message.parts ?? []) {
      if (part.kind === "question" && part.status === "answered" && part.answer) {
        const selected = part.answer.selected.map((id) =>
          part.question.options.find((option) => option.id === id)?.label ?? id,
        );
        if (part.answer.custom?.trim()) selected.push(part.answer.custom.trim());
        if (selected.length) facts.push(`用户选择：${part.question.question} → ${selected.join("、")}`);
      }
      if (part.kind !== "step") continue;
      const key = `${part.taskId}:${part.stepIndex}`;
      if (seenSteps.has(key)) continue;
      const task = tasks[part.taskId];
      if (!task || (task.workspaceId && task.workspaceId !== workspaceId) ||
          (task.serverId && task.serverId !== serverId)) continue;
      const step = task.steps.find((item) => item.id === `agent-${part.stepIndex}`);
      if (!step || !["success", "failed", "skipped"].includes(step.state)) continue;
      // 平台内部退回纠错从未触达服务器：不把内部噪声灌回后续轮次的模型上下文。
      if (step.category === "internal") continue;
      seenSteps.add(key);
      const status = step.state === "success" ? "成功" : step.state === "failed" ? "失败" : "未执行";
      const formatOutput = (label: string, value?: string) => {
        const chars = Array.from(value?.trim() ?? "");
        if (!chars.length) return "";
        return `\n${label}：${chars.slice(0, 8000).join("")}${chars.length > 8000 || step.truncated ? "\n（输出已截断）" : ""}`;
      };
      facts.push(`操作记录（${status}）：${step.command || step.title}${step.exitCode != null ? ` · 退出码 ${step.exitCode}` : ""}${formatOutput("标准输出", step.stdout)}${formatOutput("错误输出", step.stderr)}`);
    }
  }
  return facts.join("\n\n");
}
