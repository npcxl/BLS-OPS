import "@/i18n";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { i18n } from "@/i18n";
import { ErrorState } from "@/components/ui/error-state";

/**
 * 页面级错误：必须给"重试"和"看详情"，并且长报错不能把窗口撑破。
 */

(
  globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const t = (key: string) => i18n.t(key) as string;

describe("ErrorState", () => {
  let holder: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    holder = document.createElement("div");
    document.body.appendChild(holder);
    root = createRoot(holder);
  });

  afterEach(() => {
    act(() => root.unmount());
    holder.remove();
    document.body.innerHTML = "";
  });

  it("显示阶段、摘要与恢复建议，并给出重试", () => {
    const onRetry = vi.fn();
    act(() => {
      root.render(
        <ErrorState
          error={{ stage: "tcp", message: "Connection refused", detail: "127.0.0.1:3306" }}
          title="加载数据表"
          onRetry={onRetry}
        />,
      );
    });

    const text = document.body.textContent ?? "";
    expect(text).toContain("加载数据表");
    expect(text).toContain("Connection refused");
    expect(text).toContain("Network"); // 阶段标签
    expect(text).toContain("Check the host and port"); // 恢复建议

    const retry = Array.from(document.body.querySelectorAll("button")).find(
      (button) => button.textContent?.trim() === t("Retry"),
    );
    expect(retry).toBeDefined();
    act(() => retry?.click());
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("结果未知：明确标注，且不提供重试", () => {
    act(() => {
      root.render(
        <ErrorState
          error={{ stage: "outcome_unknown", message: "COMMIT 期间连接中断" }}
          onRetry={() => undefined}
        />,
      );
    });

    expect(document.body.textContent).toContain(t("Outcome unknown"));
    const retry = Array.from(document.body.querySelectorAll("button")).find(
      (button) => button.textContent?.trim() === t("Retry"),
    );
    expect(retry).toBeUndefined();
  });

  it("超长错误文本限制高度并允许换行，不横向溢出", () => {
    const long = "SELECT * FROM orders WHERE " + "x = 1 AND ".repeat(200);
    act(() => {
      root.render(<ErrorState error={{ stage: "query", message: long, detail: long }} />);
    });

    const summary = document.body.querySelector("p.break-words");
    expect(summary?.className).toContain("break-words");

    const toggle = Array.from(document.body.querySelectorAll("button")).find(
      (button) => button.textContent?.trim() === t("Show details"),
    );
    expect(toggle).toBeDefined();
    act(() => toggle?.click());

    const detail = document.body.querySelector("pre");
    expect(detail?.className).toContain("max-h-40");
    expect(detail?.className).toContain("overflow-auto");
    expect(detail?.className).toContain("break-words");
  });
});
