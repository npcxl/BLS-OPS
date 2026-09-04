/**
 * Window-chrome platform probe.
 *
 * The top bar needs to decide between macOS native traffic lights and our own
 * Windows caption buttons, and that is the only thing it is allowed to branch
 * on. Tauri's os plugin is not a dependency of this app, and the webview always
 * reports its host in the user agent (WKWebView → "Mac OS X"), which is enough
 * for a one-shot chrome decision.
 */
export function isMacOS(): boolean {
  if (typeof navigator === "undefined") return false;
  return /Mac OS X|Macintosh/.test(navigator.userAgent);
}
