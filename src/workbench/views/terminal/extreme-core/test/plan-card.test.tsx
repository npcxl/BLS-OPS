import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { i18n } from "@/i18n";
import type { AgentPlan } from "@/api/types/agent";
import { PlanCard } from "../PlanCard";

function planOf(revision: number, first: "pending" | "done" = "pending"): AgentPlan {
  return {
    understanding: "检查并更新 Nginx",
    summary: "先探查再部署",
    prerequisites: ["确认是生产环境"],
    revision,
    createdAt: 1,
    updatedAt: revision,
    steps: [
      {
        id: "s1",
        title: "检查 Nginx 配置",
        action: "读取 nginx.conf",
        verify: "确认站点目录",
        kind: "probe",
        state: first,
      },
      {
        id: "s2",
        title: "更新配置",
        action: "写入新的 server 块",
        verify: "nginx -t 通过",
        kind: "action",
        state: "pending",
      },
    ],
  };
}

it("首次轻量展开；手动收起后计划更新不重新弹开；点步骤可定位", async () => {
  const language = i18n.language;
  await i18n.changeLanguage("zh-CN");
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  class ResizeObserverStub {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  vi.stubGlobal("ResizeObserver", ResizeObserverStub);
  Object.defineProperty(window, "innerWidth", { value: 1440, configurable: true });
  vi.stubGlobal("matchMedia", () => ({
    matches: false,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  }));
  const holder = document.body.appendChild(document.createElement("div"));
  const root = createRoot(holder);
  const onFocus = vi.fn();
  try {
    await act(async () => {
      root.render(<PlanCard taskId="task-1" plan={planOf(1)} onFocusStep={onFocus} />);
    });
    expect(holder.textContent).toContain("执行计划");
    expect(holder.textContent).toContain("0/2");
    expect(holder.textContent).toContain("更新配置");

    const collapse = Array.from(holder.querySelectorAll("button")).find(
      (button) => button.getAttribute("aria-label") === "收起计划",
    );
    expect(collapse).toBeTruthy();
    await act(async () => collapse!.click());
    expect(holder.textContent).not.toContain("执行计划");
    expect(holder.textContent).toContain("计划");

    // 步骤更新（计划修订）：保持收起，不抢焦点。
    await act(async () => {
      root.render(<PlanCard taskId="task-1" plan={planOf(2, "done")} onFocusStep={onFocus} />);
    });
    expect(holder.textContent).not.toContain("执行计划");

    const toggle = Array.from(holder.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("计划"),
    );
    expect(toggle).toBeTruthy();
    await act(async () => toggle!.click());
    expect(holder.textContent).toContain("执行计划");

    const step = Array.from(holder.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("更新配置"),
    );
    expect(step).toBeTruthy();
    await act(async () => step!.click());
    expect(onFocus).toHaveBeenCalledWith("s2");
  } finally {
    await act(async () => root.unmount());
    holder.remove();
    vi.unstubAllGlobals();
    await i18n.changeLanguage(language);
  }
});

it("窄窗口默认收成「计划」按钮，展开后列表在卡片内滚动", async () => {
  const language = i18n.language;
  await i18n.changeLanguage("zh-CN");
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  class ResizeObserverStub {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  vi.stubGlobal("ResizeObserver", ResizeObserverStub);
  Object.defineProperty(window, "innerWidth", { value: 900, configurable: true });
  vi.stubGlobal("matchMedia", () => ({
    matches: true,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  }));
  const holder = document.body.appendChild(document.createElement("div"));
  const root = createRoot(holder);
  const onFocus = vi.fn();
  try {
    await act(async () => {
      root.render(<PlanCard taskId="task-narrow" plan={planOf(1)} onFocusStep={onFocus} />);
    });
    expect(holder.textContent).not.toContain("执行计划");
    expect(holder.textContent).toContain("计划");

    const toggle = Array.from(holder.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("计划"),
    );
    await act(async () => toggle!.click());
    expect(holder.textContent).toContain("执行计划");
    expect(holder.querySelector(".extreme-core-plan-scroll")).toBeTruthy();
  } finally {
    await act(async () => root.unmount());
    holder.remove();
    vi.unstubAllGlobals();
    await i18n.changeLanguage(language);
  }
});
