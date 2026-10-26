/**
 * 连接中的顶部光条。
 *
 * 钉的是"点了有没有反应"这件事：
 * 1. 没有连接时不渲染任何东西（不占位、不闪）；
 * 2. 一 register（**发请求之前**）就出现；
 * 3. 成功 / 失败 / 断开都会消失 —— 否则光条会一直转，比没有还糟。
 */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import "@/i18n";

import { i18n } from "@/i18n";
import { useSessionStore } from "@/stores/session-store";
import { ConnectionProgressBar } from "../ConnectionProgressBar";

let container: HTMLDivElement;
let root: Root;

beforeAll(async () => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  await i18n.changeLanguage("zh-CN");
});

beforeEach(() => {
  useSessionStore.setState({ sessions: {} });
});

afterEach(() => {
  if (root) act(() => root.unmount());
  if (container) container.remove();
});

async function render() {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root.render(<ConnectionProgressBar />);
  });
}

const bar = () => document.querySelector('[data-testid="connection-progress"]');

const register = (sessionId: string) =>
  act(() => {
    useSessionStore.getState().register({
      sessionId,
      tabId: `tab-${sessionId}`,
      title: "web-01",
      serverId: "srv-1",
    });
  });

const setStatus = (sessionId: string, status: "connected" | "error" | "closed") =>
  act(() => {
    useSessionStore.getState().setStatus(sessionId, status);
  });

describe("连接光条", () => {
  it("没有连接时不渲染", async () => {
    await render();
    expect(bar()).toBeNull();
  });

  it("register 之后立刻出现（不等请求返回）", async () => {
    await render();
    await register("s1");
    expect(bar()).not.toBeNull();
    expect(bar()?.getAttribute("aria-label")).toBe(i18n.t("Connecting to server"));
  });

  it("连接成功后消失", async () => {
    await render();
    await register("s1");
    expect(bar()).not.toBeNull();
    await setStatus("s1", "connected");
    expect(bar()).toBeNull();
  });

  it("失败或断开也会消失", async () => {
    await render();
    await register("s1");
    await setStatus("s1", "error");
    expect(bar()).toBeNull();

    await register("s2");
    expect(bar()).not.toBeNull();
    await setStatus("s2", "closed");
    expect(bar()).toBeNull();
  });

  it("多台服务器同时连时只显示一条，全部结束才消失", async () => {
    await render();
    await register("s1");
    await register("s2");
    expect(document.querySelectorAll('[data-testid="connection-progress"]')).toHaveLength(1);

    await setStatus("s1", "connected");
    expect(bar()).not.toBeNull(); // 还有一台在连

    await setStatus("s2", "connected");
    expect(bar()).toBeNull();
  });
});
