import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  effectivePermission,
  useExtremePermissionsStore,
} from "@/stores/extreme-permissions-store";
import { DEFAULT_BACKUP_POLICY } from "@/workbench/views/terminal/extreme-core/permissions";

const STORAGE_KEY = "bls-ops.extreme-permissions.v1";

describe("超能权限设置", () => {
  beforeEach(() => {
    localStorage.clear();
    useExtremePermissionsStore.setState({
      defaultMode: "ask",
      byWorkspace: {},
      backup: { ...DEFAULT_BACKUP_POLICY },
      allowSudo: true,
    });
  });

  it("当前任务覆盖优先，重置后回到默认值", () => {
    const store = useExtremePermissionsStore.getState();
    store.setDefaultMode("ask");
    store.setWorkspaceMode("w1", "readonly");
    let state = useExtremePermissionsStore.getState();
    expect(effectivePermission(state, "w1")).toBe("readonly");
    expect(effectivePermission(state, "w2")).toBe("ask");

    state.resetWorkspaceMode("w1");
    state = useExtremePermissionsStore.getState();
    expect(effectivePermission(state, "w1")).toBe("ask");
  });

  it("默认值、提权与备份策略写进 localStorage", () => {
    const store = useExtremePermissionsStore.getState();
    store.setDefaultMode("full");
    store.setAllowSudo(false);
    store.setBackup({ beforeDelete: false, retentionDays: 7 });
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}");
    expect(saved.version).toBe(2);
    expect(saved.defaultMode).toBe("full");
    expect(saved.allowSudo).toBe(false);
    expect(saved.backup.beforeDelete).toBe(false);
    expect(saved.backup.beforeWrite).toBe(true);
    expect(saved.backup.retentionDays).toBe(7);
  });

  it("无覆盖的任务跟随默认值", () => {
    expect(
      effectivePermission({ defaultMode: "full", byWorkspace: {} }, null),
    ).toBe("full");
  });

  it("旧版 readonly 按实际含义迁移为按需确认", async () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        defaultMode: "readonly",
        byWorkspace: { w1: "readonly" },
        backup: { ...DEFAULT_BACKUP_POLICY },
      }),
    );
    vi.resetModules();
    const mod = await import("@/stores/extreme-permissions-store");
    const state = mod.useExtremePermissionsStore.getState();
    expect(state.version).toBe(2);
    expect(state.defaultMode).toBe("ask");
    expect(state.byWorkspace.w1).toBe("ask");
    expect(state.allowSudo).toBe(true);
  });
});
