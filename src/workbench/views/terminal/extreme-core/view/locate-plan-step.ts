/**
 * 计划卡定位：在聊天滚动容器里按 **taskId + 计划步骤 id** 找目标命令。
 *
 * 抽成纯函数是为了能被测试直接验证"命中的到底是不是**这一轮**的步骤"：
 * 同一对话里两轮都有 `s1` 时，只能拿到 `taskId` 匹配的那一条，绝不跨任务
 * 回退。同一步执行过多次时，优先正在运行的那条，其次最近一次。
 */
export function pickPlanRow(
  root: ParentNode,
  taskId: string,
  planStepId: string,
): HTMLElement | null {
  const list = Array.from(root.querySelectorAll<HTMLElement>("[data-plan-step]")).filter(
    (node) => node.dataset.planStep === planStepId && node.dataset.taskId === taskId,
  );
  if (list.length === 0) return null;
  const running = list.find((node) => node.dataset.state === "running");
  return running ?? list[list.length - 1];
}
