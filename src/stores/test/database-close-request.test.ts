import { beforeEach, describe, expect, it } from "vitest";
import { useDatabaseWorkspaceStore } from "@/stores/database-workspace-store";

/**
 * 关闭请求只是"投递"，不直接改 items：
 * 真正的关闭要经过 DatabaseView 里的事务安全协调器。
 */

const store = () => useDatabaseWorkspaceStore.getState();

beforeEach(() => {
  useDatabaseWorkspaceStore.setState({
    items: [],
    activeId: null,
    closeRequest: null,
  });
  store().openTable({
    profileId: "p1",
    connectionName: "conn",
    database: "db",
    table: "t1",
  });
});

describe("工作项关闭请求", () => {
  it("requestClose 只记录请求，不删除工作项", () => {
    const item = store().items[0];
    store().requestClose(item.id, item.profileId);

    expect(store().closeRequest).toEqual({
      id: item.id,
      profileId: item.profileId,
      // 默认只关一项；批量关闭必须由调用方显式要求。
      mode: "one",
    });
    expect(store().items).toHaveLength(1);
  });

  it("mode=right 原样记录下来，关哪些交给协调器决定", () => {
    const item = store().items[0];
    store().requestClose(item.id, item.profileId, "right");

    expect(store().closeRequest).toEqual({
      id: item.id,
      profileId: item.profileId,
      mode: "right",
    });
    expect(store().items).toHaveLength(1);
  });

  it("consumeCloseRequest 只清匹配的请求", () => {
    const item = store().items[0];
    store().requestClose(item.id, item.profileId);
    store().consumeCloseRequest(item.id);

    expect(store().closeRequest).toBeNull();
  });

  it("消费旧 id 不会误清后来投递的请求", () => {
    const item = store().items[0];
    store().requestClose(item.id, item.profileId);
    store().consumeCloseRequest("another-item");

    expect(store().closeRequest?.id).toBe(item.id);
  });
});
