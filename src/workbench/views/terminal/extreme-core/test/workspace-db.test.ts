import { beforeEach, describe, expect, it, vi } from "vitest";

const syncMock = vi.hoisted(() => vi.fn());
const listMock = vi.hoisted(() => vi.fn());
vi.mock("@/api/ops-api", () => ({
  opsApi: {
    extremeWorkspaceSync: syncMock,
    extremeWorkspaceList: listMock,
  },
}));

import type { ExtremeWorkspace } from "../workspace-history";
import { loadWorkspacesFromDb, saveWorkspacesToDb } from "../workspace-db";

const workspace = (): ExtremeWorkspace => ({
  id: "w1",
  serverId: "s1",
  server: "生产",
  host: "root@example.com",
  serverKey: "key",
  sessionId: "ssh-1",
  folders: ["/opt/app"],
  draft: "草稿",
  title: "标题",
  updatedAt: 42,
  context: {
    messages: [],
    attachments: [],
    plan: null,
    planSession: null,
    planTaskId: null,
    notice: null,
    model: null,
    executing: false,
  },
  messages: [
    {
      id: "m1",
      role: "user",
      text: "看看磁盘",
      tools: [
        {
          tool: "read_file",
          args: {},
          command: "df -h",
          exitCode: 0,
          output: "ok",
          truncated: false,
          elapsedMs: 1,
        },
      ],
    },
    { id: "m2", role: "assistant", text: "" },
  ],
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe("对话写入数据库", () => {
  it("只写持久字段：不带 context、不存空消息与 tools", async () => {
    syncMock.mockResolvedValue(undefined);
    await expect(saveWorkspacesToDb([workspace()])).resolves.toBe(true);

    const payload = syncMock.mock.calls[0][0] as Array<Record<string, unknown>>;
    expect(payload).toHaveLength(1);
    expect(payload[0]).not.toHaveProperty("context");
    expect(payload[0].messages).toEqual([
      { id: "m1", role: "user", text: "看看磁盘" },
    ]);
    expect(payload[0]).toMatchObject({ id: "w1", draft: "草稿", updatedAt: 42 });
  });

  it("数据库不可用时返回 false，保留 localStorage 兜底", async () => {
    syncMock.mockRejectedValue(new Error("no tauri"));
    await expect(saveWorkspacesToDb([workspace()])).resolves.toBe(false);
  });

  it("读取时过滤掉没有 id / messages 的脏行", async () => {
    listMock.mockResolvedValue([
      { id: "w1", messages: [] },
      { id: "bad", messages: "not-array" },
      { messages: [] },
    ]);
    await expect(loadWorkspacesFromDb()).resolves.toEqual([
      { id: "w1", messages: [] },
    ]);
  });

  it("调用失败返回 null，不用空数组冒充“数据库为空”", async () => {
    listMock.mockRejectedValue(new Error("no tauri"));
    await expect(loadWorkspacesFromDb()).resolves.toBeNull();
  });
});
