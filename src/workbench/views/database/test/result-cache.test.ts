import { describe, expect, it } from "vitest";
import {
  DEFAULT_INACTIVE_RESULT_BYTES,
  DEFAULT_INACTIVE_RESULT_ROWS,
  estimateRowsBytes,
  registerInactiveResult,
  resetInactiveResultRegistryForTests,
  shouldEvictInactiveResult,
} from "../result-cache";

describe("result cache budget", () => {
  it("keeps active and pending-edit pages", () => {
    expect(
      shouldEvictInactiveResult({
        active: true,
        rowCount: 100_000,
        pendingChanges: 0,
      }),
    ).toBe(false);
    expect(
      shouldEvictInactiveResult({
        active: false,
        rowCount: 100_000,
        pendingChanges: 2,
      }),
    ).toBe(false);
  });

  it("evicts large inactive pages over the row budget", () => {
    expect(
      shouldEvictInactiveResult({
        active: false,
        rowCount: DEFAULT_INACTIVE_RESULT_ROWS + 1,
        pendingChanges: 0,
      }),
    ).toBe(true);
    expect(
      shouldEvictInactiveResult({
        active: false,
        rowCount: DEFAULT_INACTIVE_RESULT_ROWS,
        pendingChanges: 0,
      }),
    ).toBe(false);
  });

  it("evicts by byte budget and estimates text/binary values", () => {
    const rows = [
      [
        { kind: "text" as const, value: "a".repeat(100), truncated: false, bytes: 100 },
        { kind: "binary" as const, base64: "AAAA", bytes: 3, truncated: false },
      ],
    ];
    expect(estimateRowsBytes(rows)).toBeGreaterThan(100);
    expect(
      shouldEvictInactiveResult({
        active: false,
        rowCount: 1,
        pendingChanges: 0,
        bytes: DEFAULT_INACTIVE_RESULT_BYTES + 1,
      }),
    ).toBe(true);
  });
});

describe("global result cache budget", () => {
  it("evicts the oldest hidden cache when the shared budget is exceeded", () => {
    resetInactiveResultRegistryForTests();
    localStorage.setItem("ops.db.globalResultBytes", String(8 * 1024 * 1024));
    const evicted: string[] = [];
    registerInactiveResult("a", 5 * 1024 * 1024, () => evicted.push("a"));
    registerInactiveResult("b", 5 * 1024 * 1024, () => evicted.push("b"));
    expect(evicted).toEqual(["a"]);
    resetInactiveResultRegistryForTests();
    localStorage.removeItem("ops.db.globalResultBytes");
  });

  it("bounds 100 hidden work items to the shared budget", () => {
    resetInactiveResultRegistryForTests();
    localStorage.setItem("ops.db.globalResultBytes", String(8 * 1024 * 1024));
    const evicted: string[] = [];
    for (let index = 0; index < 100; index += 1) {
      registerInactiveResult(`item-${index}`, 1024 * 1024, () =>
        evicted.push(`item-${index}`),
      );
    }
    // 8 MiB 预算 / 每页 1 MiB：只留下最新 8 页。
    expect(evicted).toHaveLength(92);
    expect(evicted[0]).toBe("item-0");
    expect(evicted[evicted.length - 1]).toBe("item-91");
    resetInactiveResultRegistryForTests();
    localStorage.removeItem("ops.db.globalResultBytes");
  });
});
