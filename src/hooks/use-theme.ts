import { useCallback, useSyncExternalStore } from "react";

import { applyWindowMaterial, systemMediaTheme } from "@/lib/window-material";

/**
 * Theme manager — follows the OS by default ("system"), with an optional
 * light/dark override persisted in localStorage.
 */

export type ThemeMode = "system" | "light" | "dark";

const STORAGE_KEY = "ops.theme";

const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

export function getThemeMode(): ThemeMode {
  const stored = localStorage.getItem(STORAGE_KEY);
  return stored === "light" || stored === "dark" ? stored : "system";
}

/**
 * 网页主题与原生窗口材质必须**同一次**切换。
 *
 * 只改 `data-theme` 的话，Windows 的 Acrylic 会继续跟着系统主题走：
 * 系统是深色、应用选浅色时，磨砂底色仍是深的，外壳就发灰发黑，
 * 于是别处只能靠加白底去压 —— 那正是要避免的做法。
 */
export function applyTheme() {
  const mode = getThemeMode();
  if (mode !== "system") {
    document.documentElement.dataset.theme = mode;
    void applyWindowMaterial(mode);
    return;
  }
  // 跟随系统：真实深浅只能由原生侧读系统设置给出。选过一次浅色/深色后，
  // 窗口主题会把 WebView 的 prefers-color-scheme 固定成那个值，媒体查询
  // 不再等于系统 —— 先按它落一帧只是兜底，随后用原生的解析结果纠正。
  document.documentElement.dataset.theme = systemMediaTheme();
  void applyWindowMaterial("system").then((state) => {
    // 期间用户又切走了，别拿旧结果覆盖。
    if (getThemeMode() !== "system") return;
    document.documentElement.dataset.theme = state.theme;
  });
}

export function setThemeMode(mode: ThemeMode) {
  localStorage.setItem(STORAGE_KEY, mode);
  applyTheme();
  emit();
}

export function subscribeTheme(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Apply once at startup and keep following the OS while running. */
export function initTheme() {
  applyTheme();
  window
    .matchMedia?.("(prefers-color-scheme: dark)")
    .addEventListener("change", () => {
      if (getThemeMode() === "system") {
        applyTheme();
        emit();
      }
    });
  window.addEventListener("storage", (event) => {
    if (event.key === STORAGE_KEY) {
      applyTheme();
      emit();
    }
  });
}

/** Reactive hook for UI that renders the current mode. */
export function useThemeMode(): [ThemeMode, (mode: ThemeMode) => void] {
  const mode = useSyncExternalStore(subscribeTheme, getThemeMode, getThemeMode);
  return [mode, setThemeMode];
}

/**
 * 当前**实际**是深色还是浅色（把「跟随系统」也解析掉）。
 *
 * `useThemeMode` 给的是用户选的那三档；画 canvas / shader 的组件读不到 CSS
 * 变量，必须知道真实落下来的是哪一边。真值只写在 `<html data-theme>` 上，
 * 而且「跟随系统」会被原生结果异步纠正一次 —— 所以直接盯这个属性。
 */
export function useIsDarkTheme(): boolean {
  const subscribe = useCallback((listener: () => void) => {
    const observer = new MutationObserver(listener);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });
    const off = subscribeTheme(listener);
    return () => {
      observer.disconnect();
      off();
    };
  }, []);
  const get = useCallback(() => document.documentElement.dataset.theme === "dark", []);
  return useSyncExternalStore(subscribe, get, () => false);
}
