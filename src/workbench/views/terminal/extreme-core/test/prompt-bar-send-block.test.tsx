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
    expect(button?.getAttribute("title")).toBe("服务器未连接，重新连接后才能发送");
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
