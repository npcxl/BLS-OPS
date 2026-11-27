import { expect, it } from "vitest";
import { pickPlanRow } from "../view/locate-plan-step";

/**
 * 计划卡定位的**归属**断言：两轮都叫 s1 时，只能命中自己那一轮。
 *
 * 只断言 `scrollIntoView` 被调用过是没用的 —— 那分不清滚的是哪一条。
 */
function row(taskId: string, planStepId: string, state: string): HTMLElement {
  const node = document.createElement("div");
  node.dataset.taskId = taskId;
  node.dataset.planStep = planStepId;
  node.dataset.state = state;
  return node;
}

it("同一会话两轮都有 s1：只命中自己的 taskId", () => {
  const root = document.createElement("div");
  const first = row("task-1", "s1", "success");
  const second = row("task-2", "s1", "success");
  root.append(first, second);

  expect(pickPlanRow(root, "task-2", "s1")).toBe(second);
  expect(pickPlanRow(root, "task-1", "s1")).toBe(first);
  // 没有任何归属匹配时宁可不定位，也不退回别的任务里同名的步骤。
  expect(pickPlanRow(root, "task-3", "s1")).toBeNull();
});

it("同一步执行多次：优先运行中，其次最近一次", () => {
  const root = document.createElement("div");
  const older = row("task-1", "s1", "success");
  const newer = row("task-1", "s1", "success");
  root.append(older, newer);
  expect(pickPlanRow(root, "task-1", "s1")).toBe(newer);

  const running = row("task-1", "s1", "running");
  root.append(running);
  expect(pickPlanRow(root, "task-1", "s1")).toBe(running);
});

it("折叠组里的行还没挂载时返回 null（由调用方展开后重试）", () => {
  const root = document.createElement("div");
  root.append(row("task-1", "s2", "success"));
  expect(pickPlanRow(root, "task-1", "s1")).toBeNull();
});
