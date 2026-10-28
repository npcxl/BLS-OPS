import { describe, expect, it } from "vitest";
import { staleWorkbenchTabIds } from "../workspace-cleanup";

describe("staleWorkbenchTabIds", () => {
  it("保留仍属于活动连接的 SQL 工作项，即使工作区 tab id 完全不同", () => {
    const stale = staleWorkbenchTabIds(
      ["query:p1:1"],
      [{ id: "query:p1:1", profileId: "p1" }],
      new Set(["p1"]),
    );
    expect(stale).toEqual([]);
  });

  it("释放连接标签已经关闭的工作项", () => {
    const stale = staleWorkbenchTabIds(
      ["query:p2:1"],
      [{ id: "query:p2:1", profileId: "p2" }],
      new Set(["p1"]),
    );
    expect(stale).toEqual(["query:p2:1"]);
  });

  it("工作项已不存在时释放运行时资源", () => {
    const stale = staleWorkbenchTabIds(
      ["query:missing"],
      [{ id: "query:p1:1", profileId: "p1" }],
      new Set(["p1"]),
    );
    expect(stale).toEqual(["query:missing"]);
  });

  it("多连接时互不误杀", () => {
    const stale = staleWorkbenchTabIds(
      ["query:p1:1", "query:p2:1", "query:p3:1"],
      [
        { id: "query:p1:1", profileId: "p1" },
        { id: "query:p2:1", profileId: "p2" },
      ],
      new Set(["p1", "p2"]),
    );
    expect(stale).toEqual(["query:p3:1"]);
  });
});
