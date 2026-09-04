import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TerminalSnapshotView } from "./TerminalSnapshotView";
import type { CapturedResult } from "./TerminalCommandCoordinator";

// React 19 + vitest：需要显式声明 act 环境（见项目既有约定）。
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const clipboard = { text: "" };
Object.defineProperty(navigator, "clipboard", {
  value: { writeText: async (text: string) => void (clipboard.text = text) },
});

function result(overrides: Partial<CapturedResult> = {}): CapturedResult {
  return {
    id: "r1",
    command: "docker ps",
    at: 1_000,
    knowledgeId: "",
    risk: "read_only",
    mutability: "read",
    canExecute: true,
    source: "input",
    boundary: {
      commandStart: 1_000,
      outputStart: 1_010,
      outputEnd: 1_050,
      exitCode: 0,
      durationMs: 50,
      endedBy: "marker",
    },
    stdout: "raw stdout",
    stderr: "",
    json: null,
    renderedText: "CONTAINER ID   IMAGE",
    renderedDegraded: false,
    ...overrides,
  } as CapturedResult;
}

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

function render(node: React.ReactNode) {
  act(() => {
    root.render(node);
  });
}

beforeEach(() => {
  clipboard.text = "";
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const tab = (label: string) =>
  [...container.querySelectorAll("button")].find((node) => node.textContent === label);

describe("TerminalSnapshotView", () => {
  it("默认展示【终端输出】（快照），不是结构化视图", () => {
    render(<TerminalSnapshotView result={result()} />);
    expect(container.textContent).toContain("CONTAINER ID   IMAGE");
    const pre = container.querySelector("pre");
    expect(pre?.className).toContain("w-max");
    // 不折行 + 横向滚动：长行必须原样保留（软换行已在提取时合并）。
    expect(pre?.className).toContain("whitespace-pre");
    expect(pre?.className).not.toContain("whitespace-pre-wrap");
  });

  it("快照长行不折行：整行文本原样出现（可被横向滚动查看）", () => {
    const long = `docker.m.daocloud.io/library/nginx:1.27-alpine ${"x".repeat(200)}`;
    render(<TerminalSnapshotView result={result({ renderedText: long })} />);
    expect(container.querySelector("pre")?.textContent).toBe(long);
  });

  it("没有 json → 只有【终端输出】【原始流】两个 Tab", () => {
    render(<TerminalSnapshotView result={result()} />);
    expect(tab("终端输出")).toBeTruthy();
    expect(tab("原始流")).toBeTruthy();
    expect(tab("JSON")).toBeUndefined();
  });

  it("合法 JSON → 出现 JSON Tab，切过去展示 JSON 值", () => {
    render(
      <TerminalSnapshotView
        result={result({ json: { kind: "json", value: { Image: "nginx" } } })}
      />,
    );
    const jsonTab = tab("JSON");
    expect(jsonTab).toBeTruthy();
    act(() => jsonTab?.click());
    expect(container.textContent).toContain("Image");
    expect(container.textContent).toContain("nginx");
  });

  it("坏 JSON Lines → json 为 null 时不出现 JSON Tab（数据完整，无部分解析）", () => {
    const mixed = '{"a":1}\nwarning: timeout\n';
    render(<TerminalSnapshotView result={result({ json: null, renderedText: mixed })} />);
    expect(tab("JSON")).toBeUndefined();
    // 输出本身一字不少地留在终端输出里。
    expect(container.querySelector("pre")?.textContent).toBe(mixed);
  });

  it("原始流 Tab：控制字符转义为可见 token，且可复制不含标记", async () => {
    render(<TerminalSnapshotView result={result({ stdout: "a\x1b[?2004l\r\n" })} />);
    act(() => tab("原始流")?.click());
    expect(container.textContent).toContain("<ESC>");
    expect(container.textContent).toContain("<CR>");
    await act(async () => {
      tab("复制")?.click();
    });
    expect(clipboard.text).toBe("a\x1b[?2004l\r\n"); // 复制的是原始字节
  });

  it("降级结果：显示可见的降级提示（不伪装成快照）", () => {
    render(<TerminalSnapshotView result={result({ renderedDegraded: true })} />);
    expect(container.textContent).toContain("渲染快照不可用");
    expect(container.textContent).toContain("软换行无法还原");
  });

  it("空输出是有效结果：显示为空，不回落、不假装有内容", () => {
    render(<TerminalSnapshotView result={result({ renderedText: "" })} />);
    expect(container.querySelector("pre")?.textContent).toBe("");
    expect(container.textContent).not.toContain("无输出");
  });
});
