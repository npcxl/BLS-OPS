/**
 * 主窗口 ↔ 菜单窗口的桥。
 *
 * # 为什么不能直接传 `onSelect`
 *
 * 菜单内容在另一个 WebView 里渲染，函数没法序列化。所以每次打开菜单时：
 * 1. 主窗口给每个可执行项编一个 `actionId`，把回调留在本窗口的 Map 里；
 * 2. 菜单窗口只回传 `{ requestId, actionId }`；
 * 3. Rust 校验 `actionId` 属于当前菜单后转发给来源窗口；
 * 4. 主窗口比对 `requestId` —— 旧菜单的迟到事件直接丢弃，执行一次后清空映射。
 *
 * # 浏览器预览
 *
 * 没有 Tauri 时 `openDesktopMenu` 直接返回 false，调用方回退到 DOM 菜单。
 */
import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

import type { ContextMenuItem } from "@/components/ui/context-menu";
import { iconNameOf } from "./icon-registry";

/** 主面板宽度（CSS 像素）。菜单窗口按这个宽度测量，定位逻辑也用它。 */
export const MENU_WIDTH = 220;

/** 走过 IPC 的菜单项：只有数据，没有函数。 */
export interface WireMenuItem {
  id?: string;
  label?: string;
  iconName?: string;
  danger?: boolean;
  disabled?: boolean;
  separator?: boolean;
  hint?: string;
  /** 叶子项的动作 id；有 `children` 的父项没有。 */
  actionId?: string;
  children?: WireMenuItem[];
}

export interface MenuShowPayload {
  requestId: string;
  theme: "light" | "dark";
  anchor: { x: number; y: number };
  width: number;
  items: WireMenuItem[];
}

interface PendingMenu {
  requestId: string;
  handlers: Map<string, () => void>;
}

let pending: PendingMenu | null = null;
let bridgeReady: Promise<UnlistenFn[]> | null = null;

function currentTheme(): "light" | "dark" {
  return document.documentElement.dataset.theme === "dark" ? "dark" : "light";
}

/**
 * 把菜单树转成可传输结构，并把每个 `onSelect` 登记到 `handlers`。
 *
 * `actionId` 每次打开重新编号（a0、a1…）：它只在本次会话内有效，不需要和
 * 业务 id 对齐，也不怕业务 id 重复。
 */
export function toWireMenu(
  items: ContextMenuItem[],
  handlers: Map<string, () => void>,
): WireMenuItem[] {
  let next = 0;
  const walk = (list: ContextMenuItem[]): WireMenuItem[] =>
    list.map((item) => {
      if (item.separator) return { separator: true };
      const actionId = item.onSelect ? `a${next++}` : undefined;
      if (actionId && item.onSelect) handlers.set(actionId, item.onSelect);
      return {
        id: item.id,
        label: item.label,
        iconName: iconNameOf(item.icon),
        danger: item.danger,
        disabled: item.disabled,
        hint: item.hint,
        actionId,
        children: item.children?.length ? walk(item.children) : undefined,
      };
    });
  return walk(items);
}

function ensureBridge(): Promise<UnlistenFn[]> {
  if (bridgeReady) return bridgeReady;
  bridgeReady = Promise.all([
    listen<{ requestId: string; actionId: string }>("desktop-menu:select", (event) => {
      const current = pending;
      // 旧菜单（或已关闭的菜单）回传的事件不执行、也不影响新会话。
      if (!current || current.requestId !== event.payload.requestId) return;
      pending = null;
      current.handlers.get(event.payload.actionId)?.();
    }),
    listen<{ requestId: string; reason: string }>("desktop-menu:closed", (event) => {
      if (pending?.requestId === event.payload.requestId) pending = null;
    }),
  ]);
  return bridgeReady;
}

/** 应用启动后调一次：预创建隐藏的菜单窗口，第一次右键不用等 WebView 启动。 */
export function prepareDesktopMenu(): void {
  if (!isTauri()) return;
  void invoke("desktop_menu_prepare", { theme: currentTheme() }).catch(() => {
    // 预创建失败不影响右键：真正打开时会再试一次。
  });
}

/**
 * 在桌面菜单窗口里打开菜单。
 *
 * `anchor` 是来源窗口客户区坐标（CSS 像素，通常是 `event.clientX/clientY`）；
 * 换算成屏幕物理坐标、显示器工作区与翻转全部在 Rust 侧做 —— 主窗口的分辨率
 * 不是屏幕边界，这里不能自己 clamp。
 *
 * @returns 是否交给了桌面窗口（false 表示当前不是 Tauri，调用方应回退）。
 */
export async function openDesktopMenu(
  items: ContextMenuItem[],
  anchor: { x: number; y: number },
): Promise<boolean> {
  if (!isTauri()) return false;
  if (items.length === 0) return true;

  await ensureBridge();
  const handlers = new Map<string, () => void>();
  const wire = toWireMenu(items, handlers);
  const requestId = crypto.randomUUID();
  pending = { requestId, handlers };
  const payload: MenuShowPayload = {
    requestId,
    theme: currentTheme(),
    anchor,
    width: MENU_WIDTH,
    items: wire,
  };
  try {
    await invoke("desktop_menu_show", { payload });
    return true;
  } catch (error) {
    if (pending?.requestId === requestId) pending = null;
    throw error;
  }
}

