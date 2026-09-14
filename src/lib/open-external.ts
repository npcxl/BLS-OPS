import { openUrl } from "@tauri-apps/plugin-opener";

/**
 * 用系统默认浏览器打开外部链接。
 *
 * **为什么不能直接用 `<a target="_blank">`**：Tauri 的 WebView 不会为
 * 外链开新窗口，裸链接点击是**静默无效**的（线上曾因此报"点了没反应"）。
 * 一切外链都必须走这里 → `tauri-plugin-opener`（capabilities 里只放行
 * `opener:allow-open-url`，不开放 shell 执行）。
 *
 * @returns 成功 true；被拒绝/系统无 handler 返回 false（调用方决定怎么提示）。
 */
export async function openExternal(url: string): Promise<boolean> {
  try {
    await openUrl(url);
    return true;
  } catch (error) {
    console.error("[open-external] failed to open URL", url, error);
    return false;
  }
}
