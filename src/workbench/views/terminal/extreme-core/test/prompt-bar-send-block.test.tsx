import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { i18n } from "@/i18n";
import PromptBar from "@/components/ui/prompt-bar";

/**
 * P3 回归：未连接时发送必须**禁用并说明原因**，不能静默无反应。
 * 草稿仍可编辑；busy 时的「停止」不受 sendDisabled 影响（断连也要能停）。
 */
async function renderBar(props: Record<string, unknown>) {
  const holder = document.body.appendChild(document.createElement("div"));
  const root = createRoot(holder);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  await act(async () =>
    root.render(<PromptBar value="看看磁盘" onChange={() => undefined} {...props} />),
  );
  const sendButton = () =>
    [...holder.querySelectorAll("button")].find((button) =>
      /send|发送|stop|停止/i.test(button.getAttribute("aria-label") ?? ""),
    );
  return {
    sendButton,
    cleanup: async () => {
      await act(async () => root.unmount());
      holder.remove();
      vi.unstubAllGlobals();
    },
  };
}

it("keeps the minimum height and measures again after hidden and width changes", async () => {
  let width = 400;
  let naturalHeight = 22;
  let onResize: () => void = () => undefined;
  const bounds = vi.spyOn(HTMLTextAreaElement.prototype, "getBoundingClientRect")
    .mockImplementation(() => new DOMRect(0, 0, width, naturalHeight));
  const scrollHeight = vi.spyOn(HTMLTextAreaElement.prototype, "scrollHeight", "get")
    .mockImplementation(() => naturalHeight);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("ResizeObserver", class {
    constructor(callback: () => void) { onResize = callback; }
    observe() {}
    disconnect() {}
  });
  const holder = document.body.appendChild(document.createElement("div"));
  const root = createRoot(holder);
  const show = async (value: string, suspended = false) => act(async () => {
    root.render(<PromptBar value={value} minRows={2} maxRows={4} suspended={suspended} />);
  });
  try {
    await show("");
    const input = holder.querySelector("textarea")!;
    expect(input.style.height).toBe("44px");

    width = 0;
    naturalHeight = 0;
    await show("新的长草稿", true);
    expect(input.style.height).toBe("44px");

    width = 400;
    naturalHeight = 66;
    await show("新的长草稿");
    expect(input.style.height).toBe("66px");

    width = 180;
    naturalHeight = 110;
    await act(async () => onResize());
    expect(input.style.height).toBe("88px");
    expect(input.style.overflowY).toBe("auto");
  } finally {
    await act(async () => root.unmount());
    holder.remove();
    bounds.mockRestore();
    scrollHeight.mockRestore();
    vi.unstubAllGlobals();
  }
});

it("disables send with a reason when the server is not connected", async () => {
  const language = i18n.language;
  await i18n.changeLanguage("zh-CN");
  const onSend = vi.fn();
  const { sendButton, cleanup } = await renderBar({
    onSend,
    sendDisabled: true,
    sendDisabledReason: "服务器未连接，重新连接后才能发送",
  });
  try {
    const button = sendButton();
    expect(button).toBeTruthy();
    expect(button?.disabled).toBe(true);
    // 提示统一走项目 Tooltip，不再用浏览器原生 title。
    expect(button?.hasAttribute("title")).toBe(false);
    await act(async () => {
      button?.dispatchEvent(new Event("pointerover", { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 180));
    });
    expect(document.querySelector('[role="tooltip"]')?.textContent).toContain(
      "服务器未连接，重新连接后才能发送",
    );
    await act(async () => button?.click());
    expect(onSend).not.toHaveBeenCalled();
  } finally {
    await cleanup();
    await i18n.changeLanguage(language);
  }
});

it("sends normally when connected", async () => {
  const language = i18n.language;
  await i18n.changeLanguage("zh-CN");
  const onSend = vi.fn();
  const { sendButton, cleanup } = await renderBar({ onSend });
  try {
    const button = sendButton();
    expect(button?.disabled).toBe(false);
    await act(async () => button?.click());
    expect(onSend).toHaveBeenCalledTimes(1);
    expect(onSend.mock.calls[0][0]).toBe("看看磁盘");
  } finally {
    await cleanup();
    await i18n.changeLanguage(language);
  }
});

it("输入法选词时的回车不会被建议菜单或发送吃掉", async () => {
  const language = i18n.language;
  await i18n.changeLanguage("zh-CN");
  const onSend = vi.fn();
  const onChange = vi.fn();
  const holder = document.body.appendChild(document.createElement("div"));
  const root = createRoot(holder);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const bar = (value: string) => (
    <PromptBar
      value={value}
      onChange={onChange}
      onSend={onSend}
      commands={[{ key: "inspect", name: "巡检这台服务器", description: "CPU、内存与磁盘" }]}
    />
  );
  // `/` 打开命令建议菜单：这正是"回车会被菜单抢走"的场景。
  await act(async () => root.render(bar("/")));
  const press = async (event: KeyboardEvent) => {
    await act(async () => {
      holder.querySelector("textarea")!.dispatchEvent(event);
    });
  };
  try {
    // 1) 组合中的回车：既不能选菜单，也不能发送。
    await press(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, isComposing: true }));
    expect(onSend).not.toHaveBeenCalled();
    expect(onChange).not.toHaveBeenCalled();

    // 2) WebView2 上提交选词的那次 keydown 有时不带 isComposing，只有 keyCode 229。
    const legacy = new KeyboardEvent("keydown", { key: "Enter", bubbles: true });
    Object.defineProperty(legacy, "keyCode", { value: 229 });
    await press(legacy);
    expect(onSend).not.toHaveBeenCalled();
    expect(onChange).not.toHaveBeenCalled();

    // 3) 选完词后的下一次回车：菜单照常工作（选中候选）。
    await press(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(onChange).toHaveBeenCalledWith("巡检这台服务器 ");

    // 4) 菜单收起、正文写好后：回车正常发送。
    await act(async () => root.render(bar("巡检这台服务器")));
    await press(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(onSend).toHaveBeenCalledTimes(1);
    expect(onSend.mock.calls[0][0]).toBe("巡检这台服务器");
  } finally {
    await act(async () => root.unmount());
    holder.remove();
    vi.unstubAllGlobals();
    await i18n.changeLanguage(language);
  }
});

it("keeps the stop button usable while disconnected", async () => {
  const language = i18n.language;
  await i18n.changeLanguage("zh-CN");
  const onStop = vi.fn();
  const { sendButton, cleanup } = await renderBar({
    onStop,
    busy: true,
    sendDisabled: true,
    sendDisabledReason: "服务器未连接，重新连接后才能发送",
  });
  try {
    const button = sendButton();
    expect(button?.disabled).toBe(false);
    await act(async () => button?.click());
    expect(onStop).toHaveBeenCalledTimes(1);
  } finally {
    await cleanup();
    await i18n.changeLanguage(language);
  }
});

it("matches slash commands by key and runs direct action commands", async () => {
  const language = i18n.language;
  await i18n.changeLanguage("zh-CN");
  const onChange = vi.fn();
  const onDiff = vi.fn();
  const holder = document.body.appendChild(document.createElement("div"));
  const root = createRoot(holder);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  try {
    await act(async () =>
      root.render(
        <PromptBar
          value="/dif"
          onChange={onChange}
          commands={[
            { key: "inspect", name: "巡检这台服务器", description: "CPU 与磁盘" },
            { key: "diff", name: "查看文件变更", description: "打开 Diff 面板", action: onDiff },
          ]}
        />,
      ),
    );
    const options = [...holder.querySelectorAll('[role="option"]')];
    expect(options).toHaveLength(1);
    expect(options[0].textContent).toContain("/diff");
    await act(async () => {
      holder.querySelector("textarea")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    expect(onDiff).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith("");
  } finally {
    await act(async () => root.unmount());
    holder.remove();
    vi.unstubAllGlobals();
    await i18n.changeLanguage(language);
  }
});

it("shows both stop and send buttons when busy with typed text and supports Alt+Enter / Esc", async () => {
  const language = i18n.language;
  await i18n.changeLanguage("zh-CN");
  const onSend = vi.fn();
  const onAltSend = vi.fn();
  const onStop = vi.fn();
  const holder = document.body.appendChild(document.createElement("div"));
  const root = createRoot(holder);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  try {
    await act(async () =>
      root.render(
        <PromptBar
          value="顺便查一下内存"
          onChange={() => undefined}
          busy
          busySendLabel="加入队列"
          onSend={onSend}
          onAltSend={onAltSend}
          onStop={onStop}
        />,
      ),
    );
    const stopBtn = holder.querySelector<HTMLButtonElement>('button[aria-label="停止"]');
    const queueBtn = holder.querySelector<HTMLButtonElement>('button[aria-label="加入队列"]');
    expect(stopBtn).toBeTruthy();
    expect(queueBtn).toBeTruthy();

    await act(async () => queueBtn!.click());
    expect(onSend).toHaveBeenCalledTimes(1);
    expect(onStop).not.toHaveBeenCalled();

    await act(async () => {
      holder.querySelector("textarea")!.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", altKey: true, bubbles: true }),
      );
    });
    expect(onAltSend).toHaveBeenCalledTimes(1);

    await act(async () => stopBtn!.click());
    expect(onStop).toHaveBeenCalledTimes(1);

    // 输入为空时按 Esc 直接停止当前运行。
    await act(async () =>
      root.render(
        <PromptBar value="" onChange={() => undefined} busy onSend={onSend} onStop={onStop} />,
      ),
    );
    await act(async () => {
      holder.querySelector("textarea")!.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      );
    });
    expect(onStop).toHaveBeenCalledTimes(2);
  } finally {
    await act(async () => root.unmount());
    holder.remove();
    vi.unstubAllGlobals();
    await i18n.changeLanguage(language);
  }
});
