import { beforeEach, describe, expect, it } from "vitest";
import {
  saveDraft,
  useDatabaseWorkbenchStore,
} from "../database-workbench-store";

const TAB_ID = "query:test:dispose";
const PROFILE_ID = "profile:test:dispose";
const DRAFT_KEY = `ops.db.sql.${TAB_ID}`;

describe("database workbench dispose", () => {
  beforeEach(() => {
    localStorage.clear();
    useDatabaseWorkbenchStore.getState().dispose(TAB_ID);
  });

  it("默认保留 SQL 草稿，方便切换标签/关闭连接后恢复", () => {
    saveDraft(TAB_ID, "select 1");
    useDatabaseWorkbenchStore.getState().ensureTab(TAB_ID, PROFILE_ID);

    useDatabaseWorkbenchStore.getState().dispose(TAB_ID);

    expect(localStorage.getItem(DRAFT_KEY)).toBe("select 1");
  });

  it("明确关闭查询工作项时才清理草稿", () => {
    saveDraft(TAB_ID, "select 2");
    useDatabaseWorkbenchStore.getState().ensureTab(TAB_ID, PROFILE_ID);

    useDatabaseWorkbenchStore
      .getState()
      .dispose(TAB_ID, { clearDraft: true });

    expect(localStorage.getItem(DRAFT_KEY)).toBeNull();
  });

  it("空内容不会把已有草稿覆盖成空", () => {
    saveDraft(TAB_ID, "select 3", PROFILE_ID);
    // 编辑器挂载早期 sqlText 是 ""，这时落盘不能清掉用户原来的 SQL。
    saveDraft(TAB_ID, "", PROFILE_ID);

    expect(localStorage.getItem(DRAFT_KEY)).toBe("select 3");
  });

  it("重启后新建的工作项能读到同一连接的最后一份草稿", () => {
    saveDraft(TAB_ID, "select 4", PROFILE_ID);
    // 新工作项 id 与旧的不同（`query:${uuid}`），按 id 找不到草稿。
    useDatabaseWorkbenchStore.getState().ensureTab("query:test:restart", PROFILE_ID);

    expect(
      useDatabaseWorkbenchStore.getState().tabs["query:test:restart"]?.sql,
    ).toBe("select 4");
  });
});
