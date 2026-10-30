import "@/i18n";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { databaseApi } from "@/api/ops-api";
import type { DatabaseProfile, RedisKeyBrief } from "@/api/types/database";
import { useDatabaseStore } from "@/stores/database-store";
import { copyText } from "@/lib/clipboard";
import { RedisBrowser } from "../RedisBrowser";

/**
 * 网格交互：单击选中、Ctrl/Shift 多选、Ctrl+A 全选、Ctrl+C / Ctrl+Shift+C 复制。
 *
 * 这些是"专业客户端"的基本盘：用户扫到一万个键之后，能多选、能复制成 TSV，
 * 才是真的能干活。
 */

vi.mock("@/lib/clipboard", () => ({ copyText: vi.fn().mockResolvedValue(true) }));

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const PROFILE: DatabaseProfile = {
  id: "redis-grid",
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

const KEYS: RedisKeyBrief[] = [
  { key: "user:1", kind: "string", ttl_ms: -1 },
  { key: "user:2", kind: "hash", ttl_ms: 60_000 },
  { key: "session:9", kind: "set", ttl_ms: -1 },
];

async function flush() {
  for (let index = 0; index < 8; index += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

describe("Redis 键网格", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    localStorage.clear();
    useDatabaseStore.setState({
      profiles: [PROFILE],
      statuses: {
        [PROFILE.id]: {
          profile_id: PROFILE.id,
          generation: 1,
          connected: true,
          tunnel_active: false,
          tunnel_local_port: null,
          open_sessions: 0,
          active_queries: 0,
          server_version: "7.4.0",
        },
      },
      sessions: {},
      sessionErrors: {},
      redisConnecting: {},
    });
    vi.spyOn(databaseApi, "redisScan").mockResolvedValue({
      cursor: 0,
      keys: KEYS,
      dbsize: 3,
    });
    // 单击即加载详情（参考图行为）：这两个调用必须被 mock，否则会打真实 IPC。
    vi.spyOn(databaseApi, "redisKeyInfo").mockResolvedValue({
      key: "user:1",
      kind: "string",
      ttl_ms: -1,
      memory_bytes: 64,
    });
    vi.spyOn(databaseApi, "redisReadValue").mockResolvedValue({
      kind: "string",
      value: "v",
      binary: false,
      bytes: 1,
      truncated: false,
    });
    vi.spyOn(databaseApi, "profileStatus").mockResolvedValue({
      profile_id: PROFILE.id,
      generation: 1,
      connected: true,
      tunnel_active: false,
      tunnel_local_port: null,
      open_sessions: 0,
      active_queries: 0,
      server_version: "7.4.0",
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

  const rows = () => Array.from(container.querySelectorAll('[role="row"]'));

  /** 默认是树视图（参考图）；这里切到列表，按平铺行做断言。 */
  const renderList = async () => {
    act(() => root.render(<RedisBrowser profile={PROFILE} />));
    await flush();
    const listButton = container.querySelector<HTMLButtonElement>(
      'button[aria-label="列表视图"]',
    );
    expect(listButton).not.toBeNull();
    await act(async () => {
      listButton?.click();
    });
    await flush();
  };

  it("渲染 Key / 类型 / TTL 三列并支持 Ctrl 多选", async () => {
    await renderList();

    const all = rows();
    expect(all.length).toBe(3);
    expect(all[0].textContent).toContain("user:1");
    expect(all[0].textContent).toContain("string");
    // 永久键显示 ∞，带 TTL 的显示 1m。
    expect(all[0].textContent).toContain("∞");
    expect(all[1].textContent).toContain("1m");

    act(() => {
      all[0].dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    act(() => {
      all[1].dispatchEvent(new MouseEvent("click", { bubbles: true, ctrlKey: true }));
    });

    const selected = rows().filter((row) => row.getAttribute("aria-selected") === "true");
    expect(selected.length).toBe(2);
  });

  it("Ctrl+A 全选、Ctrl+C 复制键名、Ctrl+Shift+C 复制 TSV", async () => {
    await renderList();

    const grid = container.querySelector('[role="grid"]');
    expect(grid).not.toBeNull();

    await act(async () => {
      grid?.dispatchEvent(new KeyboardEvent("keydown", { key: "a", ctrlKey: true, bubbles: true }));
    });
    expect(
      rows().filter((row) => row.getAttribute("aria-selected") === "true").length,
    ).toBe(3);

    await act(async () => {
      grid?.dispatchEvent(new KeyboardEvent("keydown", { key: "c", ctrlKey: true, bubbles: true }));
    });
    expect(vi.mocked(copyText).mock.calls[0]?.[0]).toBe("user:1\nuser:2\nsession:9");

    await act(async () => {
      grid?.dispatchEvent(
        new KeyboardEvent("keydown", { key: "c", ctrlKey: true, shiftKey: true, bubbles: true }),
      );
    });
    const tsv = vi.mocked(copyText).mock.calls[1]?.[0] ?? "";
    expect(tsv.split("\n")[0]).toBe("Key\tType\tTTL");
    expect(tsv).toContain("user:2\thash\t1m");
  });
});
