import { useSyncExternalStore } from "react";

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

export function applyTheme() {
  document.documentElement.dataset.theme = resolve(getThemeMode());
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
