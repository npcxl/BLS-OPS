import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { useCallback, useEffect } from "react";
import type { DirectorySizeResult, RemoteFileEntry } from "@/api/ops-api";
import { useDirSizeStore } from "@/stores/dir-size-store";
import {
  DIR_SIZE_WATCHDOG_INTERVAL_MS,
  DIR_SIZE_WATCHDOG_LIMIT,
  pendingWatchPaths,
  useDirSizeQueue,
  useDirSizeWatchdog,
} from "./use-dir-size-queue";

// React 19 requires this flag for act() outside react-dom/test-utils.
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const listen = vi.hoisted(() => vi.fn());
const directorySizeStart = vi.hoisted(() => vi.fn());
const directorySizeStatusMany = vi.hoisted(() => vi.fn());

vi.mock("@tauri-apps/api/event", () => ({
  listen,
}));

vi.mock("@/api/ops-api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/api/ops-api")>();
  return {
    ...actual,
    opsApi: {
      ...actual.opsApi,
      directorySizeStart,
      directorySizeStatusMany,
    },
  };
});

const toResult = (overrides: Partial<DirectorySizeResult> = {}): DirectorySizeResult => ({
  sessionId: "s1",
  path: "/var/www/a",
  sizeBytes: 0,
  fileCount: 0,
  directoryCount: 0,
  skippedCount: 0,
  status: "computing",
  complete: false,
  calculatedAt: 100,
  ...overrides,
});

const dirEntry = (path: string): RemoteFileEntry => ({
  name: path.split("/").pop() ?? path,
  path,
  kind: "directory",
  size: 4096,
  modified_at: null,
  hidden: false,
});

/**
 * Mirrors the panel's wiring exactly: queue → listener-gated auto compute →
 * watchdog. This is the harness the behaviour tests render.
 */
const errors: string[] = [];
function Harness(props: { connected: boolean; sessionId: string; entries: RemoteFileEntry[] }) {
  const { connected, sessionId, entries } = props;
  const onError = useCallback((message: string) => errors.push(message), []);
  const { computeDirSize, listenerReady } = useDirSizeQueue(sessionId, onError);
  useDirSizeWatchdog({ connected, listenerReady, sessionId, entries });

  useEffect(() => {
    if (!connected || !listenerReady) return;
    for (const entry of entries) {
      if (entry.kind !== "directory") continue;
      const cached = useDirSizeStore.getState().get(sessionId, entry.path);
      if (cached?.complete) continue;
      computeDirSize(entry.path);
    }
  }, [connected, listenerReady, entries, sessionId, computeDirSize]);

  return <div data-testid="ready">{String(listenerReady)}</div>;
}

beforeEach(() => {
  vi.useFakeTimers();
  listen.mockReset();
  directorySizeStart.mockReset();
  directorySizeStatusMany.mockReset();
  directorySizeStart.mockResolvedValue(toResult());
  directorySizeStatusMany.mockResolvedValue([]);
  errors.length = 0;
  useDirSizeStore.setState({ results: {}, listening: false, unlisten: null });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("auto compute vs listener registration", () => {
  it("waits for the listener before starting any computation", async () => {
    let release!: () => void;
    listen.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = () => resolve(undefined);
        }),
    );

    const holder = document.createElement("div");
    document.body.appendChild(holder);
    const root = createRoot(holder);
    const entries = [dirEntry("/var/www/a")];
    act(() => {
      root.render(<Harness connected sessionId="s1" entries={entries} />);
    });

    // Listener registration still in flight — nothing may start yet.
    expect(holder.querySelector("[data-testid=ready]")?.textContent).toBe("false");
    expect(directorySizeStart).not.toHaveBeenCalled();

    await act(async () => {
      release();
      await Promise.resolve();
    });

    expect(holder.querySelector("[data-testid=ready]")?.textContent).toBe("true");
    expect(directorySizeStart).toHaveBeenCalledTimes(1);
    expect(directorySizeStart).toHaveBeenCalledWith("s1", "/var/www/a", undefined, false);

    act(() => root.unmount());
    holder.remove();
  });

  it("does not restart computations that already finished", async () => {
    listen.mockResolvedValue(() => undefined);
    useDirSizeStore
      .getState()
      .apply(toResult({ path: "/var/www/a", status: "completed", complete: true }));

    const holder = document.createElement("div");
    document.body.appendChild(holder);
    const root = createRoot(holder);
    const entries = [dirEntry("/var/www/a"), dirEntry("/var/www/b")];
    await act(async () => {
      root.render(<Harness connected sessionId="s1" entries={entries} />);
      await Promise.resolve();
    });

    expect(directorySizeStart).toHaveBeenCalledTimes(1);
    expect(directorySizeStart).toHaveBeenCalledWith("s1", "/var/www/b", undefined, false);

    act(() => root.unmount());
    holder.remove();
  });
});

describe("panel watchdog", () => {
  const renderHarness = async (entries: RemoteFileEntry[]) => {
    listen.mockResolvedValue(() => undefined);
    const holder = document.createElement("div");
    document.body.appendChild(holder);
    const root = createRoot(holder);
    await act(async () => {
      root.render(<Harness connected sessionId="s1" entries={entries} />);
      await Promise.resolve();
    });
    return { root, holder };
  };

  it("queries only unfinished directories, capped at 20, every 3 s", async () => {
    const unfinished = Array.from({ length: DIR_SIZE_WATCHDOG_LIMIT + 5 }, (_, index) =>
      dirEntry(`/var/www/d${index}`),
    );
    for (let index = 0; index < DIR_SIZE_WATCHDOG_LIMIT + 2; index += 1) {
      useDirSizeStore.getState().apply(toResult({ path: `/var/www/d${index}` }));
    }
    const { root, holder } = await renderHarness(unfinished);
    directorySizeStatusMany.mockClear();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(DIR_SIZE_WATCHDOG_INTERVAL_MS);
    });

    expect(directorySizeStatusMany).toHaveBeenCalledTimes(1);
    const [, paths] = directorySizeStatusMany.mock.calls[0] as [string, string[]];
    expect(paths.length).toBe(DIR_SIZE_WATCHDOG_LIMIT);

    act(() => root.unmount());
    holder.remove();
  });

  it("sends no request once every task finished", async () => {
    useDirSizeStore
      .getState()
      .apply(toResult({ path: "/var/www/a", status: "completed", complete: true }));
    useDirSizeStore
      .getState()
      .apply(toResult({ path: "/var/www/b", status: "partial", complete: true }));
    const { root, holder } = await renderHarness([dirEntry("/var/www/a"), dirEntry("/var/www/b")]);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(DIR_SIZE_WATCHDOG_INTERVAL_MS * 2);
    });

    expect(directorySizeStatusMany).not.toHaveBeenCalled();

    act(() => root.unmount());
    holder.remove();
  });

  it("stops querying after unmount", async () => {
    useDirSizeStore.getState().apply(toResult({ path: "/var/www/a" }));
    const { root, holder } = await renderHarness([dirEntry("/var/www/a")]);

    act(() => root.unmount());
    directorySizeStatusMany.mockClear();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(DIR_SIZE_WATCHDOG_INTERVAL_MS * 2);
    });

    expect(directorySizeStatusMany).not.toHaveBeenCalled();
    holder.remove();
  });

  it("does not run before the listener is ready or when disconnected", async () => {
    let release!: () => void;
    listen.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = () => resolve(undefined);
        }),
    );
    const holder = document.createElement("div");
    document.body.appendChild(holder);
    const root = createRoot(holder);
    const entries = [dirEntry("/var/www/a")];
    useDirSizeStore.getState().apply(toResult({ path: "/var/www/a" }));

    act(() => {
      root.render(<Harness connected sessionId="s1" entries={entries} />);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(DIR_SIZE_WATCHDOG_INTERVAL_MS * 2);
    });
    expect(directorySizeStatusMany).not.toHaveBeenCalled();

    await act(async () => {
      release();
      await Promise.resolve();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(DIR_SIZE_WATCHDOG_INTERVAL_MS);
    });
    expect(directorySizeStatusMany).toHaveBeenCalledTimes(1);

    act(() => root.unmount());
    holder.remove();
  });

  it("does not chase directories whose computation was never started", () => {
    useDirSizeStore.getState().apply(toResult({ path: "/var/www/a" }));
    const entries = [
      dirEntry("/var/www/a"),
      dirEntry("/var/www/never-started"),
      dirEntry("/var/www/finished"),
      { ...dirEntry("/var/www/file.txt"), kind: "file", size: 10 },
    ];
    useDirSizeStore
      .getState()
      .apply(toResult({ path: "/var/www/finished", status: "completed", complete: true }));

    expect(pendingWatchPaths("s1", entries)).toEqual(["/var/www/a"]);
  });
});
