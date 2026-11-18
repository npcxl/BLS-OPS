import { describe, expect, it } from "vitest";
import { routeIntent } from "../intent";
import { buildStaticUpdatePlan } from "../static-update-plan";
import {
  contextOfCard,
  contextsOfTasks,
  nextActionOfCard,
  planKindOfCard,
  verificationStep,
} from "../task-bridge";
import type { TaskCardModel } from "../task-view";
import { cardFromPlan } from "../task-view";

const card = (patch: Partial<Parameters<typeof cardFromPlan>[0]> = {}): TaskCardModel =>
  cardFromPlan({
    id: "task-1",
    plan: [],
    server: "prod",
    sessionId: "ssh-1",
    originMessageId: "msg-1",
    ...patch,
  });

describe("任务卡 → 任务上下文", () => {
  it("保留发起消息，卡片才能挂回原来那句话", () => {
    expect(contextOfCard(card()).originMessageId).toBe("msg-1");
  });

  it("卡片状态映射成阶段：已取消仍可重试，不是终态", () => {
    expect(contextOfCard(card({ status: "inspecting" })).phase).toBe("collecting");
    expect(contextOfCard(card({ status: "confirming" })).phase).toBe("confirming");
    expect(contextOfCard(card({ status: "verifying" })).phase).toBe("running");
    expect(contextOfCard(card({ status: "cancelled" })).phase).toBe("failed");
    expect(contextOfCard(card({ status: "done" })).phase).toBe("done");
  });

  it("静态计划能认出 planKind，于是「开始吧」直接执行而不是重新出计划", () => {
    const task = card({
      plan: buildStaticUpdatePlan({ root: "/var/www/app", zipPath: "/root/dist.zip" }),
      status: "confirming",
    });
    expect(planKindOfCard(task)).toBe("static-update");
    expect(nextActionOfCard(task)).toBe("confirm");
    expect(routeIntent("开始吧", [contextOfCard(task)])).toEqual({
      kind: "continue",
      taskId: "task-1",
      action: "run",
    });
  });

  it("没有计划只有等待补充 → 下一步是重新检查，说「开始」会原地补计划", () => {
    const task = card({ status: "waiting" });
    expect(nextActionOfCard(task)).toBe("wait");
    expect(routeIntent("开始", [contextOfCard(task)])).toEqual({
      kind: "continue",
      taskId: "task-1",
      action: "plan",
    });
  });

  it("完成后不再给按钮", () => {
    expect(nextActionOfCard(card({ status: "done" }))).toBe("done");
  });

  it("停止中的任务给的是「停止」而不是确认", () => {
    const task = card({ plan: buildStaticUpdatePlan({ root: "/a", zipPath: "/b.zip" }), status: "running" });
    expect(nextActionOfCard(task)).toBe("run");
  });
});

describe("按会话收任务", () => {
  it("只把这一台的任务交给意图路由", () => {
    const mine = card({ status: "confirming" });
    const other = card({ id: "task-2", sessionId: "ssh-2", status: "confirming" });
    const contexts = contextsOfTasks({ "task-1": mine, "task-2": other }, "ssh-1");
    expect(contexts.map((task) => task.taskId)).toEqual(["task-1"]);
    // 切到另一台后，说「开始吧」不能推进上一台的任务。
    const route = routeIntent("开始吧", contextsOfTasks({ "task-1": mine, "task-2": other }, "ssh-9"));
    expect(route).toEqual({ kind: "chat" });
  });
});

describe("验证步骤", () => {
  it("认 kind: verify（静态 / Compose 计划）", () => {
    const task = card({ plan: buildStaticUpdatePlan({ root: "/a", zipPath: "/b.zip" }) });
    expect(verificationStep(task)?.id).toBe("static-verify");
  });

  it("宿主机模式的验证步骤 kind 是 up，也要能认出来", () => {
    const task = card({
      plan: [{ id: "verify", kind: "up", title: "验证页面", detail: "curl", state: "success" }],
    });
    expect(verificationStep(task)?.id).toBe("verify");
  });

  it("没有验证步骤就不编一个", () => {
    expect(verificationStep(card())).toBeUndefined();
  });
});
