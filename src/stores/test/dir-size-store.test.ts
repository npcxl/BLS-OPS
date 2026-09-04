import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DirectorySizeResult } from "@/api/ops-api";

/**
 * Store tests run against a *fresh module instance* per test: the shared
 * listener promise is module-private state, so `vi.resetModules()` is the only
 * honest way to isolate `ensureListening` behaviour between tests.
 */
const listen = vi.hoisted(() => vi.fn());

vi.mock("@tauri-apps/api/event", () => ({
  listen,
}));

const loadStore = async () => await import("../dir-size-store");

function result(overrides: Partial<DirectorySizeResult> = {}): DirectorySizeResult {
  return {
    sessionId: "s1",
    path: "/var/www",
    sizeBytes: 0,
    fileCount: 0,
    directoryCount: 0,
    skippedCount: 0,
    status: "completed",
    complete: true,
    calculatedAt: 100,
    ...overrides,
  };
}

beforeEach(() => {
  vi.resetModules();
  listen.mockReset();
});

describe("dir-size-store keys", () => {
  it("caches under sessionId::path and reads back with the same key", async () => {
    const { useDirSizeStore } = await loadStore();
    useDirSizeStore.getState().apply(result({ sizeBytes: 12345 }));

    expect(useDirSizeStore.getState().get("s1", "/var/www")?.sizeBytes).toBe(12345);
    expect(Object.keys(useDirSizeStore.getState().results)).toEqual(["s1::/var/www"]);
  });

  it("normalises redundant slashes and trailing slashes onto one key", async () => {
    const { useDirSizeStore } = await loadStore();
    useDirSizeStore.getState().apply(result({ path: "/var//www/" }));

    // The listing's canonical path must hit the same entry.
    expect(useDirSizeStore.getState().get("s1", "/var/www")?.complete).toBe(true);
    expect(Object.keys(useDirSizeStore.getState().results)).toEqual(["s1::/var/www"]);
  });

  it("maps the filesystem root to '/' and normalises multi-slash paths", async () => {
    const { normalizeRemotePath, useDirSizeStore } = await loadStore();
    useDirSizeStore.getState().apply(result({ path: "/", sizeBytes: 7 }));

    expect(useDirSizeStore.getState().get("s1", "/")?.sizeBytes).toBe(7);
    // Pure normalisation, exercised directly (empty input has no key: the
    // backend never sends an empty path and apply rejects it).
    expect(normalizeRemotePath("")).toBe("/");
    expect(normalizeRemotePath("//var//www//")).toBe("/var/www");
  });

  it("keeps two sessions apart", async () => {
    const { useDirSizeStore } = await loadStore();
    useDirSizeStore.getState().apply(result({ sessionId: "s1", sizeBytes: 1 }));
    useDirSizeStore.getState().apply(result({ sessionId: "s2", sizeBytes: 2 }));

    expect(useDirSizeStore.getState().get("s1", "/var/www")?.sizeBytes).toBe(1);
    expect(useDirSizeStore.getState().get("s2", "/var/www")?.sizeBytes).toBe(2);
  });
});

describe("dir-size-store apply guards", () => {
  it("rejects payloads without sessionId instead of writing undefined::path", async () => {
    const { useDirSizeStore } = await loadStore();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    // Exactly what a serde-contract break produces (snake_case payload).
    useDirSizeStore.getState().apply({
      ...(result() as unknown as DirectorySizeResult),
      sessionId: undefined as unknown as string,
    });

    expect(errorSpy).toHaveBeenCalled();
    expect(
      Object.keys(useDirSizeStore.getState().results).some((key) => key.startsWith("undefined::")),
    ).toBe(false);
    expect(useDirSizeStore.getState().results).toEqual({});
    errorSpy.mockRestore();
  });

  it("never lets an older event overwrite a newer result", async () => {
    const { useDirSizeStore } = await loadStore();
    useDirSizeStore.getState().apply(result({ sizeBytes: 200, calculatedAt: 200 }));
    useDirSizeStore.getState().apply(result({ sizeBytes: 100, calculatedAt: 100 }));

    expect(useDirSizeStore.getState().get("s1", "/var/www")?.sizeBytes).toBe(200);
  });

  it("never lets a transient pending/computing state roll back a terminal one", async () => {
    const { useDirSizeStore } = await loadStore();
    useDirSizeStore.getState().apply(result({ status: "completed", complete: true, calculatedAt: 50 }));
    // Late replay of the queued state — even with a newer timestamp.
    useDirSizeStore.getState().apply(
      result({ status: "pending", complete: false, calculatedAt: 60 }),
    );
    useDirSizeStore.getState().apply(
      result({ status: "computing", complete: false, calculatedAt: 61 }),
    );

    const stored = useDirSizeStore.getState().get("s1", "/var/www");
    expect(stored?.status).toBe("completed");
    expect(stored?.complete).toBe(true);
  });

  it("still lets a terminal state replace an older transient one", async () => {
    const { useDirSizeStore } = await loadStore();
    useDirSizeStore.getState().apply(
      result({ status: "computing", complete: false, calculatedAt: 10 }),
    );
    useDirSizeStore.getState().apply(
      result({ status: "completed", complete: true, calculatedAt: 20, sizeBytes: 42 }),
    );

    expect(useDirSizeStore.getState().get("s1", "/var/www")?.sizeBytes).toBe(42);
  });
});

describe("dir-size-store ensureListening", () => {
  it("registers exactly one listener for concurrent callers", async () => {
    const { useDirSizeStore } = await loadStore();
    let release!: (unlisten: () => void) => void;
    listen.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );

    const first = useDirSizeStore.getState().ensureListening();
    const second = useDirSizeStore.getState().ensureListening();
    expect(listen).toHaveBeenCalledTimes(1);
    // Registration is not finished yet — listening must still be false.
    expect(useDirSizeStore.getState().listening).toBe(false);

    release(() => undefined);
    await Promise.all([first, second]);

    expect(useDirSizeStore.getState().listening).toBe(true);
    expect(useDirSizeStore.getState().unlisten).toBeTypeOf("function");
    expect(listen).toHaveBeenCalledTimes(1);
  });

  it("routes event payloads into the cache via the single listener", async () => {
    const { useDirSizeStore } = await loadStore();
    let handler!: (event: { payload: DirectorySizeResult }) => void;
    listen.mockImplementation((_event: string, onEvent: typeof handler) => {
      handler = onEvent;
      return Promise.resolve(() => undefined);
    });

    await useDirSizeStore.getState().ensureListening();
    handler({ payload: result({ sizeBytes: 777 }) });

    expect(useDirSizeStore.getState().get("s1", "/var/www")?.sizeBytes).toBe(777);
  });

  it("stays retryable after a failed registration", async () => {
    const { useDirSizeStore } = await loadStore();
    listen.mockRejectedValueOnce(new Error("bridge down"));

    await expect(useDirSizeStore.getState().ensureListening()).rejects.toThrow("bridge down");
    expect(useDirSizeStore.getState().listening).toBe(false);
    expect(useDirSizeStore.getState().unlisten).toBeNull();

    listen.mockResolvedValueOnce(() => undefined);
    await useDirSizeStore.getState().ensureListening();

    expect(listen).toHaveBeenCalledTimes(2);
    expect(useDirSizeStore.getState().listening).toBe(true);
  });

  it("short-circuits when already listening", async () => {
    const { useDirSizeStore } = await loadStore();
    listen.mockResolvedValue(() => undefined);

    await useDirSizeStore.getState().ensureListening();
    await useDirSizeStore.getState().ensureListening();

    expect(listen).toHaveBeenCalledTimes(1);
  });
});

describe("dir-size-store forgetSession", () => {
  it("drops only the disconnected session's cache", async () => {
    const { useDirSizeStore } = await loadStore();
    useDirSizeStore.getState().apply(result({ sessionId: "s1" }));
    useDirSizeStore.getState().apply(result({ sessionId: "s2" }));

    useDirSizeStore.getState().forgetSession("s1");

    expect(useDirSizeStore.getState().get("s1", "/var/www")).toBeUndefined();
    expect(useDirSizeStore.getState().get("s2", "/var/www")).toBeDefined();
  });
});
