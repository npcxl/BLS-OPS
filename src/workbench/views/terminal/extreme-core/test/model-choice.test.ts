import { describe, expect, it } from "vitest";
import { contextOptions, effortParam, highestEffort, matchBudget } from "../model-choice";

/**
 * 预算菜单按**显示档位**去重：1000000 与 1048576 都写 1M，
 * 不能并排出现两个无法区分的选项。
 */
describe("上下文档位", () => {
  it("去重 1M 显示碰撞与重复值，保留不同标签的自定义档位", () => {
    const options = contextOptions([
      368640, // 360K
      307200, // 300K
      1048576, // 1M
      1200000, // 也会显示成 1M
      1048576,
      614400, // 600K
      737280, // 720K
    ]);
    expect(options).toEqual([307200, 368640, 614400, 737280, 1048576]);
  });

  it("已保存的 1200000 能对到菜单保留的 1M", () => {
    const options = contextOptions([1048576]);
    expect(matchBudget(1200000, options)).toBe(1048576);
    expect(matchBudget(300 * 1024, options)).toBeNull();
  });
});

/**
 * MAX 是"该模型支持的最高档"的别名：
 * 支持 max 就发 max，只支持到 high 就发 high，一档都不支持就不发。
 */
describe("思考强度的 MAX 映射", () => {
  it("按模型实际支持的最高档发送", () => {
    expect(highestEffort(["low", "high", "max"])).toBe("max");
    expect(highestEffort(["low", "medium", "high"])).toBe("high");
    expect(highestEffort([])).toBeNull();

    expect(effortParam("max", ["low", "high", "max"])).toBe("max");
    expect(effortParam("max", ["low", "medium", "high"])).toBe("high");
    expect(effortParam("max", [])).toBeNull();
  });

  it("模型不支持的普通档位不发，auto 一律不传", () => {
    expect(effortParam("medium", ["low", "high"])).toBeNull();
    expect(effortParam("high", ["low", "high"])).toBe("high");
    expect(effortParam("auto", ["low", "high"])).toBeNull();
  });
});
