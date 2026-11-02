import { useSyncExternalStore } from "react";

import { applyWindowMaterial } from "@/lib/window-material";

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

function resolve(mode: ThemeMode): "light" | "dark" {
  if (mode === "light" || mode === "dark") return mode;
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
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
  const resolved = resolve(getThemeMode());
  document.documentElement.dataset.theme = resolved;
  void applyWindowMaterial(resolved);
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
