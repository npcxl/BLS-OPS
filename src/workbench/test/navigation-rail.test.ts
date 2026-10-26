/**
 * 导航栏的"暂时隐藏"约束。
 *
 * 「部署」与「任务」后期再上，现在只隐藏**入口**：类型、store、视图、后端命令都保留。
 * 这条测试防的是"哪天有人顺手把入口加回去"或"过滤逻辑被改坏"。
 */

import { describe, expect, it } from "vitest";

import { NAV_ITEMS } from "../NavigationRail";

const ids = NAV_ITEMS.map((item) => item.id);

describe("导航栏", () => {
  it("不提供部署与任务的入口", () => {
    expect(ids).not.toContain("deploy");
    expect(ids).not.toContain("tasks");
  });

  it("其余模块一个都不少", () => {
    // 只隐藏这两个；其它入口必须仍在（避免过滤条件写宽了）。
    for (const id of ["ssh", "services", "logs", "projects", "ai", "settings"]) {
      expect(ids, id).toContain(id);
    }
  });

  it("隐藏项不留下空的分隔线", () => {
    // 分隔线是挂在条目上的；第一项不该带分隔线，否则顶上会多一条横线。
    expect(NAV_ITEMS[0]?.divider).not.toBe(true);
    // 过滤后仍然只有一条分隔线（AI 前面的那条）。
    expect(NAV_ITEMS.filter((item) => item.divider === true)).toHaveLength(1);
  });
});
