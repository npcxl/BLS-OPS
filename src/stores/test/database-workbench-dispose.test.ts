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
});
