import ReactDOM from "react-dom/client";
import App from "./App";
import { ShortcutsWindow } from "@/workbench/ShortcutsWindow";
import { DesktopMenuRoot } from "@/desktop-menu/menu-window";
import { prepareDesktopMenu } from "@/desktop-menu/bridge";
import { initTheme } from "@/hooks/use-theme";
import { initDensity } from "@/hooks/use-density";
import { initTerminalFont } from "@/workbench/views/terminal/terminal-font";
import "./styles/globals.css";
// i18n 必须在任何组件渲染前初始化（副作用导入，同步 init，见 src/i18n/index.ts）。
import "@/i18n";

/**
 * Disable the WebView's built-in context menu (Reload / Inspect / Save as…).
 *
 * This is a desktop app, not a browser: a native browser menu leaking through
 * on empty areas is wrong, and its "Reload" silently blows away in-memory UI
 * state (open sessions, panels). Our own menus (terminal, file tree, tabs…)
 * call `preventDefault` themselves and are **not** affected — this only kills
 * the ones nobody claimed.
 *
 * The dev build keeps it so the WebView inspector stays reachable; use F12
 * instead if you need DevTools.
 */
const isDevRuntime = import.meta.env.DEV;
window.addEventListener("contextmenu", (event) => {
  if (isDevRuntime) return;
  event.preventDefault();
});

/**
 * No StrictMode: in development it double-invokes effects, which would open a
 * real SSH connection, immediately tear it down (`ssh_disconnect`), then open a
 * second one. That makes connect/disconnect/reconnect unreliable and is not a
 * bug worth debugging twice.
 */
/**
 * 独立窗口（快捷键一览）由 Rust 的 `open_shortcuts_window` 创建，视图标识通过
 * 初始化脚本写成 `window.__BLS_VIEW__`。
 *
 * 为什么不用查询参数：`WebviewUrl::App("index.html?view=…")` 在部分平台上
 * 会被当成路径的一部分，前端读到 `null` 就渲染出一个空窗口。初始化脚本在页面
 * 脚本之前执行，变量一定存在；查询参数只作为手动打开时的兜底。
 */
declare global {
  interface Window {
    __BLS_VIEW__?: string;
  }
}

const view =
  window.__BLS_VIEW__ ?? new URLSearchParams(window.location.search).get("view") ?? undefined;

/**
 * 菜单窗口只渲染菜单树。
 *
 * 不能在这里跑 `initTheme`：它会按用户选择把**这个窗口**的原生主题设成
 * light/dark，而菜单窗口的主题来自当次菜单的 payload（右键发生时的主题）。
 * 二者同属一个进程，窗口主题会互相影响，菜单就会在深色菜单上套浅色材质。
 */
if (view !== "context-menu") {
  initTheme();
  initDensity();
  // 终端字体同样是 CSS 变量：启动就应用，终端还没打开时结果面板也不跑偏。
  initTerminalFont();
  // 预创建隐藏的菜单窗口：第一次右键不用等 WebView 初始化。
  prepareDesktopMenu();
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  view === "shortcuts" ? (
    <ShortcutsWindow />
  ) : view === "context-menu" ? (
    <DesktopMenuRoot />
  ) : (
    <App />
  ),
);
