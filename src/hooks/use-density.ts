import { useSyncExternalStore } from "react";

/**
 * UI density — one root-level variant, not per-page paddings.
 *
 * `data-density="compact"` switches the `--page-*` tokens in `pages.css`;
 * every page using the shared skeleton follows without extra props.
 */

export type DensityMode = "comfortable" | "compact";

const STORAGE_KEY = "ops.density";
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

export function getDensityMode(): DensityMode {
  return localStorage.getItem(STORAGE_KEY) === "compact" ? "compact" : "comfortable";
}

export function applyDensity() {
  const mode = getDensityMode();
  document.documentElement.dataset.density = mode;
}

export function setDensityMode(mode: DensityMode) {
  localStorage.setItem(STORAGE_KEY, mode);
  applyDensity();
  emit();
}

export function subscribeDensity(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function initDensity() {
  applyDensity();
  window.addEventListener("storage", (event) => {
    if (event.key !== STORAGE_KEY) return;
    applyDensity();
    emit();
  });
}

export function useDensityMode(): [DensityMode, (mode: DensityMode) => void] {
  const mode = useSyncExternalStore(subscribeDensity, getDensityMode, getDensityMode);
  return [mode, setDensityMode];
}
