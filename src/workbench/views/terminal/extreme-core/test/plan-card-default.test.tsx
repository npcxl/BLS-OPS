import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { i18n } from "@/i18n";
import type { AgentPlan } from "@/api/types/agent";
import { PlanCard } from "../PlanCard";
import {
  DEFAULT_EXTREME_SETTINGS,
  useExtremeSettingsStore,
} from "@/stores/extreme-settings-store";

function plan(): AgentPlan {
  return {
    understanding: "检查 Nginx",
    summary: "先探查",
    prerequisites: [],
    revision: 1,
    createdAt: 1,
    updatedAt: 1,
    steps: [
      {
        id: "s1",
        title: "检查配置",
        action: "读取 nginx.conf",
        verify: "能看到 server 段",
        state: "running",
      },
    ],
  };
}

describe("计划卡默认显隐", () => {
  beforeAll(async () => {
    await i18n.changeLanguage("zh-CN");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    useExtremeSettingsStore.setState({ ...DEFAULT_EXTREME_SETTINGS });
    document.body.innerHTML = "";
  });

  it("设置为默认收起时首帧就是「计划」按钮", async () => {
    useExtremeSettingsStore.getState().update({ planCard: "collapsed" });
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    class ResizeObserverStub {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
    vi.stubGlobal("ResizeObserver", ResizeObserverStub);
    Object.defineProperty(window, "innerWidth", { value: 1400, configurable: true });
    vi.stubGlobal("matchMedia", () => ({
      matches: false,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    }));

    const holder = document.body.appendChild(document.createElement("div"));
    const root = createRoot(holder);
    await act(async () => {
      root.render(
        <PlanCard
          taskId="task-default-collapsed"
          plan={plan()}
          onFocusStep={() => undefined}
        />,
      );
    });
    try {
      expect(holder.textContent).not.toContain("执行计划");
      expect(holder.textContent).toContain("计划");
      const toggle = Array.from(holder.querySelectorAll("button")).find((button) =>
        button.textContent?.includes("计划"),
      )!;
      await act(async () => toggle.click());
      expect(holder.textContent).toContain("执行计划");
    } finally {
      await act(async () => root.unmount());
      holder.remove();
    }
  });
});
