import { createRoot } from "react-dom/client";
import { invoke } from "@tauri-apps/api/core";
import { DesktopMenuRoot } from "./menu-window";
import "@/styles/globals.css";

// A menu is not a second application: no App, business stores, splash or updater.
document.addEventListener("contextmenu", event => event.preventDefault());

/**
 * 把本窗口的运行时错误回报给来源窗口。
 *
 * 这个 WebView 没有用户可见的界面：一旦模块加载失败或渲染崩溃，表现就是
 * "右键没反应"，而错误只躺在它自己的 DevTools 里。回报出去之后，来源窗口
 * 能弹一条带原因的提示（也顺便回退到页面内菜单）。
 */
function report(message: string): void {
  void invoke("desktop_menu_report", { message }).catch(() => undefined);
}

window.addEventListener("error", event => {
  report(`${event.message}${event.filename ? ` @ ${event.filename}:${event.lineno}` : ""}`);
});
window.addEventListener("unhandledrejection", event => {
  report(`unhandled rejection: ${String((event.reason as { message?: string })?.message ?? event.reason)}`);
});

try {
  createRoot(document.getElementById("root")!).render(<DesktopMenuRoot />);
} catch (error) {
  report(`render failed: ${error instanceof Error ? error.message : String(error)}`);
}
