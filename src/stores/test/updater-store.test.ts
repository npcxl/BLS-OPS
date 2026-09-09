import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";

/**
 * P5.1 update state machine.
 *
 * The real plugin is never touched: `setUpdaterClient` swaps in a fake, which
 * is also the only way to assert the two invariants that matter most — one
 * check per click and one download per install.
 */
const mocks = vi.hoisted(() => ({ dev: false }));

vi.mock("@/lib/updater/updater-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/updater/updater-client")>();
  return { ...actual, isDevRuntime: () => mocks.dev };
});

import { resetUpdaterStore, setUpdaterClient, useUpdaterStore } from "@/stores/updater-store";
import { useDomainStore } from "@/stores/domain-store";
import { useActivityStore } from "@/stores/activity-store";
import { useSessionStore } from "@/stores/session-store";
import type { UpdaterClient } from "@/lib/updater/updater-client";
import type { UpdateProgress, UpdateRelease } from "@/api/types/updater";
import type { AppInfo } from "@/api/ops-api";

const appInfo = (version: string): AppInfo => ({
  app_name: "Ops Workbench",
  version,
  db_path: "C:\\data\\ops.sqlite3",
  schema_version: 1,
  keepalive_secs: 30,
  os: "windows",
  arch: "x86_64",
});

interface Fake extends UpdaterClient {
  check: Mock<() => Promise<UpdateRelease | null>>;
  download: Mock<(onProgress: (progress: UpdateProgress) => void) => Promise<void>>;
  install: Mock<() => Promise<void>>;
  relaunch: Mock<() => Promise<void>>;
}

function fakeClient(release: { version: string; currentVersion: string } | null): Fake {
  const full: UpdateRelease | null = release ? { ...release, notes: null, date: null } : null;
  return {
    check: vi.fn(async () => full),
    download: vi.fn(async (onProgress: (p: { received: number; total: number | null }) => void) => {
      onProgress({ received: 0, total: 100 });
      onProgress({ received: 60, total: 100 });
    }),
    install: vi.fn(async () => undefined),
    relaunch: vi.fn(async () => undefined),
  };
}

let client: Fake;

function setClient(next: Fake) {
  client = next;
  setUpdaterClient(client);
}

const store = () => useUpdaterStore.getState();
const NEW = { version: "0.1.1", currentVersion: "0.1.0" };

beforeEach(() => {
  localStorage.clear();
  mocks.dev = false;
  resetUpdaterStore();
  useActivityStore.setState({ tickets: {} });
  useSessionStore.setState({ sessions: {}, challenge: null });
  useDomainStore.setState({ appInfo: appInfo("0.1.0") });
  store().init();
});

/** Registers one connected SSH session, as the terminal would. */
function connectSession() {
  useSessionStore.getState().register({ sessionId: "s1", tabId: "t1", title: "prod" });
  useSessionStore.getState().setStatus("s1", "connected");
}

describe("checking", () => {
  it("reports 'up to date' after a manual check that finds nothing", async () => {
    setClient(fakeClient(null));
    await store().check({ manual: true });

    expect(store().phase).toBe("up_to_date");
    expect(store().lastCheckedAt).toBeTypeOf("number");
  });

  it("stays silent when an automatic check finds nothing", async () => {
    setClient(fakeClient(null));
    await store().check({ manual: false });

    // Requirement: no startup nag — only a manual check may say "latest".
    expect(store().phase).toBe("idle");
    expect(store().bannerVisible).toBe(false);
  });

  it("surfaces a new version and raises the banner when found automatically", async () => {
    setClient(fakeClient(NEW));
    await store().check({ manual: false });

    expect(store().phase).toBe("available");
    expect(store().release?.version).toBe("0.1.1");
    expect(store().bannerVisible).toBe(true);
  });

  it("runs a single check no matter how many times it is clicked", async () => {
    setClient(fakeClient(NEW));
    const first = store().check({ manual: true });
    await store().check({ manual: true });
    await first;

    expect(client.check).toHaveBeenCalledTimes(1);
  });

  it("classifies an offline check without breaking the app", async () => {
    setClient(fakeClient(null));
    client.check.mockRejectedValueOnce(new Error("Network is unreachable (os error 11001)"));
    await store().check({ manual: true });

    expect(store().phase).toBe("error");
    expect(store().error?.code).toBe("network");
  });

  it("classifies an unreachable update URL", async () => {
    setClient(fakeClient(null));
    client.check.mockRejectedValueOnce(new Error("request timed out after 15s"));
    await store().check({ manual: true });

    expect(store().error?.code).toBe("timeout");
  });

  it("classifies a manifest without this platform's asset", async () => {
    setClient(fakeClient(null));
    client.check.mockRejectedValueOnce(new Error("no release asset found for target windows-x86_64"));
    await store().check({ manual: true });

    expect(store().error?.code).toBe("no_platform_asset");
  });

  it("refuses to continue when the signature is invalid", async () => {
    setClient(fakeClient(NEW));
    client.install.mockRejectedValueOnce(new Error("failed to verify signature: invalid signature"));
    await store().check({ manual: true });
    await store().install();

    expect(store().phase).toBe("error");
    expect(store().error?.code).toBe("signature_invalid");
  });

  it("never downloads anything in a development build", async () => {
    mocks.dev = true;
    setClient(fakeClient(NEW));
    await store().check({ manual: true });
    await store().install();

    expect(store().phase).toBe("error");
    expect(store().error?.code).toBe("unsupported_build");
    expect(client.download).not.toHaveBeenCalled();
  });
});

describe("downloading and installing", () => {
  it("reports real download progress", async () => {
    setClient(fakeClient(NEW));
    await store().check({ manual: true });
    await store().install();

    // The last frame wins; a bar stuck at 0 means progress events were dropped.
    expect(store().progress).toEqual({ received: 60, total: 100 });
  });

  it("downloads once even when install is clicked twice", async () => {
    setClient(fakeClient(NEW));
    await store().check({ manual: true });

    const first = store().install();
    await store().install();
    await first;

    expect(client.download).toHaveBeenCalledTimes(1);
    expect(client.install).toHaveBeenCalledTimes(1);
  });

  it("ends in restart_required and drops the banner", async () => {
    setClient(fakeClient(NEW));
    await store().check({ manual: true });
    await store().install();

    expect(store().phase).toBe("restart_required");
    expect(store().bannerVisible).toBe(false);
  });

  it("never re-downloads a package that is already installed", async () => {
    setClient(fakeClient(NEW));
    await store().check({ manual: true });
    await store().install();
    await store().install();
    await store().check({ manual: true });

    expect(client.download).toHaveBeenCalledTimes(1);
    expect(store().phase).toBe("restart_required");
  });

  // Regression guard for the race the store exists to close: the guard runs
  // when the user clicks *and* again after the download, because a download can
  // take minutes and an SSH session may appear meanwhile.
  it("stops at 'downloaded' when an SSH session appears during the download", async () => {
    setClient(fakeClient(NEW));
    client.download = vi.fn(async () => connectSession());
    await store().check({ manual: true });
    await store().install();

    expect(store().phase).toBe("downloaded");
    expect(client.install).not.toHaveBeenCalled();
    expect(store().release?.version).toBe("0.1.1");
  });

  /**
   * Regression for "pressing Install and restart does nothing": the session
   * was already there when the user confirmed the dialog, the package is on
   * disk — the click must run the installer. Re-running the blocker guard on
   * this step silently ate the click forever (the dialog confirmed the very
   * blockers the guard was waiting for).
   */
  it("runs the installer from 'downloaded' even with an SSH session still open", async () => {
    setClient(fakeClient(NEW));
    client.download = vi.fn(async () => connectSession());
    await store().check({ manual: true });
    await store().install(); // → held at 'downloaded', session still open
    expect(store().phase).toBe("downloaded");

    await store().install();

    expect(client.download).toHaveBeenCalledTimes(1); // package is on disk
    expect(client.install).toHaveBeenCalledTimes(1);
    expect(store().phase).toBe("restart_required");
  });

  it("finishes the install from 'downloaded' without downloading again", async () => {
    setClient(fakeClient(NEW));
    client.download = vi.fn(async () => connectSession());
    await store().check({ manual: true });
    await store().install();

    // Session closed: the same button now only has to run the installer.
    useSessionStore.setState({ sessions: {} });
    await store().install();

    expect(client.download).toHaveBeenCalledTimes(1);
    expect(client.install).toHaveBeenCalledTimes(1);
    expect(store().phase).toBe("restart_required");
  });

  it("restarts only from restart_required", async () => {
    setClient(fakeClient(NEW));
    await store().restart();
    expect(client.relaunch).not.toHaveBeenCalled();

    await store().check({ manual: true });
    await store().install();
    await store().restart();
    expect(client.relaunch).toHaveBeenCalledTimes(1);
  });

  it("reports a failed restart without losing the installed update", async () => {
    setClient(fakeClient(NEW));
    await store().check({ manual: true });
    await store().install();
    client.relaunch.mockRejectedValueOnce(new Error("failed to spawn process"));
    await store().restart();

    expect(store().phase).toBe("restart_required");
    expect(store().error?.code).toBe("restart_failed");
  });
});

describe("version bookkeeping", () => {
  it("upgrades 0.1.0 → 0.1.1 and reports 0.1.1 after the restart", async () => {
    setClient(fakeClient(NEW));
    await store().check({ manual: true });

    expect(store().currentVersion).toBe("0.1.0");
    expect(store().release?.version).toBe("0.1.1");

    await store().install();
    await store().restart();

    // Simulate the relaunched process: fresh store, backend now reports 0.1.1.
    resetUpdaterStore();
    useDomainStore.setState({ appInfo: appInfo("0.1.1") });
    store().init();

    expect(store().currentVersion).toBe("0.1.1");
  });
});
