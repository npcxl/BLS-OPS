import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { JsonView } from "../JsonView";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const clipboard = { text: "" };
Object.defineProperty(navigator, "clipboard", {
  value: { writeText: async (text: string) => void (clipboard.text = text) },
});

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

function render(value: unknown) {
  act(() => {
    root.render(<JsonView value={value} />);
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

const button = (label: string) =>
  [...container.querySelectorAll("button")].find((node) => node.textContent === label);
const byTitle = (title: string) =>
  [...container.querySelectorAll("button")].find((node) => node.getAttribute("title") === title);
const byAria = (label: string) =>
  [...container.querySelectorAll("button")].find(
    (node) => node.getAttribute("aria-label") === label,
  );
/** React 受控 input：必须用原生 setter 触发 onChange（直接赋 value 不生效）。 */
function type(query: string) {
  const input = container.querySelector("input") as HTMLInputElement;
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  setter?.call(input, query);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

const containers = [
  { name: "nginx", state: "running", ports: [{ host: 80, container: 80 }] },
  { name: "redis", state: "exited", ports: [] },
];

describe("JsonView —— JSON 只展示，绝不自动转表格", () => {
  it("对象数组**不渲染成表格**：没有 table/表头，行按索引展示", () => {
    render(containers);
    expect(container.querySelector("table")).toBeNull();
    expect(container.querySelectorAll("th")).toHaveLength(0);
    // 树形态：索引行 + 键行
    expect(container.textContent).toContain("[0]");
    expect(container.textContent).toContain("[1]");
    expect(container.textContent).toContain('"name"');
    expect(container.textContent).toContain("nginx");
  });

  it("叶子行是 JSON 键值对格式（键带引号，冒号后普通空格）", () => {
    render({ jsonKey: 1 });
    expect(container.textContent).toContain('"jsonKey": 1');
  });

  it("折叠 / 展开：折叠后子节点不再出现，展开后回来", () => {
    render(containers);
    expect(container.textContent).toContain("running");
    // 第一个容器行（[0]）折叠
    const collapse = byAria("Collapse");
    expect(collapse).toBeTruthy();
    act(() => collapse?.click());
    expect(container.textContent).not.toContain("running");
    act(() => byAria("Expand")?.click());
    expect(container.textContent).toContain("running");
  });

  it("全部折叠 / 展开全部", () => {
    render(containers);
    act(() => button("Collapse all")?.click());
    expect(container.textContent).not.toContain("running");
    act(() => button("Expand all")?.click());
    expect(container.textContent).toContain("running");
  });

  it("搜索：按路径/值过滤，无匹配时明确提示", () => {
    render(containers);
    const input = container.querySelector("input");
    expect(input).toBeTruthy();
    act(() => type("redis"));
    expect(container.textContent).toContain("$[1].name");
    expect(container.textContent).not.toContain("nginx");

    act(() => type("zzz-not-there"));
    expect(container.textContent).toContain("No matches");
  });

  it("复制路径：拿到 JSONPath（不是值）", async () => {
    render({ name: "nginx" });
    await act(async () => {
      byTitle("Copy path")?.click();
    });
    expect(clipboard.text).toBe("$.name");
  });

  it("复制整段 JSON 走 copyText（格式化文本）", async () => {
    render({ a: 1 });
    await act(async () => {
      button("Copy")?.click();
    });
    expect(clipboard.text).toBe(JSON.stringify({ a: 1 }, null, 2));
  });

  it("文本模式：格式化 JSON 原样展示", () => {
    render({ a: [1, 2] });
    act(() => button("Text")?.click());
    expect(container.querySelector("pre")?.textContent).toBe(JSON.stringify({ a: [1, 2] }, null, 2));
  });

  it("根是原始值 / 空容器也能显示（不崩、不空面板）", () => {
    render("just a string");
    expect(container.textContent).toContain('"just a string"');
    render([]);
    expect(container.textContent).toContain("[]");
  });

  describe("点击复制", () => {
    it("点击叶子节点 → 复制实际值（字符串不带引号）", async () => {
      render({ name: "nginx", replicas: 2, enabled: true, note: null });
      const leaf = (label: string) =>
        [...container.querySelectorAll('[data-testid="json-node"]')].find((node) =>
          node.textContent?.startsWith(label),
        ) as HTMLElement;
      await act(async () => {
        leaf('"name"').click();
      });
      expect(clipboard.text).toBe("nginx");
      await act(async () => {
        leaf('"replicas"').click();
      });
      expect(clipboard.text).toBe("2");
      await act(async () => {
        leaf('"enabled"').click();
      });
      expect(clipboard.text).toBe("true");
      await act(async () => {
        leaf('"note"').click();
      });
      expect(clipboard.text).toBe("null");
      expect(container.textContent).toContain("Copied");
    });

    it("点击容器仍然展开/折叠，**不复制**", async () => {
      render(containers);
      clipboard.text = "";
      const row = [...container.querySelectorAll('[data-testid="json-node"]')].find((node) =>
        node.textContent?.startsWith("[0]"),
      ) as HTMLElement;
      await act(async () => {
        row.click();
      });
      expect(clipboard.text).toBe(""); // 没有复制
      expect(container.textContent).not.toContain("running"); // 折叠生效
      expect(container.textContent).toContain("{…}"); // 容器摘要仍在
      await act(async () => {
        row.click();
      });
      expect(container.textContent).toContain("running"); // 再点展开
    });

    it("容器旁边的展开箭头也不复制（只切换）", async () => {
      render(containers);
      clipboard.text = "";
      await act(async () => {
        byAria("Collapse")?.click();
      });
      expect(clipboard.text).toBe("");
      expect(container.textContent).not.toContain("running");
    });

    it("搜索结果点击复制的是**完整值**，不是截断的展示文本", async () => {
      const long = `x`.repeat(600);
      render({ blob: long });
      act(() => type("blob"));
      expect(container.textContent).toContain("…"); // 展示被截断
      await act(async () => {
        container
          .querySelector<HTMLElement>('[data-testid="json-search-row"]')
          ?.click();
      });
      expect(clipboard.text).toBe(long); // 复制的是完整值
    });

    it("文本模式点击内容 → 复制完整 JSON", async () => {
      render({ a: [1, 2] });
      act(() => button("Text")?.click());
      await act(async () => {
        container.querySelector<HTMLElement>('[data-testid="json-text-copy"]')?.click();
      });
      expect(clipboard.text).toBe(JSON.stringify({ a: [1, 2] }, null, 2));
    });

    it("根为原始值时点击也能复制", async () => {
      render(42);
      await act(async () => {
        container.querySelector<HTMLElement>('[data-testid="json-root-copy"]')?.click();
      });
      expect(clipboard.text).toBe("42");
    });

    it("复制路径 / 复制节点 JSON 两个按钮保持原样", async () => {
      render({ name: "nginx" });
      await act(async () => {
        byTitle("Copy path")?.click();
      });
      expect(clipboard.text).toBe("$.name");
      await act(async () => {
        byTitle("Copy node JSON")?.click();
      });
      expect(clipboard.text).toBe('"nginx"');
    });
  });
});
