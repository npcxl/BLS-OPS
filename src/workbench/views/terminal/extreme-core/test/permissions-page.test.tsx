import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { i18n } from "@/i18n";
import { opsApi } from "@/api/ops-api";
import { useExtremePermissionsStore } from "@/stores/extreme-permissions-store";
import { DEFAULT_BACKUP_POLICY } from "../permissions";
import { ExtremePermissionsPage } from "../view/ExtremePermissionsPage";

describe("权限页", () => {
  beforeAll(async () => {
    await i18n.changeLanguage("zh-CN");
  });

  afterEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
    useExtremePermissionsStore.setState({
      defaultMode: "ask",
      byWorkspace: {},
      backup: { ...DEFAULT_BACKUP_POLICY },
      allowSudo: true,
    });
    document.body.innerHTML = "";
  });

  it("当前任务覆盖、跟随默认、提权与备份开关都落到 store", async () => {
    vi.spyOn(opsApi, "mcpServerList").mockResolvedValue([]);
    vi.spyOn(opsApi, "aiAgentFileChanges").mockResolvedValue([]);
    vi.spyOn(opsApi, "extremeTaskList").mockResolvedValue([]);
    useExtremePermissionsStore.setState({
      defaultMode: "ask",
      byWorkspace: {},
      backup: { ...DEFAULT_BACKUP_POLICY },
      allowSudo: true,
    });
    const holder = document.body.appendChild(document.createElement("div"));
    const root = createRoot(holder);
    await act(async () => {
      root.render(
        <ExtremePermissionsPage
          workspaceId="w1"
          workspaceTitle="任务一"
          serverId="s1"
          onBack={() => undefined}
          onManageMcp={() => undefined}
          onRestoreBackup={() => undefined}
        />,
      );
    });

    try {
      const radios = Array.from(holder.querySelectorAll<HTMLButtonElement>('[role="radio"]'));
      // 前三个是默认值，后三个是当前任务覆盖。
      expect(radios.length).toBe(6);
      await act(async () => radios[3].click());
      expect(useExtremePermissionsStore.getState().byWorkspace.w1).toBe("readonly");

      const follow = Array.from(holder.querySelectorAll("button")).find((button) =>
        button.textContent?.includes("跟随默认"),
      );
      expect(follow).toBeTruthy();
      await act(async () => follow!.click());
      expect(useExtremePermissionsStore.getState().byWorkspace.w1).toBeUndefined();

      const toggle = holder.querySelector<HTMLButtonElement>(
        '[role="switch"][aria-label="删除前备份"]',
      )!;
      await act(async () => toggle.click());
      expect(useExtremePermissionsStore.getState().backup.beforeDelete).toBe(false);
      expect(toggle.getAttribute("aria-checked")).toBe("false");

      const sudo = holder.querySelector<HTMLButtonElement>(
        '[role="switch"][aria-label="允许提权"]',
      )!;
      await act(async () => sudo.click());
      expect(useExtremePermissionsStore.getState().allowSudo).toBe(false);
    } finally {
      await act(async () => root.unmount());
      holder.remove();
    }
  });
});
