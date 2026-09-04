import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// React 19：act() 需要这个全局标记（与项目内其他组件测试一致）。
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { CommandResultRenderer } from "../CommandResultRenderer";
import { numericTone, parseStructuredResult } from "../model";
import type { StructuredCommandResult } from "../model";

/** 构造一个最小结果（其余字段走默认）。 */
function result(overrides: Partial<StructuredCommandResult>): StructuredCommandResult {
  return {
    view: "raw",
    title: "标题",
    summary: [],
    columns: [],
    rows: [],
    sections: [],
    warnings: [],
    meta: { command: "echo hi", exit_code: 0, duration_ms: 1, truncated: false },
    raw: { stdout: "RAW-STDOUT", stderr: "" },
    ...overrides,
  };
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

/** 渲染并断言某段文本出现过（DOM 层，不依赖 testing-library）。 */
function renderResult(data: StructuredCommandResult) {
  act(() => {
    root.render(<CommandResultRenderer result={data} />);
  });
  return container.textContent ?? "";
}

describe("统一渲染器按 view 分发", () => {
  it("table → 渲染列与行", () => {
    const text = renderResult(
      result({
        view: "table",
        columns: [{ key: "name", label: "名称列" }],
        rows: [{ name: "web" }],
      }),
    );
    expect(text).toContain("名称列");
    expect(text).toContain("web");
  });

  it("key_value → 渲染键值对", () => {
    const text = renderResult(
      result({ view: "key_value", rows: [{ key: "VersionKey", value: "1.24" }] }),
    );
    expect(text).toContain("VersionKey");
    expect(text).toContain("1.24");
  });

  it("log → 渲染日志消息与级别", () => {
    const text = renderResult(
      result({
        view: "log",
        rows: [{ level: "3", message: "disk full", unit: "nginx.service", timestamp: "" }],
      }),
    );
    expect(text).toContain("disk full");
    expect(text).toContain("err");
  });

  it("metrics → 渲染指标卡", () => {
    const text = renderResult(
      result({ view: "metrics", rows: [{ label: "内存指标", value: "7.8G" }] }),
    );
    expect(text).toContain("内存指标");
    expect(text).toContain("7.8G");
  });

  it("tree → 渲染节点", () => {
    const text = renderResult(result({ view: "tree", rows: [{ label: "srv-node", depth: 0 }] }));
    expect(text).toContain("srv-node");
  });

  it("json → 渲染格式化 JSON", () => {
    const text = renderResult(result({ view: "json", json: { jsonKey: 1 } }));
    expect(text).toContain('"jsonKey": 1');
  });

  it("table 缺列定义 → 退回原始输出（不渲染空表）", () => {
    const text = renderResult(result({ view: "table", rows: [{ a: 1 }] }));
    expect(text).toContain("RAW-STDOUT");
  });

  it("diff / progress / 未知 view → 退回原始输出（绝不空壳 UI）", () => {
    for (const view of ["diff", "progress", "unknown_view"] as const) {
      const text = renderResult(result({ view: view as StructuredCommandResult["view"] }));
      expect(text).toContain("RAW-STDOUT");
      act(() => root.unmount());
      root = createRoot(container);
    }
  });

  it("raw → 保留原始 stdout 与 stderr", () => {
    const text = renderResult(
      result({ view: "raw", raw: { stdout: "OUT-TEXT", stderr: "ERR-TEXT" } }),
    );
    expect(text).toContain("OUT-TEXT");
    expect(text).toContain("ERR-TEXT");
  });
});

describe("协议解析与阈值着色", () => {
  it("完整负载可解析", () => {
    const parsed = parseStructuredResult({
      view: "table",
      title: "t",
      columns: [{ key: "a", label: "A" }],
      rows: [{ a: 1 }],
      meta: { command: "c", exit_code: 0, duration_ms: 1, truncated: false },
      raw: { stdout: "s", stderr: "" },
    });
    expect(parsed?.view).toBe("table");
    expect(parsed?.rows).toEqual([{ a: 1 }]);
  });

  it("缺 view 或 raw 的负载返回 null（调用方退回原始输出）", () => {
    expect(parseStructuredResult({ view: "table" })).toBeNull();
    expect(parseStructuredResult(null)).toBeNull();
    expect(parseStructuredResult("string")).toBeNull();
  });

  it("数值阈值着色：解析数字前缀，解析不出不着色", () => {
    const column = {
      key: "use",
      label: "使用率",
      numeric: true,
      thresholds: { warn: 75, danger: 90 },
    };
    expect(numericTone("95%", column)).toBe("text-danger");
    expect(numericTone("80%", column)).toBe("text-warning");
    expect(numericTone("40%", column)).toBeNull();
    expect(numericTone("n/a", column)).toBeNull();
    // 非数值列不参与着色。
    expect(numericTone("95", { key: "x", label: "X" })).toBeNull();
  });
});
