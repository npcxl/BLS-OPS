import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { i18n } from "@/i18n";
import { queuedSend } from "../send-queue";
import { SendQueuePanel } from "../SendQueuePanel";

describe("SendQueuePanel（Codex / Antigravity 队列托盘）", () => {
  beforeAll(async () => {
    await i18n.changeLanguage("zh-CN");
  });

  afterEach(() => {
    vi.restoreAllMocks();
    document.body.innerHTML = "";
  });

  it("运行中支持对纯文本排队项一键「立即补充」，带附件项显示附件数且不误插队", async () => {
    const onSteerNow = vi.fn();
    const onMoveUp = vi.fn();
    const onEdit = vi.fn();
    const onDrop = vi.fn();
    const onRetry = vi.fn();
    const first = queuedSend({
      id: "q1",
      workspaceId: "ws-1",
      text: "顺便检查 Nginx 监听端口",
      attachments: [],
      selection: { providerId: "p1", model: "m", effort: "auto", contextBudget: null },
      context: "session",
      output: "auto",
      picked: [],
    });
    const withAttachment = queuedSend({
      id: "q2",
      workspaceId: "ws-1",
      text: "帮我看看这份配置",
      attachments: [{ id: "a1", name: "nginx.conf", size: 120 }],
      selection: { providerId: "p1", model: "m", effort: "auto", contextBudget: null },
      context: "session",
      output: "auto",
      picked: [],
    });
    const holder = document.body.appendChild(document.createElement("div"));
    const root = createRoot(holder);
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    try {
      await act(async () =>
        root.render(
          <SendQueuePanel
            items={[first, withAttachment]}
            running
            waitingLabel="导出线上配置与状态"
            onMoveUp={onMoveUp}
            onEdit={onEdit}
            onDrop={onDrop}
            onRetry={onRetry}
            onSteerNow={onSteerNow}
          />,
        ),
      );
      expect(holder.textContent).toContain("排队消息");
      expect(holder.textContent).toContain("等待当前任务：导出线上配置与状态");
      const steerButtons = holder.querySelectorAll<HTMLButtonElement>(
        'button[aria-label="立即补充给当前任务"]',
      );
      expect(steerButtons).toHaveLength(1);
      expect(holder.textContent).toContain("1 个附件");

      await act(async () => steerButtons[0].click());
      expect(onSteerNow).toHaveBeenCalledTimes(1);
      expect(onSteerNow).toHaveBeenCalledWith(first);

      // 标题栏折叠按钮可以收起 / 展开消息列表。
      const headerToggle = holder.querySelector<HTMLButtonElement>('button[aria-expanded]')!;
      expect(headerToggle.getAttribute("aria-expanded")).toBe("true");
      await act(async () => headerToggle.click());
      expect(headerToggle.getAttribute("aria-expanded")).toBe("false");
      expect(holder.querySelectorAll("[data-queue-id]")).toHaveLength(0);
    } finally {
      await act(async () => root.unmount());
      holder.remove();
      vi.unstubAllGlobals();
    }
  });
});
