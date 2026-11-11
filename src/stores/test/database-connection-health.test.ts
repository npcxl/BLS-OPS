import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DbSessionInfo, ProfileRuntimeStatus } from "@/api/types/database";
// 这个用例断言中文错误消息，显式切到 zh-CN（测试环境的默认语言是英文）。
import "@/workbench/views/database/test/zh-setup";

const api = vi.hoisted(() => ({
  connect: vi.fn(), disconnect: vi.fn(), profileClose: vi.fn(),
  profileStatus: vi.fn(), sessionInfo: vi.fn(),
}));
vi.mock("@/api/ops-api", () => ({ databaseApi: api }));
vi.mock("@/components/ui/toast", () => ({ pushToast: vi.fn() }));
import { isSqlConnected, useDatabaseStore } from "../database-store";

const p = "health-profile";
const session = { session_id: "old", profile_id: p, generation: 1, state: "ready", transaction: "none" } as DbSessionInfo;
const status = { profile_id: p, generation: 1, connected: true } as ProfileRuntimeStatus;
const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
};

describe("database connection health", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    useDatabaseStore.setState({ profiles: [], sessions: {}, statuses: {}, sessionErrors: {} });
    api.disconnect.mockResolvedValue(undefined);
    api.profileClose.mockResolvedValue(undefined);
    api.profileStatus.mockResolvedValue(status);
    api.sessionInfo.mockResolvedValue(session);
  });

  it("a failed SQL connection cannot appear connected just because runtime initialization succeeded", () => {
    expect(isSqlConnected(undefined, status, { stage: "tcp", message: "Connection closed" } as never)).toBe(false);
  });

  it("lost SQL session overrides a live metadata runtime", async () => {
    useDatabaseStore.setState({ sessions: { [p]: session } });
    api.sessionInfo.mockResolvedValue({ ...session, state: "lost", transaction: "unknown" });
    await useDatabaseStore.getState().refreshStatus(p);
    const state = useDatabaseStore.getState();
    expect(isSqlConnected(state.sessions[p], state.statuses[p])).toBe(false);
    expect(state.sessions[p].transaction).toBe("unknown");
    expect(state.sessionErrors[p]?.message).toMatch(/已关闭/);
    expect(await state.ensureSession(p)).toBeNull();
    expect(api.connect).not.toHaveBeenCalled();
  });

  it("explicit reconnect closes runtime before connecting again", async () => {
    useDatabaseStore.setState({ sessions: { [p]: session } });
    const fresh = { ...session, session_id: "new", generation: 2 };
    api.connect.mockImplementation(async () => {
      expect(api.profileClose).toHaveBeenCalledWith(p);
      return fresh;
    });
    expect(await useDatabaseStore.getState().reconnect(p)).toEqual(fresh);
    expect(api.disconnect).toHaveBeenCalledWith("old");
  });

  it("concurrent opens share one actual connection", async () => {
    const pending = deferred<DbSessionInfo>();
    api.connect.mockReturnValue(pending.promise);
    const a = useDatabaseStore.getState().ensureSession(p);
    const b = useDatabaseStore.getState().ensureSession(p);
    pending.resolve(session);
    expect(await a).toEqual(session);
    expect(await b).toEqual(session);
    expect(api.connect).toHaveBeenCalledTimes(1);
  });

  it("closing while connecting rejects and releases late session", async () => {
    const pending = deferred<DbSessionInfo>();
    api.connect.mockReturnValue(pending.promise);
    const opened = useDatabaseStore.getState().ensureSession(p);
    await useDatabaseStore.getState().closeSession(p);
    pending.resolve(session);
    expect(await opened).toBeNull();
    expect(useDatabaseStore.getState().sessions[p]).toBeUndefined();
    expect(api.disconnect).toHaveBeenCalledWith("old");
  });

  it("a late status cannot turn a disconnected profile green", async () => {
    const pending = deferred<ProfileRuntimeStatus>();
    api.profileStatus.mockReturnValueOnce(pending.promise).mockResolvedValue({ ...status, connected: false });
    const old = useDatabaseStore.getState().refreshStatus(p);
    await useDatabaseStore.getState().disconnectProfile(p);
    pending.resolve(status);
    await old;
    expect(useDatabaseStore.getState().statuses[p].connected).toBe(false);
  });

  it("session read failure marks old connection lost rather than keeping a green light", async () => {
    useDatabaseStore.setState({ sessions: { [p]: session }, statuses: { [p]: status } });
    api.sessionInfo.mockRejectedValue(new Error("Connection closed"));
    await useDatabaseStore.getState().refreshSession(p);
    const state = useDatabaseStore.getState();
    expect(isSqlConnected(state.sessions[p], state.statuses[p])).toBe(false);
    expect(state.sessionErrors[p]?.message).toBe("Connection closed");
  });

  it("old session refresh cannot overwrite a freshly reconnected session", async () => {
    useDatabaseStore.setState({ sessions: { [p]: session } });
    const pending = deferred<DbSessionInfo>();
    api.sessionInfo.mockReturnValueOnce(pending.promise);
    const old = useDatabaseStore.getState().refreshSession(p);
    useDatabaseStore.setState({ sessions: { [p]: { ...session, session_id: "new" } } });
    pending.resolve({ ...session, state: "lost" });
    await old;
    expect(useDatabaseStore.getState().sessions[p].session_id).toBe("new");
  });
});
