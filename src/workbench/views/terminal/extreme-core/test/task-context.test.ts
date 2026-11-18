import { describe, expect, it } from "vitest";
import {
  canContinue,
  createTaskContext,
  nextAction,
  selectPlanKind,
  withPlan,
  withVerifiedTarget,
} from "../task-context";

const base = () =>
  createTaskContext({
    taskId: "task-1",
    originMessageId: "msg-1",
    server: "prod",
    sessionId: "ssh-1",
    attachmentIds: ["att-dist"],
  });

describe("任务上下文", () => {
  it("创建时显式绑定发起消息，并处于收集态", () => {
    const task = base();
    expect(task.originMessageId).toBe("msg-1");
    expect(task.phase).toBe("collecting");
    expect(nextAction(task)).toBe("inspect");
  });

  it("有已核实目标且没计划 → 下一步是生成计划，而不是失败", () => {
    const task = withVerifiedTarget(base(), {
      kind: "static-site",
      root: "/var/www/app",
      evidence: "nginx root=/var/www/app, index.html 存在",
    });
    expect(nextAction(task)).toBe("plan");
    // 已核实目标 → 「开始吧」能接续（原地生成计划）
    expect(canContinue(task)).toBe(true);
  });

  it("计划已生成 → 待确认，下一步是确认执行", () => {
    const task = withPlan(base(), "static-update");
    expect(task.phase).toBe("confirming");
    expect(nextAction(task)).toBe("confirm");
    expect(canContinue(task)).toBe(true);
  });

  it("目标变化会让计划版本 +1（旧确认失效）", () => {
    const first = withVerifiedTarget(base(), { kind: "static-site", root: "/a", evidence: "e" });
    const second = withVerifiedTarget(first, { kind: "static-site", root: "/b", evidence: "e" });
    expect(second.planVersion).toBe(first.planVersion + 1);
  });

  it("等待用户的任务仍可继续", () => {
    expect(canContinue({ phase: "waiting" })).toBe(true);
    expect(canContinue({ phase: "running" })).toBe(false);
    expect(canContinue({ phase: "done" })).toBe(false);
  });
});

describe("计划类型选择", () => {
  it("静态站点 + 服务器上已有 dist.zip → 静态更新（不再要求 Compose）", () => {
    expect(
      selectPlanKind({
        staticSiteOnServer: true,
        distZipOnServer: true,
        composeProjectOnServer: false,
        composeInAttachments: false,
      }),
    ).toBe("static-update");
  });

  it("服务器上是 Compose 项目 → 更新现有服务", () => {
    expect(
      selectPlanKind({
        staticSiteOnServer: false,
        distZipOnServer: false,
        composeProjectOnServer: true,
        composeInAttachments: true,
      }),
    ).toBe("compose-update");
  });

  it("只有附件带 compose → 新建 Compose", () => {
    expect(
      selectPlanKind({
        staticSiteOnServer: false,
        distZipOnServer: false,
        composeProjectOnServer: false,
        composeInAttachments: true,
      }),
    ).toBe("compose-create");
  });

  it("什么都没核实 → 返回 null（先补信息，不返回缺 Compose）", () => {
    expect(
      selectPlanKind({
        staticSiteOnServer: false,
        distZipOnServer: false,
        composeProjectOnServer: false,
        composeInAttachments: false,
      }),
    ).toBeNull();
  });
});
