import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { i18n } from "@/i18n";
import { opsApi } from "@/api/ops-api";
import {
  DEFAULT_EXTREME_SETTINGS,
  useExtremeSettingsStore,
} from "@/stores/extreme-settings-store";
import { useExtremeStore } from "@/stores/extreme-store";
import { ExtremeSettingsPage } from "../view/ExtremeSettingsPage";

describe("超能设置页", () => {
  beforeAll(async () => {
    await i18n.changeLanguage("zh-CN");
  });

  afterEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
    useExtremeSettingsStore.setState({ ...DEFAULT_EXTREME_SETTINGS });
    useExtremeStore.getState().exit();
    document.body.innerHTML = "";
  });

  it("改默认上下文即时保存，并同步到跟随默认的当前会话", async () => {
    useExtremeStore.getState().enter("srv-settings", "生产", "ssh-settings", "root@10.0.0.1");
    useExtremeStore.getState().ensureWorkspace();
    vi.spyOn(opsApi, "aiProviderList").mockResolvedValue([
      {
        id: "p1",
        name: "DeepSeek",
        provider_kind: "openai_compatible",
        base_url: "https://api.deepseek.com",
        model: "deepseek-chat",
        has_api_key: true,
        enabled: true,
        is_default: true,
        allow_insecure_http: false,
        timeout_seconds: 60,
        max_output_tokens: 8192,
        context_window: 128000,
        context_budgets: [64000, 128000],
        reasoning_efforts: ["low", "high"],
        capability_known: true,
        capability_overridden: false,
        created_at: 1,
        updated_at: 1,
      },
    ]);

    const holder = document.body.appendChild(document.createElement("div"));
    const root = createRoot(holder);
    await act(async () => {
      root.render(
        <ExtremeSettingsPage
          onBack={() => undefined}
          onManagePermissions={() => undefined}
          onManageMcp={() => undefined}
        />,
      );
    });

    try {
      expect(holder.textContent).toContain("模型与供应商");
      expect(holder.textContent).toContain("对话与上下文");
      expect(holder.textContent).toContain("执行与计划");
      expect(holder.textContent).toContain("通知");
      expect(holder.textContent).toContain("界面与动效");

      const trigger = holder.querySelector<HTMLButtonElement>(
        '[data-testid="default-context"]',
      )!;
      await act(async () => trigger.click());
      const option = Array.from(
        document.querySelectorAll<HTMLButtonElement>('[role="option"]'),
      ).find((node) => node.textContent?.includes("仅本条"))!;
      await act(async () => option.click());
      expect(useExtremeSettingsStore.getState().defaultContext).toBe("only");
      expect(useExtremeStore.getState().chatPrefs.context).toBe("only");

      const notify = holder.querySelector<HTMLButtonElement>(
        '[role="switch"][aria-label="后台通知"]',
      )!;
      await act(async () => notify.click());
      expect(useExtremeSettingsStore.getState().notifications.enabled).toBe(false);
    } finally {
      await act(async () => root.unmount());
      holder.remove();
    }
  });
});
