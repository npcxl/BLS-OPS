import ReactDOM from "react-dom/client";
import App from "./App";
import { initTheme } from "@/hooks/use-theme";
import { initTerminalFont } from "@/workbench/views/terminal/terminal-font";
import "./styles/globals.css";
// i18n 必须在任何组件渲染前初始化（副作用导入，同步 init，见 src/i18n/index.ts）。
import "@/i18n";

initTheme();
// 终端字体同样是 CSS 变量：启动就应用，终端还没打开时结果面板也不跑偏。
initTerminalFont();

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
ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(<App />);
