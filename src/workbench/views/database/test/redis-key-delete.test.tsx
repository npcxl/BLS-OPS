import "@/i18n";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { i18n } from "@/i18n";
import { databaseApi } from "@/api/ops-api";
import type { DatabaseProfile, ProfileRuntimeStatus } from "@/api/types/database";
import { useDatabaseStore } from "@/stores/database-store";
import { RedisBrowser } from "../RedisBrowser";

/**
 * Redis 删除键的回归：
 * - 删除**必须**先过确认弹窗（以前是 window.confirm，浏览器原生弹窗在
 *   Tauri 里样式刺眼、且不跟随应用主题）；
 * - 确认之后才真的调用 `redis_key_delete`，取消则一次都不调；
 * - 删除失败时面板**不能**收起 —— 否则用户以为删掉了，其实数据还在。
 */

(
  globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const PROFILE_ID = "redis-test";
const KEY = "user:1001";

const profile: DatabaseProfile = {
  id: PROFILE_ID,
  name: "缓存",
  engine: "redis",
  host: "127.0.0.1",
  port: 6379,
  username: "",
  default_database: "0",
  has_password: false,
  ssh_server_id: null,
  tls_mode: "disabled",
  tls_ca_path: null,
  tls_server_name: null,
  read_only: false,
  redis_mode: "standalone",
  sentinel_master: null,
  nodes_json: null,
  connect_timeout_ms: 10_000,
  query_timeout_ms: 60_000,
  created_at: 0,
  updated_at: 0,
};

const status: ProfileRuntimeStatus = {
  profile_id: PROFILE_ID,
  generation: 1,
  connected: true,
  tunnel_active: false,
  tunnel_local_port: null,
  open_sessions: 0,
  active_queries: 0,
  server_version: "7.2.4",
};

const t = (key: string, values?: Record<string, unknown>) =>
  i18n.t(key, values) as string;

async function flush() {
  for (let index = 0; index < 12; index += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

function buttonByLabel(label: string): HTMLButtonElement | null {
  return document.body.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
}

function buttonByText(text: string): HTMLButtonElement | null {
  return (
    Array.from(document.body.querySelectorAll("button")).find(
      (button) => button.textContent?.trim() === text,
    ) ?? null
  );
}

describe("Redis 键浏览器 · 删除键", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    localStorage.clear();
    useDatabaseStore.setState({
      profiles: [profile],
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
      statuses: { [PROFILE_ID]: status },
      redisConnecting: {},
      openTableRequest: null,
    });

    vi.spyOn(databaseApi, "redisScan").mockResolvedValue({
      cursor: 0,
      keys: [{ key: KEY, kind: "string", ttl_ms: -1 }],
      dbsize: 1,
    });
    vi.spyOn(databaseApi, "redisKeyInfo").mockResolvedValue({
      key: KEY,
      kind: "string",
      ttl_ms: -1,
      memory_bytes: 12,
    });
    vi.spyOn(databaseApi, "redisReadValue").mockResolvedValue({
      kind: "string",
      value: "hello",
      binary: false,
      bytes: 5,
      truncated: false,
    });

    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    document.body.innerHTML = "";
    vi.restoreAllMocks();
  });

  const openKey = async () => {
    act(() => root.render(<RedisBrowser profile={profile} />));
    await flush();

    const row = Array.from(container.querySelectorAll("button")).find((button) =>
      button.textContent?.includes(KEY),
    );
    expect(row).toBeDefined();
    await act(async () => {
      row?.click();
    });
    await flush();
    await act(async () => {
      await new Promise((resolve) => window.requestAnimationFrame(() => resolve(null)));
    });
  };

  it("点删除先弹确认框，确认前不调用后端", async () => {
    const remove = vi.spyOn(databaseApi, "redisKeyDelete").mockResolvedValue(undefined);
    await openKey();

    const deleteButton = buttonByLabel(t("删除键"));
    expect(deleteButton).not.toBeNull();

    await act(async () => {
      deleteButton?.click();
    });

    // 确认弹窗出现，且后端一次都没被调用。
    const dialog = document.body.querySelector('[role="dialog"]');
    expect(dialog).not.toBeNull();
    expect(dialog?.textContent).toContain(KEY);
    expect(remove).not.toHaveBeenCalled();

    act(() => buttonByText(t("删除"))?.click());
    await flush();

    expect(remove).toHaveBeenCalledTimes(1);
    expect(remove).toHaveBeenCalledWith(PROFILE_ID, 0, KEY);
  });

  it("取消就什么都不做", async () => {
    const remove = vi.spyOn(databaseApi, "redisKeyDelete").mockResolvedValue(undefined);
    await openKey();

    act(() => buttonByLabel(t("删除键"))?.click());
    act(() => buttonByText(t("Cancel"))?.click());
    await flush();

    expect(remove).not.toHaveBeenCalled();
  });

  it("删除失败时面板保持打开，错误就地显示", async () => {
    vi.spyOn(databaseApi, "redisKeyDelete").mockRejectedValue({
      stage: "permission",
      message: "NOPERM this user has no permissions to run the 'del' command",
      detail: null,
      retryable: false,
    });
    await openKey();

    act(() => buttonByLabel(t("删除键"))?.click());
    act(() => buttonByText(t("删除"))?.click());
    await flush();

    const dialog = document.body.querySelector('[role="dialog"]');
    expect(dialog?.textContent).toContain("NOPERM");
    // 键还在：面板没有切走。
    expect(container.textContent).toContain(KEY);
  });

  it("新建键走标准表单：空键名不提交，提交后关闭", async () => {
    const create = vi
      .spyOn(databaseApi, "redisCreateString")
      .mockResolvedValue(undefined);
    await openKey();

    act(() => buttonByLabel(t("新建 string 键"))?.click());
    await act(async () => {
      await new Promise((resolve) => window.requestAnimationFrame(() => resolve(null)));
    });

    const dialog = document.body.querySelector('[role="dialog"]');
    expect(dialog).not.toBeNull();

    // 空键名：显示字段级错误，不调用后端。
    act(() => buttonByText(t("创建"))?.click());
    await flush();
    expect(create).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain(t("键名不能为空"));

    const input = dialog?.querySelector<HTMLInputElement>("input")!;
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      setter?.call(input, "new:key");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    act(() => buttonByText(t("创建"))?.click());
    await flush();

    expect(create).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledWith(PROFILE_ID, 0, "new:key", "");
  });
});
