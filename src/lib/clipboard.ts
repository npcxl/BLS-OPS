import { readText as readClipboardText, writeText as writeClipboardText } from "@tauri-apps/plugin-clipboard-manager";

/**
 * Clipboard access, centrally guarded.
 *
 * **Why the Tauri plugin and not `navigator.clipboard`**: the WebView's async
 * clipboard API makes WebView2 raise a native permission prompt — literally
 * "http://tauri.localhost wants to see text and images copied to the
 * clipboard" — on `readText()`. Reading through the Rust plugin needs no
 * permission and never prompts. Writes also go through it so there is exactly
 * one clipboard implementation, one failure path, one place to change.
 *
 * Every call site wants the same thing: try, and never break the UI when it
 * fails. Failures are reported so callers can say "复制失败"/"粘贴失败"
 * instead of looking like they worked.
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    await writeClipboardText(text);
    return true;
  } catch {
    return false;
  }
}

/**
 * Reads plain text from the clipboard.
 *
 * Returns `null` when the read fails or the clipboard holds no text (empty
 * string is a valid result — pasting nothing must not be mistaken for an
 * error). Callers decide how to surface `null`.
 */
export async function readText(): Promise<string | null> {
  try {
    const text = await readClipboardText();
    return typeof text === "string" ? text : null;
  } catch {
    return null;
  }
}
