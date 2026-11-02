/**
 * 窗口材质：把网页主题同步给原生窗口，并把"实际材质"回报给 CSS。
 *
 * 分工必须清楚，否则就会出现"到处加白底压黑"：
 * - 原生（Rust `window_material`）负责桌面磨砂与窗口主题；
 * - CSS 负责染色与区域层级（`--shell` / `--content` / `--inspector`）；
 * - 前端只决定"要不要透明"以及把结果写到 `[data-material]` 上。
 *
 * 材质不可用（系统版本过低 / 系统关闭透明效果 / 浏览器预览）时，
 * `data-material="solid"` 会让外壳改用实色，文字对比度不再依赖壁纸。
 */
import { invoke, isTauri } from "@tauri-apps/api/core";
import { useSyncExternalStore } from "react";

export type WindowMaterialKind = "acrylic" | "solid";

export interface WindowMaterialState {
  material: WindowMaterialKind;
  theme: "light" | "dark";
  /** user_disabled / system_transparency_off / os_unsupported / platform_unsupported */
  reason: string | null;
  osBuild: number;
  transparency: boolean;
}

const TRANSPARENCY_KEY = "ops.window.transparency";

const listeners = new Set<() => void>();

let lastState: WindowMaterialState | null = null;

function emit() {
  for (const listener of listeners) listener();
}

/** 默认开启：磨砂是本产品的默认外观，关掉是一个需要显式选择的降级。 */
export function getWindowTransparency(): boolean {
  try {
    return localStorage.getItem(TRANSPARENCY_KEY) !== "off";
  } catch {
    return true;
  }
}

export function setWindowTransparency(enabled: boolean): void {
  try {
    localStorage.setItem(TRANSPARENCY_KEY, enabled ? "on" : "off");
  } catch {
    // 存不下不影响本次生效，只是下次启动回到默认。
  }
  // 用"上一次请求的主题"重放：当前若在"跟随系统"，这里必须继续传 system，
  // 不能拿解析后的 light/dark 顶替，否则会把窗口主题固定成具体值。
  void applyWindowMaterial(lastRequestedTheme, enabled);
  emit();
}

export function subscribeWindowTransparency(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** 设置页的开关；任何一处切换，外壳与原生材质同时跟随。 */
export function useWindowTransparency(): [boolean, (enabled: boolean) => void] {
  const enabled = useSyncExternalStore(
    subscribeWindowTransparency,
    getWindowTransparency,
    getWindowTransparency,
  );
  return [enabled, setWindowTransparency];
}

/** 请求的主题："system" 由原生侧读系统设置解析，不能被前端猜。 */
export type ThemeRequest = "light" | "dark" | "system";

/** 最近一次请求的主题，切透明度时据此重放（见 `setWindowTransparency`）。 */
let lastRequestedTheme: ThemeRequest = "system";

/**
 * 浏览器媒体查询里的系统深浅。
 *
 * 只能在"窗口主题没有被自己固定过"时代表系统 —— Tauri 里真正的系统值由 Rust
 * 读注册表，见 `applyWindowMaterial("system")`。
 */
export function systemMediaTheme(): "light" | "dark" {
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function writeState(state: WindowMaterialState): void {
  const root = document.documentElement;
  root.dataset.material = state.material;
  if (state.reason) root.dataset.materialReason = state.reason;
  else delete root.dataset.materialReason;
  lastState = state;
  emit();
}

/** 最近一次应用结果；设置页据此说明"为什么没有磨砂"。 */
export function getWindowMaterialState(): WindowMaterialState | null {
  return lastState;
}

/** 订阅窗口材质结果（原生应用完成后才会更新）。 */
export function useWindowMaterial(): WindowMaterialState | null {
  return useSyncExternalStore(
    subscribeWindowTransparency,
    getWindowMaterialState,
    () => null,
  );
}

/**
 * 应用一次材质。失败不抛：窗口材质是**增强**，不是功能依赖；
 * 出错时按实色处理，界面仍然可读。
 */
export async function applyWindowMaterial(
  theme: ThemeRequest,
  transparency = getWindowTransparency(),
): Promise<WindowMaterialState> {
  lastRequestedTheme = theme;
  // 浏览器预览没有原生窗口可问，只能按媒体查询落地（Tauri 里由 Rust 读系统设置）。
  const resolved = theme === "system" ? systemMediaTheme() : theme;
  if (!isTauri()) {
    const fallback: WindowMaterialState = {
      material: "solid",
      theme: resolved,
      reason: "platform_unsupported",
      osBuild: 0,
      transparency: false,
    };
    writeState(fallback);
    return fallback;
  }
  try {
    const state = await invoke<WindowMaterialState>("app_window_material", {
      theme,
      transparency,
    });
    writeState(state);
    return state;
  } catch {
    const fallback: WindowMaterialState = {
      material: "solid",
      theme: resolved,
      reason: "apply_failed",
      osBuild: 0,
      transparency: false,
    };
    writeState(fallback);
    return fallback;
  }
}
