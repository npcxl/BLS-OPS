import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";

/**
 * 用系统默认浏览器打开外部链接。
 *
 * **为什么不能直接用 `<a target="_blank">`**：Tauri 的 WebView 不会为
 * 外链开新窗口，裸链接点击是**静默无效**的（线上曾因此报"点了没反应"）。
 *
 * 打开顺序：
 *  1. `tauri-plugin-opener`（首选，能力最小）
 *  2. 失败时回退到 Rust 命令 `open_external_url`（`cmd /C start` / `open` /
 *     `xdg-open`）——个别 Windows 环境下 opener 会直接失败，回退保证可用
 *
 * @returns 成功 true；两条路径都失败返回 false（调用方决定怎么提示）。
 */
export async function openExternal(url: string): Promise<boolean> {
  try {
    await openUrl(url);
    return true;
  } catch (error) {
    console.warn("[open-external] opener failed; falling back to system command", error);
  }

  try {
    await invoke("open_external_url", { url });
    return true;
  } catch (error) {
    console.error("[open-external] both opener and fallback failed", url, error);
    return false;
  }
}
