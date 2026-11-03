import { describe, expect, it } from "vitest";
import type { DbValue } from "@/api/types/database";
import { pendingRow } from "./pending-row";

describe("draft row display", () => {
  const original: DbValue[] = [{ kind: "int", value: "123", unsigned: false }, { kind: "null" }];
  it("displays an edited value immediately and preserves the server snapshot", () => {
    const draft = pendingRow(original, ["id", "name"], [{column: "id", value: {kind: "value", value: "789"}}]);
    expect(draft[0]).toMatchObject({ value: "789", truncated: false });
    expect(original[0]).toMatchObject({ value: "123" });
    expect(draft[1]).toBe(original[1]);
    expect(pendingRow(original, ["id", "name"], [])[0]).toBe(original[0]);
  });
  it("supports repeat edits, nulls, empty strings and defaults", () => {
    expect(pendingRow(original, ["id"], [{column: "id", value: {kind: "value", value: "999"}}])[0]).toMatchObject({value: "999"});
    expect(pendingRow(original, ["id"], [{column: "id", value: {kind: "null"}}])[0]).toEqual({kind: "null"});
    expect(pendingRow(original, ["id"], [{column: "id", value: {kind: "value", value: ""}}])[0]).toMatchObject({value: "", bytes: 0});
    expect(pendingRow(original, ["id"], [{column: "id", value: {kind: "default"}}])[0]).toMatchObject({value: "DEFAULT"});
  });
});
