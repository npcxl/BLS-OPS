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

  it("新建工作项不会继承同连接上一次的草稿", () => {
    saveDraft(TAB_ID, "select 4", PROFILE_ID);
    // 新工作项 id 与旧的不同（`query:${uuid}`）；不能拿"同连接最后一份草稿"，
    // 否则从某张表新建查询会带着上一次的 SQL。
    useDatabaseWorkbenchStore.getState().ensureTab("query:test:restart", PROFILE_ID);

    expect(
      useDatabaseWorkbenchStore.getState().tabs["query:test:restart"]?.sql,
    ).toBe("");
  });

  it("显式初始 SQL 覆盖草稿（从某张表新建查询）", () => {
    saveDraft(TAB_ID, "select 5", PROFILE_ID);
    useDatabaseWorkbenchStore
      .getState()
      .ensureTab("query:test:table", PROFILE_ID, "SELECT * FROM `bls`.`biz_inventory` LIMIT 200;");

    expect(
      useDatabaseWorkbenchStore.getState().tabs["query:test:table"]?.sql,
    ).toBe("SELECT * FROM `bls`.`biz_inventory` LIMIT 200;");
  });
});
