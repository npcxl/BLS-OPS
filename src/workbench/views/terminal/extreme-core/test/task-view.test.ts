import { describe, expect, it } from "vitest";
import type { ExtremeTaskRecord } from "@/api/types/extreme";
import type { DeployStep } from "../deploy-plan";
import {
  artifactsOf,
  cardFromRecord,
  cardFromPlan,
  filterHistory,
  kindOfGoal,
  mergeHistory,
  riskOfPlan,
  sortHistory,
  statusForRecord,
  statusOf,
} from "../task-view";

const step = (patch: Partial<DeployStep>): DeployStep => ({
  id: "s1",
  kind: "upload",
  title: "上传 compose.yaml",
  detail: "/srv/app/compose.yaml",
  state: "pending",
  ...patch,
});

const record = (patch: Partial<ExtremeTaskRecord>): ExtremeTaskRecord => ({
  id: "task-1",
  kind: "deploy",
  server: "prod",
  sessionId: "ssh-1",
  status: "success",
  summary: "全部步骤通过",
  planJson: "[]",
  createdAt: 1,
  ...patch,
});

describe("任务卡视图模型", () => {
  it("历史状态与卡片状态互转", () => {
    expect(statusOf("success")).toBe("done");
    expect(statusOf("failed")).toBe("failed");
    expect(statusOf("waiting")).toBe("waiting");
    expect(statusForRecord("done")).toBe("success");
    expect(statusForRecord("failed")).toBe("failed");
  });

  it("从历史记录恢复步骤与产物（产物用 remotePath）", () => {
    const steps: DeployStep[] = [
      step({ id: "a", remotePath: "/srv/app/compose.yaml" }),
      step({ id: "b", kind: "verify", remotePath: "/srv/app/compose.yaml", state: "success" }),
    ];
    const card = cardFromRecord(record({ planJson: JSON.stringify(steps) }));
    expect(card.steps).toHaveLength(2);
    // 重复路径只保留一条产物
    expect(card.artifacts).toEqual([{ name: "compose.yaml", path: "/srv/app/compose.yaml" }]);
    expect(card.status).toBe("done");
    expect(card.server).toBe("prod");
  });

  it("库里的 running / waiting 是上次进程留下的：标成已中断并可恢复", () => {
    const card = cardFromRecord(record({ status: "running" }));
    expect(card.status).toBe("interrupted");
    expect(card.result).toContain("核对");
    expect(cardFromRecord(record({ status: "waiting" })).status).toBe("interrupted");
    // 真正完成 / 失败 / 取消的记录保持原状态。
    expect(cardFromRecord(record({ status: "success" })).status).toBe("done");
    expect(cardFromRecord(record({ status: "failed" })).status).toBe("failed");
  });

  it("恢复验证结论：能解析就展示，坏数据不崩", () => {
    const card = cardFromRecord(
      record({
        status: "failed",
        outcomeJson: JSON.stringify({
          level: "partial",
          reason: "改动后没有只读验证",
          evidence: ["#1 systemctl restart nginx"],
        }),
      }),
    );
    expect(card.outcome).toEqual({
      level: "partial",
      reason: "改动后没有只读验证",
      evidence: ["#1 systemctl restart nginx"],
    });
    expect(cardFromRecord(record({ outcomeJson: "{broken" })).outcome).toBeNull();
  });

  it("plan_json 坏掉时不崩，退化成空步骤", () => {
    const card = cardFromRecord(record({ planJson: "{not json" }));
    expect(card.steps).toEqual([]);
    expect(card.result).toBe("全部步骤通过");
  });

  it("执行中的任务排在历史最前", () => {
    const list = [
      record({ id: "old", status: "success", createdAt: 3 }),
      record({ id: "running", status: "running", createdAt: 1 }),
      record({ id: "new", status: "failed", createdAt: 9 }),
      record({ id: "waiting", status: "waiting", createdAt: 2 }),
    ];
    const ordered = sortHistory(list).map((item) => item.id);
    // 前两个是"执行中 / 等待用户"（内部再按时间倒序），后面按时间倒序。
    expect(new Set(ordered.slice(0, 2))).toEqual(new Set(["running", "waiting"]));
    expect(ordered.slice(2)).toEqual(["new", "old"]);
  });

  it("标题用用户目标（或自定义名称），摘要用最新结果", () => {
    const named = cardFromRecord(record({ goal: "查一下当前跑了哪些服务", name: "我的任务" }));
    expect(named.title).toBe("我的任务");
    const goal = cardFromRecord(record({ goal: "查一下当前跑了哪些服务", summary: "已完成 3 步" }));
    expect(goal.title).toBe("查一下当前跑了哪些服务");
    expect(goal.result).toBe("已完成 3 步");
  });

  it("类型看用户目标，风险从步骤单独记录", () => {
    expect(kindOfGoal("查一下当前跑了哪些服务")).toBe("query");
    expect(kindOfGoal("构建前端产物")).toBe("build");
    expect(kindOfGoal("重启 nginx")).toBe("automation");
    expect(kindOfGoal("巡检这台服务器")).toBe("probe");
    expect(kindOfGoal("部署新版本")).toBe("deploy");

    const plan = JSON.stringify([step({ risk: "write" }), step({ id: "s2", risk: "danger" })]);
    expect(riskOfPlan(plan)).toBe("danger");
    const card = cardFromRecord(record({ goal: "重启 nginx", planJson: plan }));
    expect(card.kind).toBe("automation");
  });

  it("先按 taskId 合并实时状态，再分类排序", () => {
    const db = [
      record({
        id: "task-a",
        status: "running",
        goal: "查一下当前跑了哪些服务",
        createdAt: 2,
        planJson: JSON.stringify([step({ risk: "read" })]),
      }),
      record({ id: "task-b", status: "success", goal: "部署新版本", createdAt: 1 }),
    ];
    const live = {
      "task-a": cardFromPlan({
        id: "task-a",
        plan: [step({ risk: "read" })],
        server: "prod",
        sessionId: "ssh-1",
        goal: "查一下当前跑了哪些服务",
        status: "done",
        result: "已完成",
        createdAt: 2,
      }),
    };

    const merged = mergeHistory(db, live);
    const a = merged.find((item) => item.id === "task-a")!;
    // 数据库里还是 running，实时已经完成 → 合并后是 success，筛选「执行中」不会命中。
    expect(a.status).toBe("success");
    expect(a.kind).toBe("query");
    expect(a.summary).toBe("已完成");
    expect(a.goal).toBe("查一下当前跑了哪些服务");

    // 验收：面板停在「执行中」时任务完成，它必须离开这个筛选、出现在「成功」。
    expect(filterHistory(merged, { status: "running" }).map((item) => item.id)).toEqual([]);
    expect(filterHistory(merged, { status: "success" }).map((item) => item.id)).toEqual([
      "task-a",
      "task-b",
    ]);
    // 类型筛选同样基于目标，不是步骤风险。
    expect(filterHistory(merged, { kind: "query" }).map((item) => item.id)).toEqual(["task-a"]);
  });

  it("数据库里还没有的实时任务也会出现在列表", () => {
    const live = {
      "task-new": cardFromPlan({
        id: "task-new",
        plan: [step({ risk: "danger" })],
        server: "prod",
        sessionId: "ssh-1",
        goal: "重启 nginx",
        status: "running",
        createdAt: 9,
      }),
    };
    const merged = mergeHistory([], live);
    expect(merged.map((item) => item.id)).toEqual(["task-new"]);
    expect(merged[0].kind).toBe("automation");
    expect(merged[0].risk).toBe("danger");
  });

  it("执行中的计划推导出进度与类型标题", () => {
    const card = cardFromPlan({
      id: "task-plan",
      plan: [
        step({ state: "success", remotePath: "/srv/app/compose.yaml" }),
        step({ id: "s2", title: "启动", kind: "up", state: "running" }),
      ],
      server: "prod",
      sessionId: "ssh-1",
      kind: "deploy",
    });
    expect(card.title).toContain("部署");
    expect(card.result).toBe("1/2 步完成");
    expect(artifactsOf(card.steps)).toHaveLength(1);
  });
});
