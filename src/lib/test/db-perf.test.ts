import { describe, expect, it } from "vitest";
import { summarizeDbBatches, type DbBatchSample } from "../db-perf";

const sample = (ipcMs: number, processMs: number): DbBatchSample => ({
  at: 0,
  ipcMs,
  processMs,
  kind: "rows",
  rows: 100,
  bytes: 1024,
  resultSetId: "rs",
});

describe("db batch perf", () => {
  it("summarizes counts, bytes and percentiles without mutating input", () => {
    const input = [sample(10, 1), sample(20, 2), sample(100, 8)];
    const summary = summarizeDbBatches(input);
    expect(summary.count).toBe(3);
    expect(summary.rows).toBe(300);
    expect(summary.bytes).toBe(3072);
    expect(summary.ipcP50).toBe(20);
    expect(summary.ipcP95).toBe(100);
    expect(summary.ipcMax).toBe(100);
    expect(summary.slowest[0].ipcMs).toBe(100);
    expect(input[0].ipcMs).toBe(10);
  });

  it("returns zeros for an empty window", () => {
    const summary = summarizeDbBatches([]);
    expect(summary).toMatchObject({
      count: 0,
      rows: 0,
      bytes: 0,
      ipcP50: 0,
      ipcP95: 0,
      ipcMax: 0,
    });
  });
});
