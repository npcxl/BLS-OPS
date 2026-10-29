import "@/i18n";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { i18n } from "@/i18n";
import { pushToast } from "@/components/ui/toast";
import { databaseApi } from "@/api/ops-api";
import type {
  DatabaseProfile,
  DbErrorInfo,
  DbSessionInfo,
  ProfileRuntimeStatus,
} from "@/api/types/database";
import { useDatabaseStore } from "@/stores/database-store";
import { DatabaseAssetSidebar } from "../DatabaseAssetSidebar";
import { RedisBrowser } from "../RedisBrowser";

/**
 * Redis 连接入口的回归测试。
 *
 * 锁死两条线：
 * 1. Redis **只能**走 `db_redis_connect`，任何入口都不许把 Redis 送进 `db_connect`
 *    （后端只会回 unsupported，界面上表现为"打不开又没提示"）。
 * 2. Redis 的连接状态唯一来源是 `statuses`（Rust 运行时状态），不是 `sessions`
 *    （那是 SQL 会话表，Redis 永远不会有条目）。
 */

// 错误提示走全局 alert（ToastHost），这里只关心"推了什么"，不渲染宿主。
vi.mock("@/components/ui/toast", () => ({
  pushToast: vi.fn(),
  dismissToast: vi.fn(),
  ToastHost: () => null,
}));

const REDIS_ID = "redis-standalone";
const MYSQL_ID = "mysql-main";

(
  globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

function profileOf(overrides: Partial<DatabaseProfile>): DatabaseProfile {
  return {
    id: "p",
    name: "p",
    engine: "mysql",
    host: "127.0.0.1",
    port: 3306,
    username: "root",
    default_database: null,
    has_password: false,
    ssh_server_id: null,
    tls_mode: "disabled",
    tls_ca_path: null,
    tls_server_name: null,
    read_only: true,
    redis_mode: null,
    sentinel_master: null,
    nodes_json: null,
    connect_timeout_ms: 10_000,
    query_timeout_ms: 60_000,
    created_at: 0,
    updated_at: 0,
    ...overrides,
  };
}

const redisProfile = profileOf({
  id: REDIS_ID,
  name: "缓存",
  engine: "redis",
  port: 6379,
  username: "",
  redis_mode: "standalone",
});

const mysqlProfile = profileOf({ id: MYSQL_ID, name: "订单库" });

function statusOf(id: string, connected: boolean): ProfileRuntimeStatus {
  return {
    profile_id: id,
    generation: connected ? 1 : 0,
    connected,
    tunnel_active: false,
    tunnel_local_port: null,
    open_sessions: 0,
    active_queries: 0,
    server_version: connected ? "7.2.4" : null,
  };
}

function sessionOf(id: string): DbSessionInfo {
  return {
    session_id: `s-${id}`,
    profile_id: id,
    generation: 1,
    connection_id: 7,
    server_version: "8.0.36",
    current_database: null,
    tls_active: false,
    tls_cipher: null,
    tls_version: null,
    transaction: "none",
    read_only: true,
    opened_at: Date.now(),
  };
}

const authError: DbErrorInfo = {
  stage: "auth",
  code: null,
  sql_state: null,
  message: "WRONGPASS invalid username-password pair",
  detail: null,
  retryable: false,
};

/** 把挂起的 promise 链（effect → await → set）推到底。 */
async function flush() {
  for (let index = 0; index < 10; index += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

function resetStore() {
  useDatabaseStore.setState({
    profiles: [],
    loadingProfiles: false,
    profileError: null,
    expandedProfiles: {},
    expandedDatabases: {},
    openedDatabases: {},
    expandedTables: {},
    expandedCategories: {},
    databases: {},
    tables: {},
    details: {},
    loading: {},
    errors: {},
    sessions: {},
    sessionErrors: {},
    statuses: {},
    redisConnecting: {},
    openTableRequest: null,
  });
}

describe("Redis 连接入口", () => {
  let container: HTMLDivElement;
  let root: Root;
  let extraContainer: HTMLDivElement | null;

  beforeEach(() => {
    localStorage.clear();
    resetStore();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    extraContainer = null;
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    extraContainer?.remove();
    vi.restoreAllMocks();
  });

  const connectLabel = i18n.t("打开连接");
  const disconnectLabel = i18n.t("关闭连接");

  it("侧栏点连接按钮走 db_redis_connect，绝不调用 db_connect", async () => {
    useDatabaseStore.setState({ profiles: [redisProfile] });
    const redisConnect = vi
      .spyOn(databaseApi, "redisConnect")
      .mockResolvedValue(statusOf(REDIS_ID, true));
    const connect = vi.spyOn(databaseApi, "connect");
    vi.spyOn(databaseApi, "profileStatus").mockResolvedValue(
      statusOf(REDIS_ID, false),
    );

    act(() => root.render(<DatabaseAssetSidebar />));
    await flush();

    const button = container.querySelector<HTMLButtonElement>(
      `button[aria-label="${connectLabel}"]`,
    );
    expect(button).not.toBeNull();

    await act(async () => {
      button?.click();
    });
    await flush();

    expect(redisConnect).toHaveBeenCalledTimes(1);
    expect(redisConnect).toHaveBeenCalledWith(REDIS_ID);
    expect(connect).not.toHaveBeenCalled();
    // 连接成功也不能凭空造一条 SQL 会话。
    expect(useDatabaseStore.getState().sessions[REDIS_ID]).toBeUndefined();
    expect(useDatabaseStore.getState().statuses[REDIS_ID]?.connected).toBe(
      true,
    );
  });

  it("Redis 的已连接状态只看 statuses，不看 sessions", async () => {
    useDatabaseStore.setState({
      profiles: [redisProfile],
      statuses: { [REDIS_ID]: statusOf(REDIS_ID, true) },
      sessions: {},
    });
    vi.spyOn(databaseApi, "profileStatus").mockResolvedValue(
      statusOf(REDIS_ID, true),
    );

    act(() => root.render(<DatabaseAssetSidebar />));
    await flush();

    expect(
      container.querySelector(`button[aria-label="${disconnectLabel}"]`),
    ).not.toBeNull();
    expect(
      container.querySelector(`button[aria-label="${connectLabel}"]`),
    ).toBeNull();
  });

  it("store 的 ensureSession 遇到 Redis 会改道 db_redis_connect", async () => {
    useDatabaseStore.setState({ profiles: [redisProfile] });
    const redisConnect = vi
      .spyOn(databaseApi, "redisConnect")
      .mockResolvedValue(statusOf(REDIS_ID, true));
    const connect = vi.spyOn(databaseApi, "connect");

    const session = await useDatabaseStore.getState().ensureSession(REDIS_ID);

    expect(session).toBeNull();
    expect(redisConnect).toHaveBeenCalledWith(REDIS_ID);
    expect(connect).not.toHaveBeenCalled();
  });

  it("MySQL 仍然走 db_connect，不会被 Redis 分支带偏", async () => {
    useDatabaseStore.setState({ profiles: [mysqlProfile] });
    const redisConnect = vi.spyOn(databaseApi, "redisConnect");
    const connect = vi
      .spyOn(databaseApi, "connect")
      .mockResolvedValue(sessionOf(MYSQL_ID));
    vi.spyOn(databaseApi, "profileStatus").mockResolvedValue(
      statusOf(MYSQL_ID, true),
    );

    const session = await useDatabaseStore.getState().ensureSession(MYSQL_ID);

    expect(session?.session_id).toBe(`s-${MYSQL_ID}`);
    expect(connect).toHaveBeenCalledTimes(1);
    expect(redisConnect).not.toHaveBeenCalled();
    expect(useDatabaseStore.getState().sessions[MYSQL_ID]?.session_id).toBe(
      `s-${MYSQL_ID}`,
    );
  });

  it("侧栏与键浏览器同时建连只会发一条 db_redis_connect", async () => {
    useDatabaseStore.setState({ profiles: [redisProfile] });
    let release: (value: ProfileRuntimeStatus) => void = () => undefined;
    const pending = new Promise<ProfileRuntimeStatus>((resolve) => {
      release = resolve;
    });
    const redisConnect = vi
      .spyOn(databaseApi, "redisConnect")
      .mockReturnValue(pending);
    vi.spyOn(databaseApi, "profileStatus").mockResolvedValue(
      statusOf(REDIS_ID, false),
    );
    vi.spyOn(databaseApi, "redisScan").mockResolvedValue({
      cursor: 0,
      keys: [],
      dbsize: 0,
    });

    // 侧栏点击"打开连接"（IPC 还挂着）
    const sidebarTask = useDatabaseStore.getState().redisConnect(REDIS_ID);

    // 标签里的键浏览器同时挂载
    extraContainer = document.createElement("div");
    document.body.appendChild(extraContainer);
    const extraRoot = createRoot(extraContainer);
    act(() => extraRoot.render(<RedisBrowser profile={redisProfile} />));
    await flush();

    expect(redisConnect).toHaveBeenCalledTimes(1);

    await act(async () => {
      release(statusOf(REDIS_ID, true));
      await sidebarTask;
    });
    await flush();

    expect(redisConnect).toHaveBeenCalledTimes(1);
    act(() => extraRoot.unmount());
  });

  it("键浏览器在已连接时不再建连，且只 SCAN 一页", async () => {
    useDatabaseStore.setState({
      profiles: [redisProfile],
      statuses: { [REDIS_ID]: statusOf(REDIS_ID, true) },
    });
    const redisConnect = vi.spyOn(databaseApi, "redisConnect");
    const scan = vi.spyOn(databaseApi, "redisScan").mockResolvedValue({
      cursor: 0,
      keys: [],
      dbsize: 0,
    });

    act(() => root.render(<RedisBrowser profile={redisProfile} />));
    await flush();

    expect(redisConnect).not.toHaveBeenCalled();
    expect(scan).toHaveBeenCalledTimes(1);
    expect(scan.mock.calls[0][0]).toBe(REDIS_ID);
  });

  it("未连接时先建连、连上之后才 SCAN", async () => {
    useDatabaseStore.setState({ profiles: [redisProfile] });
    const redisConnect = vi
      .spyOn(databaseApi, "redisConnect")
      .mockResolvedValue(statusOf(REDIS_ID, true));
    const connect = vi.spyOn(databaseApi, "connect");
    vi.spyOn(databaseApi, "profileStatus").mockResolvedValue(
      statusOf(REDIS_ID, false),
    );
    const scan = vi.spyOn(databaseApi, "redisScan").mockResolvedValue({
      cursor: 0,
      keys: [],
      dbsize: 0,
    });

    act(() => root.render(<RedisBrowser profile={redisProfile} />));
    await flush();

    expect(redisConnect).toHaveBeenCalledTimes(1);
    expect(connect).not.toHaveBeenCalled();
    expect(scan).toHaveBeenCalledTimes(1);
    expect(scan.mock.invocationCallOrder[0]).toBeGreaterThan(
      redisConnect.mock.invocationCallOrder[0],
    );
  });

  it("建连失败时错误显示在界面上，且不会去 SCAN", async () => {
    useDatabaseStore.setState({ profiles: [redisProfile] });
    vi.spyOn(databaseApi, "profileStatus").mockResolvedValue(
      statusOf(REDIS_ID, false),
    );
    vi.spyOn(databaseApi, "redisConnect").mockRejectedValue(authError);
    const scan = vi.spyOn(databaseApi, "redisScan");
    vi.mocked(pushToast).mockClear();

    act(() => root.render(<RedisBrowser profile={redisProfile} />));
    await flush();

    // 内容区（空态）必须解释为什么是空的。
    expect(container.textContent).toContain("WRONGPASS");
    expect(scan).not.toHaveBeenCalled();

    // 同时推到顶部 alert：阶段标签 + 原文 + 常驻（点 × 才消失）。
    const calls = vi.mocked(pushToast).mock.calls;
    const call = calls[calls.length - 1];
    expect(call?.[0]).toBe(authError.message);
    expect(call?.[1]).toBe("error");
    expect(call?.[2]).toMatchObject({ label: "auth", persist: true });

    // 错误同时留在 store 里（侧栏展开时也能显示）。
    expect(useDatabaseStore.getState().sessionErrors[REDIS_ID]?.message).toBe(
      authError.message,
    );
  });

  it("重新连接会先关运行时再建连（否则复用旧配置）", async () => {
    const order: string[] = [];
    vi.spyOn(databaseApi, "profileClose").mockImplementation(async () => {
      order.push("close");
    });
    vi.spyOn(databaseApi, "profileStatus").mockResolvedValue(
      statusOf(REDIS_ID, false),
    );
    vi.spyOn(databaseApi, "redisConnect").mockImplementation(async () => {
      order.push("connect");
      return statusOf(REDIS_ID, true);
    });

    await useDatabaseStore.getState().redisReconnect(REDIS_ID);

    expect(order).toEqual(["close", "connect"]);
    expect(useDatabaseStore.getState().statuses[REDIS_ID]?.connected).toBe(
      true,
    );
  });
});
