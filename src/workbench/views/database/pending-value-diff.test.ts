import { describe, expect, it } from "vitest";
import { assignmentText, sameAssignment, valueDiff } from "./pending-value-diff";

describe("pending value comparison", () => {
  it("highlights only the changed part", () => {
    expect(valueDiff("SO2026060017", "SO2026061017")).toEqual({
      prefix: "SO202606", removed: "0", added: "1", suffix: "017",
    });
  });
  it("handles insertions, deletions and non-BMP text", () => {
    expect(valueDiff("ab", "axb")).toEqual({ prefix: "a", removed: "", added: "x", suffix: "b" });
    expect(valueDiff("axb", "ab")).toEqual({ prefix: "a", removed: "x", added: "", suffix: "b" });
    expect(valueDiff("😀", "😁").removed).toBe("😀");
  });
  it("distinguishes SQL NULL, literal NULL and empty strings", () => {
    expect(sameAssignment({kind: "null"}, {kind: "value", value: "NULL"})).toBe(false);
    expect(sameAssignment({kind: "value", value: "x"}, {kind: "value", value: "x"})).toBe(true);
    expect(assignmentText({kind: "value", value: ""})).toBe('""');
    expect(assignmentText(undefined)).toBe("—");
  });
});
