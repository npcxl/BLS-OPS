import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";

/** 打开外链时优先使用的浏览器。`default` = 系统默认浏览器。 */
export type ExternalBrowser = "default" | "chrome";

/**
 * 用浏览器打开外部链接。
 *
 * **为什么不能直接用 `<a target="_blank">`**：Tauri 的 WebView 不会为
 * 外链开新窗口，裸链接点击是**静默无效**的（线上曾因此报"点了没反应"）。
 *
 * 打开顺序：
 *  1. 指定 `browser: "chrome"` 时先走 Rust `open_external_url` ——
 *     `plugin-opener` 只会交给系统默认浏览器，选不了具体程序；
 *  2. `tauri-plugin-opener`（首选，能力最小）
 *  3. 失败时回退到 Rust 命令 `open_external_url`（`cmd /C start` / `open` /
 *     `xdg-open`）——个别 Windows 环境下 opener 会直接失败，回退保证可用
 *
 * Chrome 没装时 Rust 自己回退系统默认浏览器，所以指定 Chrome 也不会打不开。
 *
 * @returns 成功 true；所有路径都失败返回 false（调用方决定怎么提示）。
 */
export async function openExternal(
  url: string,
  options: { browser?: ExternalBrowser } = {},
): Promise<boolean> {
  if (options.browser === "chrome") {
    try {
      await invoke("open_external_url", { url, browser: "chrome" });
      return true;
    } catch (error) {
      console.warn("[open-external] chrome failed; falling back to the default browser", error);
    }
  }

  try {
    await openUrl(url);
    return true;
  } catch (error) {
    console.warn("[open-external] opener failed; falling back to system command", error);
  }

  try {
    await invoke("open_external_url", { url, browser: "default" });
    return true;
  } catch (error) {
    console.error("[open-external] every path failed", url, error);
    return false;
  }
}
