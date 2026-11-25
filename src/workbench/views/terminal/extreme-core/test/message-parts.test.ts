import { expect, it } from "vitest";
import type { AgentPlan } from "@/api/types/agent";
import {
  anchoredSteps,
  appendText,
  latestPlan,
  partsOf,
  partsText,
  planForTask,
  replaceTrailingText,
  trailingText,
  upsertNote,
  upsertPlanPart,
  upsertStep,
} from "../message-parts";

function planOf(revision: number, state: "pending" | "done" = "pending"): AgentPlan {
  return {
    understanding: "检查并部署",
    summary: "先探查再部署",
    prerequisites: ["生产环境"],
    revision,
    createdAt: 1,
    updatedAt: revision,
    steps: [
      {
        id: "s1",
        title: "检查 Nginx 配置",
        action: "读取 nginx.conf",
        verify: "确认站点目录",
        kind: "probe",
        state,
      },
      {
        id: "s2",
        title: "更新配置",
        action: "写入新的 server 块",
        verify: "nginx -t 通过",
        kind: "action",
        state: "pending",
      },
    ],
  };
}

it("keeps the real order of prose and commands in one turn", () => {
  // 我先检查 Nginx 配置 → 命令 → 发现端口没监听 → 再看日志
  let parts = partsOf({ id: "m1", text: "" });
  parts = appendText(parts, "我先检查 Nginx 配置。");
  parts = upsertStep(parts, { taskId: "task-1", stepIndex: 0, label: "检查 Nginx 配置" });
  parts = appendText(parts, "发现 80 端口没有监听。");
  parts = upsertStep(parts, { taskId: "task-1", stepIndex: 1, label: "查看 80 端口" });
  parts = appendText(parts, "结论：nginx 没有启动。");

  expect(parts.map((part) => part.kind)).toEqual(["text", "step", "text", "step", "text"]);
  expect(partsText(parts)).toBe(
    "我先检查 Nginx 配置。发现 80 端口没有监听。结论：nginx 没有启动。",
  );
});

it("merges duplicate step events and keeps the first operation name", () => {
  let parts = appendText([], "先看看");
  parts = upsertStep(parts, { taskId: "task-1", stepIndex: 0, label: "检查 Nginx 配置" });
  const again = upsertStep(parts, { taskId: "task-1", stepIndex: 0, label: "用户拒绝执行这条命令" });
  // 幂等：同一步骤不会多出一行；操作名不被状态说明改写。
  expect(again).toBe(parts);
  expect(again.filter((part) => part.kind === "step")).toHaveLength(1);
  expect(again[1]).toMatchObject({ label: "检查 Nginx 配置" });
});

it("marks a denied step without losing the order", () => {
  let parts = upsertStep([], { taskId: "t", stepIndex: 0, label: "写入配置", denied: true });
  parts = upsertStep(parts, { taskId: "t", stepIndex: 0, denied: true });
  expect(parts).toHaveLength(1);
  expect(parts[0]).toMatchObject({ kind: "step", denied: true });
});

it("replaces only the trailing prose when the authoritative reply arrives", () => {
  let parts = appendText([], "我先检查配置");
  parts = upsertStep(parts, { taskId: "task-1", stepIndex: 0, label: "检查 Nginx 配置" });
  parts = appendText(parts, "端口没监听");

  const final = replaceTrailingText(parts, "80 端口没有监听，nginx 没有启动。");
  expect(final).toHaveLength(3);
  expect(final[0]).toMatchObject({ kind: "text", text: "我先检查配置" });
  expect(final[2]).toMatchObject({
    kind: "text",
    text: "80 端口没有监听，nginx 没有启动。",
  });
  expect(trailingText(final)).toContain("nginx 没有启动");
});

it("falls back to the whole text for records written before parts existed", () => {
  expect(partsOf({ id: "old", text: "旧回复" })).toEqual([
    { kind: "text", id: "text-old", text: "旧回复" },
  ]);
  expect(partsOf({ id: "empty", text: "" })).toEqual([]);
});

it("finds approvals that are already drawn inside the timeline", () => {
  const keys = anchoredSteps([
    {
      parts: [
        { kind: "text", id: "t", text: "先检查" },
        { kind: "step", id: "s", taskId: "task-1", stepIndex: 2 },
      ],
    },
    { parts: [{ kind: "step", id: "s2", taskId: "task-2", stepIndex: 0 }] },
  ]);
  expect([...keys].sort()).toEqual(["task-1:2", "task-2:0"]);
});

it("keeps one execution note per group, above its first command", () => {
  let parts = upsertStep([], {
    taskId: "t",
    stepIndex: 0,
    label: "检查配置",
    groupId: "p-s1",
    planStepId: "s1",
  });
  parts = upsertNote(parts, { groupId: "p-s1", text: "先检查 Nginx 配置。" });
  parts = upsertNote(parts, { groupId: "p-s1", text: "先检查 Nginx 配置。" });
  expect(parts.filter((part) => part.kind === "note")).toHaveLength(1);
  expect(parts.map((part) => part.kind)).toEqual(["note", "step"]);
  // 同步重复事件不会改写说明；不同组各有一条。
  parts = upsertNote(parts, { groupId: "p-s2", text: "再确认端口。" });
  expect(parts.filter((part) => part.kind === "note")).toHaveLength(2);
  expect(parts[0]).toMatchObject({ kind: "note", text: "先检查 Nginx 配置。" });
});

it("stores the latest plan on the message without disturbing the order", () => {
  let parts = appendText([], "我先把计划列出来。");
  parts = upsertStep(parts, { taskId: "t", stepIndex: 0, label: "检查配置" });
  parts = upsertPlanPart(parts, { taskId: "t", plan: planOf(1) });
  parts = upsertPlanPart(parts, { taskId: "t", plan: planOf(2, "done") });
  expect(parts.filter((part) => part.kind === "plan")).toHaveLength(1);
  expect(parts.map((part) => part.kind)).toEqual(["text", "step", "plan"]);
  // 计划不参与正文拼接（复制 / 引用只拿模型说过的话）。
  expect(partsText(parts)).toBe("我先把计划列出来。");
});

it("finds the plan for a task and the latest plan in the session", () => {
  const first = appendText([], "第一轮");
  const messages = [
    { id: "m1", text: "第一轮", parts: upsertPlanPart(first, { taskId: "task-1", plan: planOf(1) }) },
    {
      id: "m2",
      text: "第二轮",
      parts: upsertPlanPart(appendText([], "第二轮"), { taskId: "task-2", plan: planOf(2) }),
    },
  ];
  expect(planForTask(messages, "task-1")?.revision).toBe(1);
  expect(planForTask(messages, "task-3")).toBeNull();
  expect(latestPlan(messages)).toMatchObject({ taskId: "task-2", plan: { revision: 2 } });
});
