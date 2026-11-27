import { beforeEach, describe, expect, it } from "vitest";
import {
  cleanupItemsOf,
  isPlatformStagedPath,
  useCleanupStore,
  type CleanupRequest,
} from "../attachments/cleanup";
import type { ExtremeAttachment } from "@/stores/extreme-store";

const KEY = "bls-ops.extreme-cleanup.v1";

function request(taskId: string, attachmentId: string): CleanupRequest {
  return {
    taskId,
    workspaceId: "ws-1",
    serverId: "srv-1",
    createdAt: 1,
    items: [
      {
        id: attachmentId,
        name: "dist.zip",
        remotePath: `/root/.bls-ops/staging/ws-1/${attachmentId}/dist.zip`,
      },
    ],
  };
}

beforeEach(() => {
  localStorage.removeItem(KEY);
  useCleanupStore.setState({ requests: [] });
});

describe("暂存清理请求按任务持久化", () => {
  it("两个任务各自一条，后完成的任务不会覆盖前一个", () => {
    const store = useCleanupStore.getState();
    store.offer(request("task-1", "att-1"));
    store.offer(request("task-2", "att-2"));

    const requests = useCleanupStore.getState().requests;
    expect(requests.map((item) => item.taskId)).toEqual(["task-1", "task-2"]);
    expect(requests[0].items[0].id).toBe("att-1");
  });

  it("写入 localStorage：切换会话 / 重启后仍能找到", () => {
    useCleanupStore.getState().offer(request("task-1", "att-1"));
    const raw = localStorage.getItem(KEY);
    expect(raw).toBeTruthy();
    const parsed = JSON.parse(raw!) as CleanupRequest[];
    expect(parsed[0].taskId).toBe("task-1");
    expect(parsed[0].items[0].remotePath).toContain("/.bls-ops/staging/ws-1/att-1/");
  });

  it("删除失败保留请求与原因，可以重试；用户选保留才移除", () => {
    const store = useCleanupStore.getState();
    store.offer(request("task-1", "att-1"));
    store.fail("task-1", "Permission denied");

    const failed = useCleanupStore.getState().requests[0];
    expect(failed.error).toBe("Permission denied");
    expect(failed.items).toHaveLength(1);

    useCleanupStore.getState().dismiss("task-1");
    expect(useCleanupStore.getState().requests).toHaveLength(0);
  });

  it("部分成功只移出已删条目，失败的留在请求里", () => {
    const store = useCleanupStore.getState();
    store.offer({
      ...request("task-1", "att-1"),
      items: [
        request("task-1", "att-1").items[0],
        request("task-1", "att-2").items[0],
      ],
    });
    useCleanupStore.getState().settle("task-1", ["att-1"]);
    const left = useCleanupStore.getState().requests[0];
    expect(left.items.map((item) => item.id)).toEqual(["att-2"]);
  });
});

describe("cleanupItemsOf 只收平台暂存副本", () => {
  const base: ExtremeAttachment = {
    id: "att-1",
    name: "dist.zip",
    size: 1,
    state: "ready",
  };

  it("staged + 平台路径才进清理清单", () => {
    const items = cleanupItemsOf("ws-1", [
      {
        ...base,
        staged: true,
        remotePath: "/root/.bls-ops/staging/ws-1/att-1/dist.zip",
        stagedPath: "/root/.bls-ops/staging/ws-1/att-1/dist.zip",
        uploadState: "uploaded",
      },
      // 服务器上原有的文件：不是平台副本。
      {
        ...base,
        id: "remote-1",
        remotePath: "/var/www/dist.zip",
        uploadState: "uploaded",
      },
      // 已清理：没有路径。
      { ...base, id: "att-2", uploadState: "cleaned" },
    ]);
    expect(items).toHaveLength(1);
    expect(items[0].id).toBe("att-1");
  });

  it("别的对话 / 别的附件目录不算", () => {
    expect(
      isPlatformStagedPath("ws-1", {
        id: "att-1",
        remotePath: "/root/.bls-ops/staging/ws-2/att-1/dist.zip",
      }),
    ).toBe(false);
    expect(
      isPlatformStagedPath("ws-1", {
        id: "att-1",
        remotePath: "/root/.bls-ops/staging/ws-1/att-9/dist.zip",
      }),
    ).toBe(false);
  });
});
