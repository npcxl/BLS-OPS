import { describe, expect, it } from "vitest";
import type { DbSessionInfo } from "@/api/types/database";
import type { WorkItem } from "@/stores/database-workspace-store";
import {
  assessCloseRisk,
  buildCloseBatch,
  hasCloseRisk,
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
