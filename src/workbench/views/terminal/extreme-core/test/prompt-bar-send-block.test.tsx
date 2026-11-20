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
