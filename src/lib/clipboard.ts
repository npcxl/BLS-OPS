/**
 * Clipboard writes, centrally guarded.
 *
 * Every call site wants the same thing: try to copy, and never break the UI
 * when it fails (no permission, no focus, a non-secure context). Rejecting is
 * reported so callers can say "复制失败" instead of looking like they worked.
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}
