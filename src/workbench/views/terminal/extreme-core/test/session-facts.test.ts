import { expect, it } from "vitest";
import type { ExtremeMessage } from "@/stores/extreme-store";
import type { TaskCardModel } from "../task-view";
import { sessionFacts } from "../session-facts";

it("carries answered choices and actual outcomes, isolated by workspace and server", () => {
  const history = [{
    id: "m", role: "assistant", text: "",
    parts: [
      { kind: "question", id: "q", taskId: "t", status: "answered", question: {
        questionId: "q", taskId: "t", workspaceId: "w", serverId: "s", question: "选择服务", kind: "single",
        options: [{ id: "api", label: "API 服务" }], allowCustom: true, deadline: 1,
      }, answer: { selected: ["api"], custom: "" }, draftSelected: [], draftCustom: "", draftCustomActive: false },
      { kind: "step", id: "a", taskId: "t", stepIndex: 0 },
      { kind: "step", id: "b", taskId: "t", stepIndex: 1 },
      { kind: "step", id: "c", taskId: "other", stepIndex: 0 },
    ],
  }] as ExtremeMessage[];
  const task = { workspaceId: "w", serverId: "s", steps: [
    { id: "agent-0", state: "success", command: "docker ps", stdout: "api Up" },
    { id: "agent-1", state: "failed", command: "restart api", stderr: "permission denied" },
  ] } as TaskCardModel;
  const other = { ...task, workspaceId: "other", steps: [{ id: "agent-0", state: "success", title: "other-server-secret" }] } as TaskCardModel;
  const facts = sessionFacts(history, { t: task, other }, "w", "s");
  expect(facts).toContain("选择服务 → API 服务");
  expect(facts).toContain("操作记录（成功）：docker ps");
  expect(facts).toContain("操作记录（失败）：restart api");
  expect(facts).not.toContain("other-server-secret");
  expect(sessionFacts(history, { t: task }, "w", "different")).not.toContain("docker ps");
  const largeTask = { ...task, steps: [{ ...task.steps[0], stdout: "x".repeat(9000) }] } as TaskCardModel;
  const largeFacts = sessionFacts(history, { t: largeTask }, "w", "s");
  expect(largeFacts).toContain("x".repeat(8000));
  expect(largeFacts).toContain("输出已截断");

  const withInternal = {
    ...task,
    steps: [
      ...task.steps,
      { id: "agent-2", state: "skipped", category: "internal", command: "bad-internal-cmd", stderr: "internal bounce" },
    ],
  } as TaskCardModel;
  const historyWithInternal = [{
    ...history[0],
    parts: [...(history[0].parts ?? []), { kind: "step", id: "d", taskId: "t", stepIndex: 2 }],
  }] as ExtremeMessage[];
  expect(sessionFacts(historyWithInternal, { t: withInternal }, "w", "s")).not.toContain("bad-internal-cmd");
});
