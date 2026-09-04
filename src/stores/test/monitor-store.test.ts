import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MonitorSnapshot } from "@/api/ops-api";

const monitorSnapshot = vi.fn();
const sshStatus = vi.fn();

vi.mock("@/api/ops-api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/api/ops-api")>();
  return {
    ...actual,
    opsApi: {
      ...actual.opsApi,
      monitorSnapshot: (...args: unknown[]) => monitorSnapshot(...(args as [])),
      sshStatus: (...args: unknown[]) => sshStatus(...(args as [])),
    },
  };
});

const {
  useMonitorStore,
  MONITOR_HISTORY_WINDOW_MS,
  MONITOR_INTERVAL_MS,
  maxSamplesFor,
  totalThroughput,
} = await import("./monitor-store");

function snapshot(overrides: Partial<MonitorSnapshot> = {}): MonitorSnapshot {
  return {
    session_id: "s1",
    collected_at: 1_700_000_000,
    supported: true,
    unsupported_reason: null,
    system: {
      hostname: "web-01",
      os_name: "Ubuntu 22.04.3 LTS",
      os_version: "22.04",
      kernel: "5.15.0-91-generic",
      architecture: "x86_64",
      uptime_seconds: 12_345,
    },
    cpu: { usage_percent: 25, load_1: 0.5, load_5: 0.4, load_15: 0.3, logical_cores: 4 },
    memory: {
      total: 8_000_000_000,
      used: 4_000_000_000,
      available: 4_000_000_000,
      swap_total: 0,
      swap_used: 0,
      usage_percent: 50,
    },
    disks: [],
    network: [
      {
        interface: "eth0",
        received_bytes: 1_000,
        transmitted_bytes: 2_000,
        receive_speed: 100,
        transmit_speed: 200,
      },
    ],
    processes: [],
    ...overrides,
  };
}

const store = () => useMonitorStore.getState();

beforeEach(() => {
  monitorSnapshot.mockReset();
  sshStatus.mockReset();
  sshStatus.mockResolvedValue(true);
  useMonitorStore.setState({ entries: {} });
});

describe("monitor store", () => {
  it("defaults to a 5 second cadence", () => {
    expect(MONITOR_INTERVAL_MS).toBe(5_000);
  });

  it("keeps one entry per tab so switching tabs never mixes state", () => {
    store().attach("tab-a", "session-a", "server-1");
    store().attach("tab-b", "session-b", "server-1");

    store().setPaused("tab-a", true);
    expect(store().entries["tab-a"].paused).toBe(true);
    expect(store().entries["tab-b"].paused).toBe(false);

    store().detach("tab-a");
    expect(store().entries["tab-a"]).toBeUndefined();
    expect(store().entries["tab-b"]).toBeDefined();
  });

  it("starts from a clean slate when a tab re-attaches with a new session", () => {
    store().attach("tab-a", "session-a", "server-1");
    store().setPaused("tab-a", true);

    // A reconnect is a different connection: rates are deltas, so the old
    // history must not be diffed against it.
    store().attach("tab-a", "session-b", "server-1");

    expect(store().entries["tab-a"].sessionId).toBe("session-b");
    expect(store().entries["tab-a"].paused).toBe(false);
    expect(store().entries["tab-a"].history).toEqual([]);
  });

  it("does nothing before the session is connected", async () => {
    store().attach("tab-a", "session-a", "server-1");
    await store().refresh("tab-a");

    expect(monitorSnapshot).not.toHaveBeenCalled();
    expect(store().entries["tab-a"].snapshot).toBeNull();
  });

  it("records one history point per successful collection", async () => {
    monitorSnapshot.mockResolvedValue(snapshot());
    store().attach("tab-a", "session-a", "server-1");
    store().setPhase("tab-a", "connected");

    await store().refresh("tab-a");
    await store().refresh("tab-a");

    const entry = store().entries["tab-a"];
    expect(entry.phase).toBe("connected");
    expect(entry.history).toHaveLength(2);
    expect(entry.history[0]).toMatchObject({ cpu: 25, memory: 50, download: 100, upload: 200 });
    expect(entry.lastUpdatedAt).not.toBeNull();
  });

  it("drops samples older than the 30 minute window", async () => {
    monitorSnapshot.mockResolvedValue(snapshot());
    store().attach("tab-a", "session-a", "server-1");
    store().setPhase("tab-a", "connected");

    const staleAt = Date.now() - MONITOR_HISTORY_WINDOW_MS - 1_000;
    useMonitorStore.setState((state) => ({
      entries: {
        ...state.entries,
        "tab-a": {
          ...state.entries["tab-a"],
          history: [{ at: staleAt, cpu: 1, memory: 1, download: 0, upload: 0 }],
        },
      },
    }));

    await store().refresh("tab-a");

    const history = store().entries["tab-a"].history;
    expect(history).toHaveLength(1);
    expect(history[0].cpu).toBe(25);
  });

  describe("history window per interval", () => {
    // ceil(30min / intervalMs): every cadence must be able to hold the whole
    // 30-minute window, however fast it polls.
    it("allows at least 900 samples at the 2 second interval", () => {
      expect(maxSamplesFor(2_000)).toBeGreaterThanOrEqual(900);
    });

    it("caps the 5 second interval at 360 samples", () => {
      expect(maxSamplesFor(5_000)).toBe(360);
    });

    it("keeps 60 samples at the 30 second interval", () => {
      expect(maxSamplesFor(30_000)).toBe(60);
    });

    it("covers the full 30 minute window at every cadence", () => {
      for (const intervalMs of [2_000, 5_000, 10_000, 30_000]) {
        expect(maxSamplesFor(intervalMs) * intervalMs).toBeGreaterThanOrEqual(
          MONITOR_HISTORY_WINDOW_MS,
        );
      }
    });
  });

  it.each([2_000, 5_000, 30_000])(
    "holds the whole window at a %i cadence without growing unbounded",
    async (intervalMs) => {
      monitorSnapshot.mockResolvedValue(snapshot());
      store().attach("tab-a", "session-a", "server-1");
      store().setPhase("tab-a", "connected");
      store().setInterval("tab-a", intervalMs);

      // Stuff the history past the cap and past the window: stale points must
      // go through the time filter, in-window overflow through the count cap.
      const now = Date.now();
      const total = maxSamplesFor(intervalMs) + 50;
      const stale = Array.from({ length: 20 }, (_, index) => ({
        at: now - MONITOR_HISTORY_WINDOW_MS - (20 - index) * intervalMs,
        cpu: 1,
        memory: 1,
        download: 0,
        upload: 0,
      }));
      const fresh = Array.from({ length: total }, (_, index) => ({
        at: now - (total - index) * intervalMs,
        cpu: 2,
        memory: 2,
        download: 0,
        upload: 0,
      }));
      useMonitorStore.setState((state) => ({
        entries: {
          ...state.entries,
          "tab-a": { ...state.entries["tab-a"], history: [...stale, ...fresh] },
        },
      }));

      await store().refresh("tab-a");

      const history = store().entries["tab-a"].history;
      // Exactly one window's worth of the interval's samples survives …
      expect(history).toHaveLength(maxSamplesFor(intervalMs));
      // … the time filter still applies (nothing older than 30 minutes) …
      expect(history.every((point) => Date.now() - point.at <= MONITOR_HISTORY_WINDOW_MS)).toBe(
        true,
      );
      // … and the newest point wins.
      expect(history[history.length - 1]?.cpu).toBe(25);
    },
  );

  it("stops collecting when the OS is unsupported instead of showing zeroes", async () => {
    monitorSnapshot.mockResolvedValue(
      snapshot({ supported: false, unsupported_reason: "不支持的操作系统：Darwin。" }),
    );
    store().attach("tab-a", "session-a", "server-1");
    store().setPhase("tab-a", "connected");

    await store().refresh("tab-a");

    expect(store().entries["tab-a"].phase).toBe("unsupported");
    expect(store().entries["tab-a"].unsupportedReason).toContain("不支持");

    // Once unsupported, polling stops: a second call does nothing.
    monitorSnapshot.mockClear();
    await store().refresh("tab-a");
    expect(monitorSnapshot).not.toHaveBeenCalled();
  });

  it("keeps the phase as an error while the session is still alive", async () => {
    monitorSnapshot.mockRejectedValue(new Error("命令执行超时（超过 5 秒）"));
    sshStatus.mockResolvedValue(true);
    store().attach("tab-a", "session-a", "server-1");
    store().setPhase("tab-a", "connected");

    await store().refresh("tab-a");

    expect(store().entries["tab-a"].phase).toBe("error");
    expect(store().entries["tab-a"].error).toContain("超时");
  });

  it("stops polling and reports the disconnect when the session is gone", async () => {
    monitorSnapshot.mockRejectedValue(new Error("SSH 会话不存在或已断开"));
    sshStatus.mockResolvedValue(false);
    store().attach("tab-a", "session-a", "server-1");
    store().setPhase("tab-a", "connected");

    await store().refresh("tab-a");

    expect(store().entries["tab-a"].phase).toBe("closed");
    expect(store().entries["tab-a"].error).toContain("已断开");

    // A closed monitor never polls again until the user reconnects.
    monitorSnapshot.mockClear();
    await store().refresh("tab-a");
    expect(monitorSnapshot).not.toHaveBeenCalled();
  });

  it("does not overlap two collections", async () => {
    let release: (value: MonitorSnapshot) => void = () => undefined;
    monitorSnapshot.mockReturnValue(new Promise<MonitorSnapshot>((resolve) => {
      release = resolve;
    }));

    store().attach("tab-a", "session-a", "server-1");
    store().setPhase("tab-a", "connected");

    const first = store().refresh("tab-a");
    const second = store().refresh("tab-a");

    expect(monitorSnapshot).toHaveBeenCalledTimes(1);
    release(snapshot());
    await first;
    await second;
  });

  it("sums throughput across interfaces", () => {
    const snapshotWithTwoNics = snapshot({
      network: [
        { interface: "eth0", received_bytes: 1, transmitted_bytes: 2, receive_speed: 10, transmit_speed: 20 },
        { interface: "eth1", received_bytes: 3, transmitted_bytes: 4, receive_speed: 30, transmit_speed: 40 },
      ],
    });
    expect(totalThroughput(snapshotWithTwoNics)).toEqual({ download: 40, upload: 60 });
    expect(totalThroughput(null)).toEqual({ download: 0, upload: 0 });
  });
});
