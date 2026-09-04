import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { COPY_NOTICE_MS } from "@/components/ui/copy-feedback";
import { KeyValueView } from "../KeyValueView";
import { LogView } from "../LogView";
import { MetricsView } from "../MetricsView";
import { RawView } from "../RawView";
import { TableView } from "../TableView";
import { TreeView } from "../TreeView";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const clipboard = { text: "" };
Object.defineProperty(navigator, "clipboard", {
  value: { writeText: async (text: string) => void (clipboard.text = text) },
});

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

const nodes = (testId: string) =>
  [...container.querySelectorAll(`[data-testid="${testId}"]`)] as HTMLElement[];
const notice = () => container.querySelector('[data-testid="copy-notice"]')?.textContent ?? null;

const columns = [
  { key: "name", label: "NAME" },
  { key: "cpu", label: "CPU", numeric: true },
];

describe("结构化结果：点击复制", () => {
  it("表格：点击单元格复制单元格内容", async () => {
    render(
      <TableView
        columns={columns}
        rows={[
          { name: "nginx", cpu: "1.2" },
          { name: "redis", cpu: "0.4" },
        ]}
      />,
    );
    const cells = nodes("table-cell");
    expect(cells).toHaveLength(4);
    await act(async () => {
      cells[0].click();
    });
    expect(clipboard.text).toBe("nginx");
    await act(async () => {
      cells[3].click();
    });
    expect(clipboard.text).toBe("0.4");
    expect(notice()).toContain("Copied");
  });

  it("表格：筛选输入框不触发复制", async () => {
    render(<TableView columns={columns} rows={[{ name: "nginx", cpu: "1.2" }]} />);
    const input = container.querySelector("input") as HTMLInputElement;
    expect(input).toBeTruthy();
    await act(async () => {
      input.click();
    });
    expect(clipboard.text).toBe("");
  });

  it("Key/Value：点击值复制对应值", async () => {
    render(<KeyValueView rows={[{ key: "MemoryLimit", value: "infinity" }]} />);
    await act(async () => {
      nodes("kv-value")[0].click();
    });
    expect(clipboard.text).toBe("infinity");
  });

  it("Key/Value：分块（sections）同样可复制", async () => {
    render(
      <KeyValueView
        rows={[]}
        sections={[
          { title: "Service", view: "key_value", rows: [{ key: "Restart", value: "always" }] },
        ]}
      />,
    );
    await act(async () => {
      nodes("kv-value")[0].click();
    });
    expect(clipboard.text).toBe("always");
  });

  it("指标卡：点击复制“名称 + 数值 + 单位”", async () => {
    render(<MetricsView rows={[{ label: "已用内存", value: "3.2", unit: "GB" }]} />);
    await act(async () => {
      nodes("metric-card")[0].click();
    });
    expect(clipboard.text).toBe("已用内存 3.2 GB");
  });

  it("指标卡：没有单位时不留多余空格", async () => {
    render(<MetricsView rows={[{ label: "负载", value: "0.75" }]} />);
    await act(async () => {
      nodes("metric-card")[0].click();
    });
    expect(clipboard.text).toBe("负载 0.75");
  });

  it("日志：点击行复制该行完整内容（时间 + 级别 + 单元 + 消息）", async () => {
    render(
      <LogView
        rows={[
          { timestamp: "2026-09-04 10:00:00", level: "3", unit: "nginx.service", message: "boom" },
        ]}
      />,
    );
    await act(async () => {
      nodes("log-row")[0].click();
    });
    expect(clipboard.text).toBe("2026-09-04 10:00:00  err  nginx.service  boom");
  });

  it("日志：顶部“只看错误与警告”按钮不触发复制", async () => {
    render(<LogView rows={[{ level: "6", message: "info line" }]} />);
    const toggle = [...container.querySelectorAll("button")].find((node) =>
      node.textContent?.includes("Errors & warnings only"),
    );
    await act(async () => {
      toggle?.click();
    });
    expect(clipboard.text).toBe("");
  });

  it("树形：点击叶子复制 detail（值），分支复制 label", async () => {
    render(
      <TreeView
        rows={[
          { label: "etc", depth: 0 },
          { label: "nginx.conf", depth: 1, detail: "2.1 KB" },
        ]}
      />,
    );
    const rows = nodes("tree-node");
    await act(async () => {
      rows[1].click();
    });
    expect(clipboard.text).toBe("2.1 KB");
    await act(async () => {
      rows[0].click();
    });
    expect(clipboard.text).toBe("etc");
  });
});

describe("原始输出（RawView）：只提供复制全部", () => {
  it("点击复制 → 原始字节完整复制，不拆控制字符", async () => {
    render(<RawView stdout={"line1\nline2\tend"} stderr="boom" />);
    const copyAll = [...container.querySelectorAll("button")].find(
      (node) => node.getAttribute("title") === "Copy raw output",
    );
    await act(async () => {
      copyAll?.click();
    });
    expect(clipboard.text).toBe("line1\nline2\tend");
    expect(notice()).toBe("Copied");
    // stderr 仍然可见（保留展示），但不参与"复制全部"
    expect(container.textContent).toContain("boom");
  });
});

describe("复制提示（共用 CopyNotice）", () => {
  it("成功 / 失败文案", async () => {
    render(<KeyValueView rows={[{ key: "a", value: "b" }]} />);
    await act(async () => {
      nodes("kv-value")[0].click();
    });
    expect(notice()).toBe("Copied");

    const failing = vi
      .spyOn(navigator.clipboard, "writeText")
      .mockRejectedValue(new Error("denied"));
    try {
      await act(async () => {
        nodes("kv-value")[0].click();
      });
      expect(notice()).toBe("Copy failed. Please check clipboard permission");
    } finally {
      failing.mockRestore();
    }
  });

  it(`${COPY_NOTICE_MS}ms 后自动消失，且是绝对定位不占布局`, async () => {
    vi.useFakeTimers();
    try {
      render(<KeyValueView rows={[{ key: "a", value: "b" }]} />);
      await act(async () => {
        nodes("kv-value")[0].click();
      });
      const layer = container.querySelector('[data-testid="copy-notice"]')?.parentElement;
      expect(layer?.className).toContain("absolute");
      expect(layer?.className).toContain("pointer-events-none");
      expect(layer?.getAttribute("aria-live")).toBe("polite");
      await act(async () => {
        vi.advanceTimersByTime(COPY_NOTICE_MS);
      });
      expect(notice()).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});
