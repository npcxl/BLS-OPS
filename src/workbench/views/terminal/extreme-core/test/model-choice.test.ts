import { describe, expect, it } from "vitest";
import {
  contextOptions,
  effortParam,
  effortTiers,
  formatTokens,
  highestEffort,
  matchBudget,
  normalizeEffortChoice,
  planRequiredFor,
} from "../model-choice";

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

  it("formatTokens 对小于 1K 的用量显示真实数量而不是 0K", () => {
    expect(formatTokens(0)).toBe("0");
    expect(formatTokens(380)).toBe("380");
    expect(formatTokens(1024)).toBe("1K");
    expect(formatTokens(307200)).toBe("300K");
    expect(formatTokens(1048576)).toBe("1M");
  });
});

/**
 * MAX 是"该模型支持的最高档"的别名：
 * 支持 max 就发 max，只支持到 high 就发 high，一档都不支持就不发。
 */
describe("思考强度的 MAX 映射", () => {
  it("MAX 原样发给后端，由后端按模型能力解析", () => {
    expect(highestEffort(["low", "high", "max"])).toBe("max");
    expect(highestEffort(["low", "medium", "high"])).toBe("high");
    expect(highestEffort([])).toBeNull();

    expect(effortParam("max", ["low", "high", "max"])).toBe("max");
    // 最高档叫 high 的模型：请求仍发 max，后端会落成 high；门控不能丢。
    expect(effortParam("max", ["low", "medium", "high"])).toBe("max");
    expect(effortParam("max", [])).toBe("max");
  });

  it("最高档统一显示为 MAX（供应商实际叫 high 也一样）", () => {
    expect(effortTiers(["low", "medium", "high"]).map((tier) => tier.label)).toEqual([
      "低",
      "中",
      "MAX",
    ]);
    expect(effortTiers(["low", "high", "max"]).map((tier) => tier.label)).toEqual([
      "低",
      "高",
      "MAX",
    ]);
    expect(effortTiers([])).toEqual([]);
  });

  it("旧记录里的 high 在只到 high 的模型上收成 MAX", () => {
    expect(normalizeEffortChoice("high", ["low", "medium", "high"])).toBe("max");
    expect(normalizeEffortChoice("max", ["low", "medium", "high"])).toBe("max");
    expect(normalizeEffortChoice("high", ["low", "high", "max"])).toBe("high");
    expect(normalizeEffortChoice("medium", ["low", "high"])).toBe("auto");
    expect(normalizeEffortChoice("max", [])).toBe("auto");
  });

  it("只有选 MAX 才强制计划", () => {
    expect(planRequiredFor("max")).toBe(true);
    expect(planRequiredFor("high")).toBe(false);
    expect(planRequiredFor("auto")).toBe(false);
  });

  it("模型不支持的普通档位不发，auto 一律不传", () => {
    expect(effortParam("medium", ["low", "high"])).toBeNull();
    expect(effortParam("high", ["low", "high"])).toBe("high");
    expect(effortParam("auto", ["low", "high"])).toBeNull();
  });
});
