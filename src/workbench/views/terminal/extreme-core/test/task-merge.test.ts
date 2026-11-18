import { beforeEach, describe, expect, it } from "vitest";
import { useExtremeStore } from "@/stores/extreme-store";
import { cardFromPlan } from "../task-view";

const card = (status: "running" | "done" | "failed") =>
  cardFromPlan({
    id: "task-merge",
    plan: [],
    server: "prod",
    sessionId: "ssh-1",
    status,
    result: status,
  });

describe("任务状态合并", () => {
  beforeEach(() => {
    useExtremeStore.setState({ tasks: {}, taskVersions: {} });
  });

  it("本地写入每次递增版本", () => {
    const store = useExtremeStore.getState();
    store.upsertTask(card("running"));
    store.upsertTask(card("done"));
    expect(useExtremeStore.getState().taskVersions["task-merge"]).toBe(2);
    expect(useExtremeStore.getState().tasks["task-merge"].status).toBe("done");
  });

  it("迟到的旧事件不会把完成状态退回执行中", () => {
    const store = useExtremeStore.getState();
    store.mergeTask(card("done"), 5);
    // 乱序：先到的完成事件已记版本 5，后来的 running（版本 3）必须被丢弃。
    store.mergeTask(card("running"), 3);
    expect(useExtremeStore.getState().tasks["task-merge"].status).toBe("done");

    // 更新的失败事件可以覆盖。
    store.mergeTask(card("failed"), 6);
    expect(useExtremeStore.getState().tasks["task-merge"].status).toBe("failed");
  });

  it("同版本重复事件不重复写入", () => {
    const store = useExtremeStore.getState();
    store.mergeTask(card("running"), 2);
    const before = useExtremeStore.getState().tasks["task-merge"];
    store.mergeTask(card("failed"), 2);
    expect(useExtremeStore.getState().tasks["task-merge"]).toBe(before);
  });
});
