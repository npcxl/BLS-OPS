import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { persistExtremeState, useExtremeStore } from "@/stores/extreme-store";
import { MessageList } from "../MessageList";
import { readWorkspaces } from "../workspace-history";

it("keeps each task conversation and its folders separate and saves the transcript", () => {
  const store = useExtremeStore;
  store.getState().enter("test-host-id", "test host", "workspace-session", "192.0.2.1");
  // 进入是欢迎态（懒创建）：这个用例关心任务归属，需要一条对话。
  store.getState().ensureWorkspace();
  const first = store.getState().workspaceId!;
  store.getState().pushMessage({ id: "one", role: "user", text: "Find the service" });

  store.getState().addWorkspace(["C:/first", "C:/second"]);
  const second = store.getState().workspaceId!;
  expect(store.getState().messages).toEqual([]);
  store.getState().pushMessage({ id: "two", role: "user", text: "Check the release" });

  store.getState().openWorkspace(first);
  expect(store.getState().messages.map((message) => message.id)).toEqual(["one"]);
  window.dispatchEvent(new Event("pagehide"));
  expect(readWorkspaces().find((entry) => entry.id === second)).toMatchObject({
    folders: ["C:/first", "C:/second"],
    messages: [{ id: "two", role: "user", text: "Check the release" }],
  });
});

it("keeps the sidebar workspace entry in sync with current messages", () => {
  const store = useExtremeStore;
  store.getState().enter("sync-host-id", "sync host", "sync-session", "192.0.2.9");
  store.getState().ensureWorkspace();
  const id = store.getState().workspaceId!;

  store.getState().pushMessage({ id: "sync-one", role: "user", text: "第一句" });
  const pushed = store.getState().workspaces.find((entry) => entry.id === id)!;
  expect(pushed.messages.map((message) => message.id)).toEqual(["sync-one"]);

  store.getState().patchMessage("sync-one", { text: "改过的第一句" });
  const patched = store.getState().workspaces.find((entry) => entry.id === id)!;
  expect(patched.messages[0]?.text).toBe("改过的第一句");
  expect(patched.updatedAt).toBeGreaterThanOrEqual(pushed.updatedAt);
});

it("re-opening the current conversation does not reload the mirror", () => {
  const store = useExtremeStore;
  store.getState().enter("same-host-id", "same host", "same-session", "192.0.2.10");
  store.getState().ensureWorkspace();
  const id = store.getState().workspaceId!;
  store.getState().pushMessage({ id: "same-one", role: "user", text: "别动我" });
  const messages = store.getState().messages;

  store.getState().openWorkspace(id);
  // 引用相等：没有重新装载，滚动位置与输入状态都不会被重置。
  expect(store.getState().messages).toBe(messages);
});

it("surfaces localStorage failures instead of swallowing them", () => {
  // jsdom 的 localStorage 方法挂在实例上，只在 prototype 上 mock 拦不住。
  const spy = vi.spyOn(window.localStorage, "setItem").mockImplementation(() => {
    throw new Error("quota exceeded");
  });
  try {
    persistExtremeState();
    expect(useExtremeStore.getState().historyError).toContain("本地历史保存失败");
  } finally {
    spy.mockRestore();
  }
  persistExtremeState();
  expect(useExtremeStore.getState().historyError).toBeNull();
});

it("routes rendered service URLs and directory paths to the workspace panel", async () => {
  const holder = document.body.appendChild(document.createElement("div"));
  const root = createRoot(holder);
  const onOpen = vi.fn();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  try {
    await act(async () => root.render(
      <MessageList
        sessionId="workspace-session"
        asking={false}
        messages={[{
          id: "paths",
          role: "assistant",
          text: [
            "## Service details",
            "[Service](https://example.com/) is served from `/opt/ops/dist`.",
            "```sh\ncurl -I https://example.com/\n```",
            "| Probe | Result |\n| --- | --- |\n| HTTP | 200 |",
          ].join("\n\n"),
        }]}
        onOpenWorkspaceTarget={onOpen}
      />,
    ));
    const links = holder.querySelectorAll("a");
    expect(holder.querySelector("h2")?.textContent).toBe("Service details");
    expect(holder.querySelector(".extreme-core-reply-code pre")?.textContent?.trim()).toBe("curl -I https://example.com/");
    expect(holder.querySelector(".extreme-core-reply-code button")?.getAttribute("aria-label")).toBeTruthy();
    expect(holder.querySelector(".extreme-core-reply-table table td:last-child")?.textContent).toBe("200");
    expect([...links].map((link) => link.textContent)).toEqual(["Service", "/opt/ops/dist"]);
    links[0].click();
    links[1].click();
    expect(onOpen.mock.calls).toEqual([
      [{ kind: "website", url: "https://example.com/" }],
      [{ kind: "directory", path: "/opt/ops/dist", sessionId: "workspace-session" }],
    ]);
  } finally {
    await act(async () => root.unmount());
    holder.remove();
    vi.unstubAllGlobals();
  }
});
