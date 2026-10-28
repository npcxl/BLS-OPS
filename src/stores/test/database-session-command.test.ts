import { beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  queryStart: vi.fn(),
  queryNext: vi.fn(),
  queryRelease: vi.fn(),
  sessionInfo: vi.fn(),
}));

vi.mock("@/api/ops-api", () => ({ databaseApi: api }));

import { useDatabaseStore } from "../database-store";

const PROFILE = "p-session-command";
const SESSION = {
  session_id: "s1",
  profile_id: PROFILE,
  generation: 1,
  connection_id: 1,
  server_version: "8.0",
  current_database: "db",
  tls_active: false,
  tls_cipher: null,
  tls_version: null,
  transaction: "none",
  read_only: false,
  opened_at: Date.now(),
} as never;

describe("runSessionCommand", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useDatabaseStore.setState({ sessions: { [PROFILE]: SESSION } });
    api.queryStart.mockResolvedValue({ query_id: "q1" });
    api.queryRelease.mockResolvedValue(undefined);
    api.sessionInfo.mockResolvedValue(SESSION);
  });

  it("accepts only completed", async () => {
    api.queryNext.mockResolvedValue({ state: "completed", batch: null });
    await expect(
      useDatabaseStore.getState().runSessionCommand(PROFILE, "COMMIT"),
    ).resolves.toBeUndefined();
  });

  it.each(["failed", "cancelled", "outcome_unknown"])(
    "rejects terminal state %s",
    async (state) => {
      api.queryNext.mockResolvedValue({ state, batch: null });
      await expect(
        useDatabaseStore.getState().runSessionCommand(PROFILE, "COMMIT"),
      ).rejects.toThrow(new RegExp(state));
    },
  );

  it("rejects a non-terminal polling limit", async () => {
    const timers = vi
      .spyOn(globalThis, "setTimeout")
      .mockImplementation(((callback: () => void) => {
        callback();
        return 0;
      }) as typeof setTimeout);
    api.queryNext.mockResolvedValue({ state: "running", batch: null });

    await expect(
      useDatabaseStore.getState().runSessionCommand(PROFILE, "COMMIT"),
    ).rejects.toThrow(/轮询超限/);
    timers.mockRestore();
  });
});
