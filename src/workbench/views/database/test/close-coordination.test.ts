import { describe, expect, it } from "vitest";
import type { DbSessionInfo } from "@/api/types/database";
import type { WorkItem } from "@/stores/database-workspace-store";
import {
  assessCloseRisk,
  buildCloseBatch,
  hasCloseRisk,
  settleQueriesBeforeClose,
} from "../close-coordination";

function item(patch: Partial<WorkItem> = {}): WorkItem {
  return {
    id: "i1",
    kind: "query",
    profileId: "p1",
    connectionName: "conn",
    database: "db",
    objectName: "q",
    title: "q",
    pinned: false,
    createdAt: 0,
    pendingCount: 0,
    running: false,
    dirty: false,
    savedQueryId: null,
    ...patch,
  };
}

function session(transaction = "none"): DbSessionInfo {
  return { transaction } as DbSessionInfo;
}

describe("close coordination", () => {
  it("detects running, pending, dirty and transaction risks", () => {
    const risk = assessCloseRisk(
      item({ running: true, pendingCount: 2, dirty: true }),
      session("in_transaction"),
    );
    expect(risk).toMatchObject({
      running: true,
      pending: 2,
      dirty: true,
      inTransaction: true,
    });
    expect(hasCloseRisk(risk)).toBe(true);
  });

  it("does not require confirmation for a clean item", () => {
    expect(hasCloseRisk(assessCloseRisk(item(), session()))).toBe(false);
  });

  it("summarizes a mixed batch without dropping transaction risk", () => {
    const batch = buildCloseBatch(
      [
        item({ id: "a", running: true }),
        item({ id: "b", pendingCount: 3, dirty: true, profileId: "p2" }),
        item({ id: "c" }),
      ],
      {
        p1: session(),
        p2: session("in_transaction_read_only"),
      },
    );
    expect(batch.running).toBe(1);
    expect(batch.pending).toBe(3);
    expect(batch.dirty).toBe(1);
    expect(batch.inTransaction).toBe(1);
    expect(batch.risks).toHaveLength(3);
  });
});

describe("query settlement before close", () => {
  it("cancels running queries and waits until safe terminal", async () => {
    const states: Record<string, "running" | "cancelling" | "cancelled"> = {
      a: "running",
      b: "cancelling",
    };
    const cancelled: string[] = [];
    let sleeps = 0;
    await settleQueriesBeforeClose(["a", "b"], {
      cancel: async (id) => {
        cancelled.push(id);
        states[id] = "cancelled";
      },
      readState: (id) => states[id],
      sleep: async () => {
        sleeps += 1;
      },
    });
    expect(cancelled).toEqual(["a", "b"]);
    expect(sleeps).toBe(0);
  });

  it("refuses to close when cancellation never reaches a terminal state", async () => {
    await expect(
      settleQueriesBeforeClose(["a"], {
        cancel: async () => undefined,
        readState: () => "cancelling",
        timeoutMs: 20,
        intervalMs: 10,
        sleep: async () => undefined,
      }),
    ).rejects.toThrow(/取消超时/);
  });

  it("refuses to close an outcome_unknown query", async () => {
    await expect(
      settleQueriesBeforeClose(["a"], {
        cancel: async () => undefined,
        readState: () => "outcome_unknown",
      }),
    ).rejects.toThrow(/结果未知/);
  });
});
