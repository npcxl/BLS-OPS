import { describe, expect, it } from "vitest";
import {
  approvePlan,
  bumpPlan,
  canRetry,
  canTransition,
  conflictsWith,
  createTask,
  isApproved,
  isReadOnly,
  isTerminal,
  isWriteTask,
  moveTask,
  statusLabel,
  type TaskCard,
} from "../extreme-core/task";

const target = { serverId: "srv-a", sessionId: "sess-1", label: "10.0.0.5" };

function deployTask(overrides: Partial<TaskCard> = {}): TaskCard {
  return {
    ...createTask({
      id: "task-1",
      kind: "deploy",
      title: "更新 ops",
      goal: "把 dist.zip 换到线上",
      target,
      now: 1,
    }),
    ...overrides,
  };
}

describe("createTask", () => {
  it("写任务先检查，只读任务直接跑", () => {
    expect(deployTask().status).toBe("inspecting");
    const query = createTask({
      id: "task-q",
      kind: "query",
      title: "查订单",
      goal: "最近 10 单",
      target,
    });
    expect(query.status).toBe("running");
    expect(isReadOnly("query")).toBe(true);
    expect(isWriteTask("deploy")).toBe(true);
  });

  it("新卡默认展开、未确认", () => {
    const task = deployTask();
    expect(task.collapsed).toBe(false);
    expect(task.approvedVersion).toBeUndefined();
    expect(isApproved(task)).toBe(false);
  });
});

describe("状态流转", () => {
  it("完成是终态，不能回到执行中", () => {
    expect(canTransition("done", "running")).toBe(false);
    expect(isTerminal("done")).toBe(true);
    const done = moveTask(deployTask({ status: "done" }), "running");
    expect(done.status).toBe("done");
  });

  it("失败可以重试，取消要重新检查", () => {
    expect(canRetry("failed")).toBe(true);
    expect(canRetry("cancelled")).toBe(true);
    expect(canRetry("done")).toBe(false);
    expect(canTransition("failed", "running")).toBe(true);
    expect(canTransition("cancelled", "running")).toBe(false);
    expect(canTransition("cancelled", "inspecting")).toBe(true);
  });

  it("非法流转原对象返回，不抛错", () => {
    const task = deployTask({ status: "confirming" });
    expect(moveTask(task, "done")).toBe(task);
  });

  it("进终态清掉进行中的步骤与字节进度", () => {
    const running = deployTask({
      status: "running",
      step: { title: "上传 dist.zip", startedAt: 1 },
      bytes: { done: 10, total: 100 },
    });
    const failed = moveTask(running, "failed");
    expect(failed.step).toBeUndefined();
    expect(failed.bytes).toBeUndefined();
  });

  it("每个状态都有中文文案", () => {
    for (const status of ["inspecting", "waiting", "confirming", "running", "verifying", "done", "failed", "cancelled"] as const) {
      expect(statusLabel(status).length).toBeGreaterThan(0);
    }
  });
});

describe("计划版本与确认", () => {
  it("确认后记下版本", () => {
    const approved = approvePlan(deployTask({ status: "confirming" }));
    expect(approved.approvedVersion).toBe(1);
    expect(approved.status).toBe("running");
    expect(isApproved(approved)).toBe(true);
  });

  it("改计划后旧确认失效", () => {
    const approved = approvePlan(deployTask({ status: "confirming" }));
    const changed = bumpPlan(approved);
    expect(changed.planVersion).toBe(2);
    expect(changed.approvedVersion).toBeUndefined();
    expect(isApproved(changed)).toBe(false);
  });

  it("改计划不会把执行中的任务打回确认", () => {
    const running = deployTask({ status: "running" });
    expect(bumpPlan(running).status).toBe("running");
  });
});

describe("同目标写任务互斥", () => {
  const running = [
    { id: "task-a", kind: "deploy" as const, target, status: "running" as const },
  ];

  it("同服务器上的第二个写任务被拦下并给出占用者", () => {
    const next = deployTask({ id: "task-b", status: "confirming" });
    expect(conflictsWith(next, running)).toBe("task-a");
  });

  it("只读任务不受影响", () => {
    const query = { id: "task-q", kind: "query" as const, target, status: "running" as const };
    expect(conflictsWith(query, running)).toBeNull();
  });

  it("不同服务器可以并行", () => {
    const other = deployTask({
      id: "task-c",
      status: "confirming",
      target: { serverId: "srv-b", label: "10.0.0.6" },
    });
    expect(conflictsWith(other, running)).toBeNull();
  });

  it("已结束的写任务不占锁", () => {
    const finished = [
      { id: "task-a", kind: "deploy" as const, target, status: "done" as const },
    ];
    expect(conflictsWith(deployTask({ id: "task-b", status: "confirming" }), finished)).toBeNull();
  });
});
