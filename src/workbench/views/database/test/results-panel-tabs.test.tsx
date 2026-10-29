import "@/i18n";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DbColumn, DbValue } from "@/api/types/database";
import {
  useDatabaseWorkbenchStore,
  type DatabaseTabState,
  type StatementResult,
} from "@/stores/database-workbench-store";
import { ResultsPanel } from "../ResultsPanel";

/**
 * 结果面板的三块视图（消息 / 摘要 / 结果 N）。
 * 重点回归：错误不能只出现在"结果"页、摘要行数要区分 SELECT 与 DML。
 */

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

const column = (name: string): DbColumn => ({
  index: 0,
  name,
  org_name: name,
  table: "",
  org_table: "",
  type_name: "int",
  type_code: 3,
  nullable: true,
  unsigned: false,
  binary: false,
  primary_key: false,
  auto_increment: false,
  decimals: 0,
  charset: 0,
});

const cell = (value: string): DbValue => ({
  kind: "text",
  value,
  bytes: value.length,
  truncated: false,
});

const selectResult: StatementResult = {
  key: "1",
  statementIndex: 0,
  resultSetIndex: 0,
  statement: "SELECT * FROM `kox`.`ai_conversation` LIMIT 200",
  columns: [column("id")],
  rows: [[cell("1")], [cell("2")]],
  affectedRows: 0,
  lastInsertId: null,
  warnings: 0,
  info: "",
  elapsedMs: 4,
  receivedRows: 2,
  bytes: 32,
  truncated: false,
  truncationReason: null,
  error: null,
};

const failedResult: StatementResult = {
  ...selectResult,
  key: "error:1",
  resultSetIndex: 1,
  statement: "SELECT * FROM `kox`.`ai_conversation` LIMIT 400",
  columns: [],
  rows: [],
  receivedRows: 0,
  error: {
    stage: "query",
    code: 1064,
    sql_state: "42000",
    message: "You have an error in your SQL syntax",
    detail: "near 'LIMIT 400' at line 3",
    retryable: false,
  },
};

function seed(results: StatementResult[]) {
  const tab: DatabaseTabState = {
    profileId: "p1",
    sql: "SELECT 1",
    results,
    activeResultKey: results[0]?.key ?? null,
    runState: "completed",
    queryId: null,
    currentStatement: results.length,
    totalStatements: results.length,
    error: null,
    elapsedMs: 40,
    receivedRows: 2,
    bytes: 64,
    truncated: false,
    truncationReason: null,
    cacheWarning: null,
    lastRunAt: null,
  };
  useDatabaseWorkbenchStore.setState({ tabs: { t1: tab } });
}

let container: HTMLDivElement;
let root: Root;

function mount() {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root.render(<ResultsPanel tabId="t1" />);
  });
}

/** 结果标签的文本还带着行数（“结果 1 2 行”），所以按前缀匹配。 */
const tabButton = (label: string) =>
  [...container.querySelectorAll("button")].find((button) =>
    (button.textContent ?? "").trim().startsWith(label),
  ) as HTMLButtonElement | undefined;

function click(element: HTMLElement) {
  act(() => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
}

beforeEach(() => {
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver = ResizeObserverStub;
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  useDatabaseWorkbenchStore.setState({ tabs: {} });
});

describe("结果面板三视图", () => {
  it("默认停在结果页，并保留数据网格", () => {
    seed([selectResult]);
    mount();
    expect(tabButton("消息")).toBeTruthy();
    expect(tabButton("摘要")).toBeTruthy();
    expect(tabButton("结果 1")).toBeTruthy();
    expect(container.querySelector('[role="grid"]')).toBeTruthy();
  });

  it("消息页显示语句、返回行数、查询时间与总耗时", () => {
    seed([selectResult]);
    mount();
    click(tabButton("消息")!);
    const text = container.textContent ?? "";
    expect(text).toContain("> 返回 2 行");
    expect(text).toContain("> 查询时间: 0.004s");
    expect(text).toContain("总耗时");
    // 消息页不渲染数据网格。
    expect(container.querySelector('[role="grid"]')).toBeNull();
  });

  it("摘要页区分返回行与影响行，点击行跳回结果", () => {
    seed([selectResult, failedResult]);
    mount();
    click(tabButton("摘要")!);
    const rows = [...container.querySelectorAll("tbody tr")];
    expect(rows).toHaveLength(2);
    expect(rows[0].textContent).toContain("成功");
    expect(rows[0].textContent).toContain("返回 2 行");
    expect(rows[1].textContent).toContain("失败");
    // 错误消息直接跟在同一行的语句后面，不必切换到"消息"页才能看到。
    expect(rows[1].textContent).toContain("You have an error in your SQL syntax");

    click(rows[0] as HTMLElement);
    expect(container.querySelector('[role="grid"]')).toBeTruthy();
  });

  it("错误结果在结果页显示红色错误条（不只在消息页）", () => {
    seed([failedResult]);
    mount();
    const text = container.textContent ?? "";
    expect(text).toContain("You have an error in your SQL syntax");
    expect(text).toContain("#1064 42000");
  });

  it("没有结果时给空状态，不渲染三视图", () => {
    seed([]);
    mount();
    expect(container.textContent).toContain("这次执行没有返回结果");
  });
});
