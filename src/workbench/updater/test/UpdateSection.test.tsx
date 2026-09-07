import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import "@/i18n";

// React 19 requires this flag for act() outside react-dom/test-utils.
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("@/lib/updater/updater-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/updater/updater-client")>();
  return { ...actual, isDevRuntime: () => false };
});

import { resetUpdaterStore, setUpdaterClient, useUpdaterStore } from "@/stores/updater-store";
import { useActivityStore } from "@/stores/activity-store";
import { useSessionStore } from "@/stores/session-store";
import { useDomainStore } from "@/stores/domain-store";
import type { UpdaterClient } from "@/lib/updater/updater-client";
import type { UpdateProgress, UpdateRelease } from "@/api/types/updater";
import type { AppInfo } from "@/api/ops-api";
import { UpdateSection } from "../UpdateSection";

const appInfo = (version: string): AppInfo => ({
  app_name: "ops-workbench",
  version,
  db_path: "C:\\data\\ops.sqlite3",
  schema_version: 1,
  keepalive_secs: 30,
  os: "windows",
  arch: "x86_64",
});

let client: UpdaterClient & {
  check: Mock<() => Promise<UpdateRelease | null>>;
  download: Mock<(onProgress: (progress: UpdateProgress) => void) => Promise<void>>;
  install: Mock<() => Promise<void>>;
  relaunch: Mock<() => Promise<void>>;
};

const store = () => useUpdaterStore.getState();

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

async function mount() {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root.render(<UpdateSection />);
  });
}

/** Buttons inside the settings section. */
function buttonWith(text: string): HTMLButtonElement | undefined {
  return [...container.querySelectorAll("button")].find((node) => node.textContent?.includes(text));
}

/** The restart dialog renders through a portal into `document.body`. */
function dialogButton(text: string): HTMLButtonElement | undefined {
  return [...document.body.querySelectorAll("button")].find((node) => node.textContent?.includes(text));
}

async function click(node: HTMLButtonElement | undefined) {
  await act(async () => {
    node?.click();
  });
}

/** One live SSH session, as the terminal would register it. */
function withSession() {
  useSessionStore.getState().register({ sessionId: "s1", tabId: "t1", title: "prod" });
  useSessionStore.getState().setStatus("s1", "connected");
}

beforeEach(() => {
  localStorage.clear();
  resetUpdaterStore();
  useActivityStore.setState({ tickets: {} });
  useSessionStore.setState({ sessions: {}, challenge: null });
  useDomainStore.setState({ appInfo: appInfo("0.1.0") });
  store().init();

  client = {
    check: vi.fn(async () => ({ version: "0.1.1", currentVersion: "0.1.0", notes: "fixes", date: null })),
    download: vi.fn(async () => undefined),
    install: vi.fn(async () => undefined),
    relaunch: vi.fn(async () => undefined),
  };
  setUpdaterClient(client);
});

afterEach(async () => {
  await act(async () => root?.unmount());
  container?.remove();
});

describe("UpdateSection", () => {
  it("shows the installed version, the channel and the last check", async () => {
    await mount();

    expect(container.textContent).toContain("v0.1.0");
    expect(container.textContent).toContain("Stable");
    expect(container.textContent).toContain("Never");
  });

  it("asks before installing while an SSH session is live", async () => {
    await store().check({ manual: true });
    withSession();
    await mount();

    await click(buttonWith("Download and install"));

    expect(document.body.textContent).toContain("1 active SSH sessions");
    expect(client.download).not.toHaveBeenCalled();

    // Cancelling keeps the update available and does not install anything.
    await click(dialogButton("Not now"));
    expect(container.textContent).toContain("A new version is available");
    expect(client.download).not.toHaveBeenCalled();

    // Once the session is gone the same button installs straight away.
    await act(async () => {
      useSessionStore.setState({ sessions: {} });
    });
    await click(buttonWith("Download and install"));
    expect(client.download).toHaveBeenCalledTimes(1);
  });

  it("warns about unsaved remote files", async () => {
    await store().check({ manual: true });
    useActivityStore.setState({ tickets: { e1: { id: "e1", kind: "editor" } } });
    await mount();

    await click(buttonWith("Download and install"));

    expect(document.body.textContent).toContain("1 files have unsaved changes");
    expect(client.download).not.toHaveBeenCalled();
  });

  it("keeps 'restart required' after the user postpones, and restarts later", async () => {
    await store().check({ manual: true });
    await store().install();
    withSession();
    await mount();

    await click(buttonWith("Restart now"));
    expect(document.body.textContent).toContain("Restart to finish the update?");

    await click(dialogButton("Not now"));
    expect(store().phase).toBe("restart_required");
    expect(client.relaunch).not.toHaveBeenCalled();

    // Later, with nothing left to lose, the same button restarts — and the
    // package is not downloaded again.
    await act(async () => {
      useSessionStore.setState({ sessions: {} });
    });
    await click(buttonWith("Restart now"));

    expect(client.relaunch).toHaveBeenCalledTimes(1);
    expect(client.download).toHaveBeenCalledTimes(1);
  });

  it("renders real download progress", async () => {
    await store().check({ manual: true });
    useUpdaterStore.setState({ phase: "downloading", progress: { received: 60, total: 100 } });
    await mount();

    expect(container.textContent).toContain("60%");
  });

  it("shows the new version after the app was updated", async () => {
    useDomainStore.setState({ appInfo: appInfo("0.1.1") });
    resetUpdaterStore();
    store().init();
    await mount();

    expect(container.textContent).toContain("v0.1.1");
  });

  it("shows a readable error and keeps working", async () => {
    client.check = vi.fn(async () => {
      throw new Error("Network is unreachable (os error 11001)");
    });
    setUpdaterClient(client);
    await store().check({ manual: true });
    await mount();

    expect(container.textContent).toContain("No network connection");
    expect(buttonWith("Check for updates")?.disabled).toBe(false);
  });
});
