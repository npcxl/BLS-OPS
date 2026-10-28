import { beforeEach, describe, expect, it } from "vitest";
import { useDatabaseWorkspaceStore } from "../database-workspace-store";

const base = {
  profileId: "p1",
  connectionName: "conn",
  database: "db",
  savedQueryId: "saved-1",
  sql: "select 1",
  title: "saved",
};

describe("opening a saved query", () => {
  beforeEach(() => {
    useDatabaseWorkspaceStore.setState({ items: [], activeId: null });
  });

  it("focuses the existing work item instead of creating a duplicate", () => {
    const first = useDatabaseWorkspaceStore.getState().newQuery(base);
    useDatabaseWorkspaceStore.getState().setStatus(first, { dirty: true });

    const second = useDatabaseWorkspaceStore.getState().newQuery(base);

    expect(second).toBe(first);
    expect(useDatabaseWorkspaceStore.getState().items).toHaveLength(1);
    expect(useDatabaseWorkspaceStore.getState().activeId).toBe(first);
    expect(useDatabaseWorkspaceStore.getState().items[0].dirty).toBe(true);
  });
});
