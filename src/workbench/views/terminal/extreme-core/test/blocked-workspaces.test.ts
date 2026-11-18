import { describe, expect, it } from "vitest";
import { blockedWorkspaces } from "../task-view";
import type { TaskCardModel } from "../task-view";

const card = (id: string, workspaceId: string, status: TaskCardModel["status"]): TaskCardModel => ({
  id,
  kind: "deploy",
  title: id,
  workspaceId,
  goal: "",
  status,
  result: "",
  server: "aliyun",
  sessionId: "sess",
  createdAt: 1,
  updatedAt: 2,
  steps: [],
  artifacts: [],
});

describe("哪些对话不能删", () => {
  it("运行中 / 等确认 / 等补充信息都拦下", () => {
    const blocked = blockedWorkspaces(
      {
        a: card("a", "w1", "running"),
        b: card("b", "w2", "confirming"),
        c: card("c", "w3", "waiting"),
      },
      null,
      false,
    );
    expect([...blocked].sort()).toEqual(["w1", "w2", "w3"]);
  });

  it("终态不拦（历史仍可删）", () => {
    const blocked = blockedWorkspaces(
      {
        a: card("a", "w1", "done"),
        b: card("b", "w2", "failed"),
        c: card("c", "w3", "cancelled"),
      },
      null,
      false,
    );
    expect(blocked.size).toBe(0);
  });

  it("部署执行中：当前对话也算有任务", () => {
    expect(blockedWorkspaces({}, "w1", true).has("w1")).toBe(true);
    expect(blockedWorkspaces({}, null, true).size).toBe(0);
  });

  it("没有归属的卡片不会误伤任何对话", () => {
    const orphan = { ...card("x", "w", "running"), workspaceId: null };
    expect(blockedWorkspaces({ x: orphan }, null, false).size).toBe(0);
  });
});
