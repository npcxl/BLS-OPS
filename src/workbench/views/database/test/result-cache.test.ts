import { describe, expect, it } from "vitest";
import {
  DEFAULT_INACTIVE_RESULT_ROWS,
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
});
