import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { opsApi } from "@/api/ops-api";
import { persistExtremeState, useExtremeStore } from "@/stores/extreme-store";
import { MessageList } from "../MessageList";
import { TaskSidebar } from "../TaskSidebar";
import { LogsPane } from "../LogsPane";
import { useLogStreamStore } from "../log-stream-store";
import { useChatScroll } from "../use-chat-scroll";
import { readWorkspaces } from "../workspace-history";

it("can switch log sources without leaving the logs tab", async () => {
  const holder = document.body.appendChild(document.createElement("div"));
  const root = createRoot(holder);
  const previous = useLogStreamStore.getState();
  const start = vi.spyOn(opsApi, "extremeLogStart").mockResolvedValue(undefined);
  const stop = vi.spyOn(opsApi, "extremeLogStop").mockResolvedValue(undefined);
  const services = vi.spyOn(opsApi, "serviceList").mockResolvedValue([{
    unit: "nginx.service", load: "loaded", active: "active", sub: "running",
    description: "Nginx", enabled: true, enabled_state: "enabled",
  }]);
  const docker = vi.spyOn(opsApi, "dockerSnapshot").mockRejectedValue(new Error("Docker unavailable"));
  const onChoose = vi.fn();
  const render = (unit: string) => root.render(<LogsPane
    workspaceId="log-switch-test"
    sessionId="log-session"
    serverId="log-server"
    source={{ kind: "journal", unit, label: unit }}
    onChoose={onChoose}
  />);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  try {
    await act(async () => render("apache.service"));
    const button = (label: string) => [...holder.querySelectorAll("button")]
      .find((item) => item.textContent?.includes(label))!;
    await act(async () => button("Change log source").click());
    await act(async () => button("nginx.service").click());
    expect(onChoose).toHaveBeenCalledWith({ kind: "journal", unit: "nginx.service", label: "nginx.service" });
    await act(async () => render("nginx.service"));
    expect(stop).toHaveBeenCalledWith(start.mock.calls[0][0].streamId);
    expect(start.mock.lastCall?.[0].source.label).toBe("nginx.service");
  } finally {
    await act(async () => root.unmount());
    useLogStreamStore.setState(previous, true);
    holder.remove();
    for (const mock of [start, stop, services, docker]) mock.mockRestore();
    vi.unstubAllGlobals();
  }
});

it("follows output growth until the reader scrolls up, then resumes at the bottom", async () => {
  const holder = document.body.appendChild(document.createElement("div"));
  const root = createRoot(holder);
  let scroll: ReturnType<typeof useChatScroll>;
  function View() {
    scroll = useChatScroll(true);
    return <div ref={scroll.ref}><pre>output</pre></div>;
  }
  const frames: FrameRequestCallback[] = [];
  let height = 300;
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("requestAnimationFrame", (frame: FrameRequestCallback) => frames.push(frame));
  try {
    await act(async () => root.render(<View />));
    const scroller = holder.firstElementChild as HTMLDivElement;
    Object.defineProperties(scroller, {
      scrollHeight: { get: () => height },
      clientHeight: { value: 100 },
    });
    const update = () => {
      scroll.follow();
      frames.shift()?.(0);
    };
    update();
    expect(scroller.scrollTop).toBe(200);
    height = 400;
    scroller.dispatchEvent(new Event("scroll"));
    update();
    expect(scroller.scrollTop).toBe(300);
    scroller.scrollTop = 150;
    scroller.dispatchEvent(new Event("scroll"));
    height = 500;
    update();
    expect(scroller.scrollTop).toBe(150);
    scroller.scrollTop = 400;
    scroller.dispatchEvent(new Event("scroll"));
    height = 600;
    update();
    expect(scroller.scrollTop).toBe(500);
  } finally {
    await act(async () => root.unmount());
    holder.remove();
    vi.unstubAllGlobals();
  }
});

it("shows one status per task in both layouts, prioritizing pending approval", async () => {
  const holder = document.body.appendChild(document.createElement("div"));
  const root = createRoot(holder);
  const railKey = "bls-ops.extreme-task-rail-collapsed.v1";
  const previousRail = localStorage.getItem(railKey);
  localStorage.removeItem(railKey);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const renderSidebar = (attentionById: Record<string, "waiting" | "failed">) => root.render(
    <TaskSidebar
      entries={[{
        id: "first",
        serverId: "server",
        server: "Server",
        host: null,
        serverKey: "server",
        sessionId: "session",
        folders: [],
        messages: [],
        draft: "",
        updatedAt: 0,
      }]}
      currentId="first"
      currentTitle="First task"
      busy={false}
      onNew={vi.fn()}
      onOpen={vi.fn()}
      onRename={vi.fn()}
      onDelete={vi.fn()}
      runningIds={new Set(["first"])}
      attentionById={attentionById}
      unreadIds={new Set(["first"])}
      outputStyle="auto"
      onOutputStyleChange={vi.fn()}
      hasContext={false}
    />,
  );
  const statuses = () => [...holder.querySelectorAll("[data-task-status]")]
    .map((mark) => mark.getAttribute("data-task-status"));
  try {
    await act(async () => renderSidebar({ first: "waiting" }));
    expect(statuses()).toEqual(["waiting"]);
    expect(holder.querySelector('[role="option"]')?.getAttribute("aria-label")).toContain("Pending confirmation");

    const collapse = holder.querySelector<HTMLButtonElement>('[aria-label="Collapse conversation list"]')!;
    await act(async () => collapse.click());
    expect(statuses()).toEqual(["waiting"]);

    await act(async () => renderSidebar({ first: "failed" }));
    expect(statuses()).toEqual(["running"]);
  } finally {
    await act(async () => root.unmount());
    holder.remove();
    if (previousRail === null) localStorage.removeItem(railKey);
    else localStorage.setItem(railKey, previousRail);
    vi.unstubAllGlobals();
  }
});

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

it("opens sites and verified remote paths and leaves missing backups as plain text", async () => {
  const holder = document.body.appendChild(document.createElement("div"));
  const root = createRoot(holder);
  const onOpen = vi.fn().mockResolvedValue(true);
  const stat = vi.spyOn(opsApi, "sftpStat").mockImplementation(async (_session, path) => {
    if (path !== "/opt/ops/dist") throw new Error("Missing path");
    return { name: "dist", path, kind: "directory", size: 0, hidden: false };
  });
  vi.stubGlobal("IntersectionObserver", undefined);
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
            "Remote path: /opt/ops/dist. Deleted backup: `/opt/ops/dist.bak`.",
            "Fallback URL: http://example.org/docs.",
            "```sh\ncurl -I https://example.com/\n```",
            "```\n/opt/ops/dist\n```",
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
    expect([...links].map((link) => link.textContent)).toEqual([
      "Service", "/opt/ops/dist", "/opt/ops/dist", "http://example.org/docs",
    ]);
    expect(holder.textContent).toContain("/opt/ops/dist.bak");
    expect(stat).toHaveBeenCalledWith("workspace-session", "/opt/ops/dist.bak");
    links[0].click();
    expect(onOpen).toHaveBeenCalledWith({ kind: "website", url: "https://example.com/" });
    onOpen.mockResolvedValueOnce(false);
    await act(async () => links[1].click());
    expect(onOpen).toHaveBeenCalledWith({ kind: "directory", path: "/opt/ops/dist", sessionId: "workspace-session" });
    expect(holder.querySelector("code a")).toBeNull();
  } finally {
    await act(async () => root.unmount());
    holder.remove();
    stat.mockRestore();
    vi.unstubAllGlobals();
  }
});
