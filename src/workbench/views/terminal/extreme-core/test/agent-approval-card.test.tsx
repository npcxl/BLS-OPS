import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { i18n } from "@/i18n";
import type { AgentApproval } from "@/api/types/agent";
import { AgentApprovalCard } from "../AgentApprovalCard";

/**
 * P1 回归：确认卡必须显示**以后端 deadline 为准**的倒计时。
 *
 * 重进恢复的确认卡可能只剩几秒 —— 本地起算 5 分钟会骗用户；
 * 旧快照没有 deadline 时按收到时刻兜底，绝不显示 NaN。
 */
function approval(overrides: Partial<AgentApproval> = {}): AgentApproval {
  return {
    taskId: "task-1",
    callId: "call-0-0",
    stepIndex: 0,
    tool: "run_shell",
    server: "prod",
    risk: "write",
    command: "systemctl restart nginx",
    cwd: "/root",
    ...overrides,
  };
}

async function renderCard(node: React.ReactElement) {
  const holder = document.body.appendChild(document.createElement("div"));
  const root = createRoot(holder);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  await act(async () => root.render(node));
  return {
    holder,
    cleanup: async () => {
      await act(async () => root.unmount());
      holder.remove();
      vi.unstubAllGlobals();
    },
  };
}

it("shows the backend deadline as a countdown, not a fresh 5 minutes", async () => {
  const language = i18n.language;
  await i18n.changeLanguage("zh-CN");
  const { holder, cleanup } = await renderCard(
    <AgentApprovalCard
      approval={approval({ deadline: Date.now() + 90_000 })}
      phase="pending"
      onDecide={() => undefined}
    />,
  );
  try {
    const text = holder.querySelector("[data-testid='agent-approval']")?.textContent ?? "";
    // 90s → 1:30（渲染耗时允许掉到 1:29）。
    expect(text).toMatch(/剩余 1:(29|30)/);
    expect(text).not.toContain("5:00");
    expect(text).not.toContain("NaN");
  } finally {
    await cleanup();
    await i18n.changeLanguage(language);
  }
});

it("falls back to ~5 minutes when an old snapshot has no deadline", async () => {
  const language = i18n.language;
  await i18n.changeLanguage("zh-CN");
  const { holder, cleanup } = await renderCard(
    <AgentApprovalCard approval={approval()} phase="pending" onDecide={() => undefined} />,
  );
  try {
    const text = holder.querySelector("[data-testid='agent-approval']")?.textContent ?? "";
    expect(text).toMatch(/剩余 (4:5\d|5:00)/);
    expect(text).not.toContain("NaN");
  } finally {
    await cleanup();
    await i18n.changeLanguage(language);
  }
});

it("turns the countdown red in the last minute", async () => {
  const language = i18n.language;
  await i18n.changeLanguage("zh-CN");
  const { holder, cleanup } = await renderCard(
    <AgentApprovalCard
      approval={approval({ deadline: Date.now() + 30_000 })}
      phase="pending"
      onDecide={() => undefined}
    />,
  );
  try {
    const countdown = [...holder.querySelectorAll("span")].find((span) =>
      /剩余 0:(29|30)/.test(span.textContent ?? ""),
    );
    expect(countdown?.className).toContain("text-danger");
  } finally {
    await cleanup();
    await i18n.changeLanguage(language);
  }
});

it("hides the countdown once the user has decided", async () => {
  const language = i18n.language;
  await i18n.changeLanguage("zh-CN");
  const { holder, cleanup } = await renderCard(
    <AgentApprovalCard
      approval={approval({ deadline: Date.now() + 90_000 })}
      phase="allowed"
      onDecide={() => undefined}
    />,
  );
  try {
    const text = holder.querySelector("[data-testid='agent-approval']")?.textContent ?? "";
    expect(text).not.toContain("剩余");
  } finally {
    await cleanup();
    await i18n.changeLanguage(language);
  }
});
