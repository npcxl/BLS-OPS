/**
 * Clipboard access, centrally guarded.
 *
 * Every call site wants the same thing: try, and never break the UI when it
 * fails (no permission, no focus, a non-secure context). Failures are reported
 * so callers can say "复制失败"/"粘贴失败" instead of looking like they worked.
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
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
    const text = await navigator.clipboard.readText();
    return typeof text === "string" ? text : null;
  } catch {
    return null;
  }
}
