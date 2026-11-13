import { act, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { TerminalComposer } from "../TerminalComposer";

vi.mock("@/components/ui/curved-input", () => ({
  CurvedInput: ({ value, onCaretPosition }: {
    value: string;
    onCaretPosition: (point: { x: number; y: number }) => void;
  }) => {
    useEffect(() => onCaretPosition({ x: 100, y: 100 }), [onCaretPosition]);
    return <input value={value} readOnly />;
  },
}));

vi.mock("../use-composer-completion", () => ({
  useComposerCompletion: ({ text }: { text: string }) => ({
    usable: text === "",
    items: [
      { label: "docker", source: "command", insertText: "docker ", replaceRange: { start: 0, end: 0 } },
      { label: "dockerd", source: "command", insertText: "dockerd ", replaceRange: { start: 0, end: 0 } },
    ],
  }),
}));

it.each(["click", "keyboard"])("fills the chosen candidate by %s without running it", async (method) => {
  const holder = document.body.appendChild(document.createElement("div"));
  const root = createRoot(holder);
  const onSubmit = vi.fn();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  try {
    await act(async () => root.render(
      <TerminalComposer sessionId="test" cwd={null} home={null}
        disabled={false} interactive={false} history={[]} onSubmit={onSubmit} onInterrupt={() => {}} />,
    ));
    const input = holder.querySelector("input")!;
    await act(async () => input.focus());
    const candidate = document.querySelector<HTMLButtonElement>('button[title="dockerd "]')!;
    expect(candidate).toBeTruthy();
    expect(holder.contains(candidate)).toBe(false);
    if (method === "click") {
      /*
       * 走**真实的鼠标事件顺序**：pointerdown → mousedown → mouseup → click。
       *
       * 只调 `element.click()` 会跳过按下阶段，测不出"mousedown 里
       * preventDefault 保住焦点"以及"元素在 mouseup 前被换掉导致 click 丢失"
       * 这两类真实故障。
       */
      await act(async () => {
        candidate.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
        candidate.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
        candidate.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
        candidate.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });
      // 填入之后焦点必须还在输入框里（否则下一个字符会丢）。
      expect(document.activeElement).toBe(input);
    } else {
      const press = (key: string) => act(async () => {
        input.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
      });
      await press("ArrowDown");
      await press("Tab");
    }
    expect(input.value).toBe("dockerd ");
    expect(onSubmit).not.toHaveBeenCalled();
  } finally {
    await act(async () => root.unmount());
    holder.remove();
    vi.unstubAllGlobals();
  }
});
