import { describe, expect, it } from "vitest";
import {
  findColumnTypePreset,
  typeSupportsAutoIncrement,
  typeSupportsLength,
  typeSupportsScale,
} from "../column-types";

describe("列类型能力判断", () => {
  it("长度只给带参数的类型", () => {
    expect(typeSupportsLength("varchar")).toBe(true);
    expect(typeSupportsLength("VARCHAR(64)")).toBe(true);
    expect(typeSupportsLength("decimal")).toBe(true);
    expect(typeSupportsLength("int unsigned")).toBe(true);
    expect(typeSupportsLength("datetime")).toBe(true);
    expect(typeSupportsLength("date")).toBe(false);
    expect(typeSupportsLength("text")).toBe(false);
    expect(typeSupportsLength("json")).toBe(false);
    expect(typeSupportsLength("enum('a','b')")).toBe(false);
  });

  it("小数点只给 decimal / numeric / float / double", () => {
    expect(typeSupportsScale("decimal")).toBe(true);
    expect(typeSupportsScale("numeric")).toBe(true);
    expect(typeSupportsScale("float")).toBe(true);
    expect(typeSupportsScale("double")).toBe(true);
    expect(typeSupportsScale("int")).toBe(false);
    expect(typeSupportsScale("varchar")).toBe(false);
    expect(typeSupportsScale("datetime")).toBe(false);
  });

  it("自增只给整数类型", () => {
    expect(typeSupportsAutoIncrement("int")).toBe(true);
    expect(typeSupportsAutoIncrement("BIGINT UNSIGNED")).toBe(true);
    expect(typeSupportsAutoIncrement("tinyint(1)")).toBe(true);
    expect(typeSupportsAutoIncrement("varchar")).toBe(false);
    expect(typeSupportsAutoIncrement("decimal")).toBe(false);
    expect(typeSupportsAutoIncrement("bit")).toBe(false);
  });

  it("预设里的默认长度能对上", () => {
    expect(findColumnTypePreset("varchar")?.length).toBe("255");
    expect(findColumnTypePreset("decimal")?.scale).toBe("0");
    expect(findColumnTypePreset("int")?.length).toBe("");
  });
});
