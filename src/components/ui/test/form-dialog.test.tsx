import "@/i18n";
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { i18n } from "@/i18n";
import { FormDialog } from "@/components/ui/form-dialog";

/**
 * 表单弹窗的行为契约：Enter 的语义按控件走、执行中不重复提交、
 * 有未保存内容时关闭要先问一句、保存失败不丢用户输入。
 */

(
  globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const t = (key: string) => i18n.t(key) as string;

const FRAME = () =>
  new Promise<void>((resolve) => {
    window.requestAnimationFrame(() => resolve());
  });

function buttonByText(text: string): HTMLButtonElement {
  const found = Array.from(document.body.querySelectorAll("button")).find(
    (button) => button.textContent?.trim() === text,
  );
  if (!found) throw new Error(`button not found: ${text}`);
  return found as HTMLButtonElement;
}

describe("FormDialog", () => {
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

  const renderForm = (props: {
    onSubmit?: () => void;
    onCancel?: () => void;
    submitting?: boolean;
    dirty?: boolean;
    error?: unknown;
  }) => {
    act(() => {
      root.render(
        <FormDialog
          open
          title="新建键"
          onSubmit={props.onSubmit ?? (() => undefined)}
          onCancel={props.onCancel ?? (() => undefined)}
          submitting={props.submitting}
          dirty={props.dirty}
          error={props.error}
        >
          <input aria-label="key" defaultValue="" />
          <textarea aria-label="value" />
        </FormDialog>,
      );
    });
  };

  it("单行输入里按 Enter 提交，多行文本里按 Enter 换行", async () => {
    const onSubmit = vi.fn();
    renderForm({ onSubmit });
    await act(async () => {
      await FRAME();
    });

    const input = document.body.querySelector<HTMLInputElement>('input[aria-label="key"]')!;
    act(() => {
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    expect(onSubmit).toHaveBeenCalledTimes(1);

    const textarea = document.body.querySelector<HTMLTextAreaElement>(
      'textarea[aria-label="value"]',
    )!;
    act(() => {
      textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it("执行中按钮禁用，再按 Enter 也不会重复提交", async () => {
    const onSubmit = vi.fn();
    renderForm({ onSubmit, submitting: true });
    await act(async () => {
      await FRAME();
    });

    expect(buttonByText(t("Saving")).disabled).toBe(true);
    expect(buttonByText(t("Cancel")).disabled).toBe(true);

    const input = document.body.querySelector<HTMLInputElement>('input[aria-label="key"]')!;
    act(() => {
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("有未保存内容时关闭先确认，不会直接丢掉输入", async () => {
    const onCancel = vi.fn();
    renderForm({ onCancel, dirty: true });
    await act(async () => {
      await FRAME();
    });

    act(() => buttonByText(t("Cancel")).click());
    expect(onCancel).not.toHaveBeenCalled();

    const dialogs = document.body.querySelectorAll('[role="dialog"]');
    expect(dialogs.length).toBe(2);
    expect(document.body.textContent).toContain(t("Discard unsaved changes?"));

    act(() => buttonByText(t("Discard and close")).click());
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("保存失败时错误显示在表单里，已填内容保持不变", async () => {
    function Harness() {
      const [value, setValue] = useState("user:1001");
      return (
        <FormDialog
          open
          title="新建键"
          error={{ stage: "query", message: "键已存在" }}
          onSubmit={() => undefined}
          onCancel={() => undefined}
        >
          <input aria-label="key" value={value} onChange={(event) => setValue(event.target.value)} />
        </FormDialog>
      );
    }

    act(() => {
      root.render(<Harness />);
    });
    await act(async () => {
      await FRAME();
    });

    const input = document.body.querySelector<HTMLInputElement>('input[aria-label="key"]')!;
    expect(input.value).toBe("user:1001");
    expect(document.body.textContent).toContain("键已存在");
  });
});
