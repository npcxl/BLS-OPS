import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import "@/i18n";
import type { ExtremeMessage } from "@/stores/extreme-store";
import { MessageTimeline } from "../MessageTimeline";

(
  globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const MESSAGES: ExtremeMessage[] = [
  { id: "u-1", role: "user", text: "检查 nginx 状态" },
  { id: "a-1", role: "assistant", text: "运行正常" },
  { id: "u-2", role: "user", text: "查看磁盘占用" },
  { id: "a-2", role: "assistant", text: "使用率 42%" },
];

describe("MessageTimeline proximity reveal", () => {
  let holder: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    holder = document.createElement("div");
    document.body.appendChild(holder);
    root = createRoot(holder);
  });

  afterEach(() => {
    act(() => root.unmount());
    holder.remove();
    document.body.innerHTML = "";
  });

  it("默认隐藏，指针靠近时间轴时淡入，离开后隐藏", () => {
    const scrollEl = document.createElement("div");
    const stick = { current: true };
    act(() => {
      root.render(
        <div data-testid="chat-area">
          <MessageTimeline
            messages={MESSAGES}
            asking={false}
            workspaceId="w-1"
            scrollRef={{ current: scrollEl }}
            stick={stick}
          />
        </div>,
      );
    });

    const area = holder.querySelector<HTMLElement>('[data-testid="chat-area"]')!;
    const host = holder.querySelector<HTMLElement>(".extreme-core-timeline")!;
    const dock = holder.querySelector<HTMLElement>(".extreme-core-timeline-dock")!;

    host.getBoundingClientRect = () =>
      ({ left: 0, right: 800, top: 0, bottom: 600, width: 800, height: 600, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
    dock.getBoundingClientRect = () =>
      ({ left: 0, right: 32, top: 0, bottom: 600, width: 32, height: 600, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;

    // 初始不可见。
    expect(dock.getAttribute("data-visible")).toBe("false");

    // 指针在聊天区右侧远离时间轴 → 仍隐藏。
    act(() => {
      area.dispatchEvent(new MouseEvent("pointermove", { clientX: 400, clientY: 200, bubbles: true }));
    });
    expect(dock.getAttribute("data-visible")).toBe("false");

    // 指针靠近时间轴左缘缓冲带 → 淡入显示。
    act(() => {
      area.dispatchEvent(new MouseEvent("pointermove", { clientX: 60, clientY: 200, bubbles: true }));
    });
    expect(dock.getAttribute("data-visible")).toBe("true");

    // 移回远处 → 淡出隐藏。
    act(() => {
      area.dispatchEvent(new MouseEvent("pointermove", { clientX: 300, clientY: 200, bubbles: true }));
    });
    expect(dock.getAttribute("data-visible")).toBe("false");

    // 再次靠近后离开容器 → 隐藏。
    act(() => {
      area.dispatchEvent(new MouseEvent("pointermove", { clientX: 20, clientY: 200, bubbles: true }));
    });
    expect(dock.getAttribute("data-visible")).toBe("true");
    act(() => {
      area.dispatchEvent(new MouseEvent("pointerleave", { bubbles: false }));
    });
    expect(dock.getAttribute("data-visible")).toBe("false");
  });
});
