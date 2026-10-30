/**
 * OverlayManager —— 全项目浮层层级的**唯一真源**。
 *
 * # 为什么需要它
 *
 * 以前每个浮层各写一个魔法数字（modal `z-[130]`、toast 也是 `z-[130]`、
 * select `z-[150]`、右键菜单 `z-[200]`…）。两个后果：
 * 1. 同层的 toast 和 modal 谁压谁取决于 DOM 顺序 —— 弹窗打开时错误提示被
 *    遮罩盖住，或者反过来盖住整个弹窗；
 * 2. 每个 Modal 各自在 window 上挂 Esc 监听，嵌套弹窗（文件编辑器 → 版本
 *    冲突）按一次 Esc 会把两层一起关掉。
 *
 * # 层级怎么算
 *
 * 深度来自 **React 上下文**（`OverlayDepthContext`），不是 DOM 顺序、也不是
 * 谁先调用登记：
 * - React 的子组件 effect 先于父组件执行，按"登记顺序"算会把父层当成最上层；
 * - portal 的 DOM 顺序同样不可靠（实测内层 portal 反而先插到 body 里）。
 *
 * 上下文沿组件树传递，portal 也不例外，所以"谁是内层"是确定的。
 */

import { createContext, useContext, useEffect, useRef } from "react";

/** 各类浮层的绝对层级。数字之间留空档，方便局部微调。 */
export const OVERLAY_Z = {
  /** 行内弹出层：下拉、自动补全、工具条浮层。 */
  popover: 120,
  /** 模态框基准层；每嵌套一层 +2，同屏最多 8 层。 */
  modal: 130,
  /** 表单里的下拉必须盖住所在弹窗。 */
  select: 160,
  /** 右键菜单 / 工具栏「⋯」菜单。 */
  menu: 200,
  /** 二级菜单，永远在父菜单之上。 */
  submenu: 210,
  /** 提示气泡压在最上面的菜单之上（否则菜单里的 tooltip 会被裁掉）。 */
  tooltip: 220,
  /** 全局命令面板：从任何页面唤起，必须盖住普通弹窗。 */
  commandPalette: 230,
  /** 启动画面：盖住一切页面内容，但让位给通知（启动失败要看得见）。 */
  splash: 235,
  /**
   * 通知（toast）。**必须高于模态框**：错误提示是应用的主要错误通道，
   * 保存失败时哪怕弹窗还开着，用户也得看得见。
   */
  toast: 240,
} as const;

/** 嵌套深度上限：再深也不会顶到菜单层。 */
const MAX_DEPTH = 8;

/** 打开中的浮层：id → 深度。Map 的插入顺序即注册顺序（同深度时后来者在上）。 */
const layers = new Map<string, number>();

/** 当前浮层所处的嵌套深度（0 = 页面根层）。portal 也跟随组件树。 */
export const OverlayDepthContext = createContext(0);

/** 打开一个浮层。同一 id 重复打开会刷新到栈顶。 */
export function pushOverlayLayer(id: string, depth = 0): void {
  layers.delete(id);
  layers.set(id, depth);
}

/** 关闭一个浮层。重复调用安全。 */
export function popOverlayLayer(id: string): void {
  layers.delete(id);
}

/** 该浮层的嵌套深度。 */
export function overlayLayerDepth(id: string): number {
  return layers.get(id) ?? 0;
}

/**
 * 当前是否是最上层的浮层 —— Esc、关闭类快捷键只在最上层生效。
 *
 * 深度最大的那个在上；同深度则是后打开的那个（右键菜单压住它所在的弹窗）。
 */
export function isTopOverlayLayer(id: string): boolean {
  let topId: string | null = null;
  let topDepth = -1;
  for (const [key, depth] of layers) {
    if (depth >= topDepth) {
      topDepth = depth;
      topId = key;
    }
  }
  return topId === id;
}

/** 最上层浮层的 id，没有则为 null。 */
export function topOverlayLayer(): string | null {
  let topId: string | null = null;
  let topDepth = -1;
  for (const [key, depth] of layers) {
    if (depth >= topDepth) {
      topDepth = depth;
      topId = key;
    }
  }
  return topId;
}

/** 有浮层打开时，全局快捷键应当让路（输入/关闭类快捷键尤其）。 */
export function hasOpenOverlay(): boolean {
  return layers.size > 0;
}

/** 按嵌套深度计算模态框的 z-index。 */
export function modalZIndex(depth: number): number {
  return OVERLAY_Z.modal + Math.min(Math.max(depth, 0), MAX_DEPTH) * 2;
}

/**
 * 浮层组件的统一挂载钩子。
 *
 * 返回自身深度、该用的 z-index，以及一个供子浮层使用的上下文值：
 * 在浮层内部渲染的另一个浮层，深度自动 +1，永远压在上面。
 */
export function useOverlayLayer(open: boolean, prefix: string) {
  const parentDepth = useContext(OverlayDepthContext);
  const depth = parentDepth + 1;
  const idRef = useRef("");
  if (!idRef.current) idRef.current = `${prefix}-${Math.random().toString(36).slice(2)}`;

  useEffect(() => {
    if (!open) return;
    const id = idRef.current;
    pushOverlayLayer(id, depth);
    return () => popOverlayLayer(id);
  }, [open, depth]);

  return {
    id: idRef.current,
    depth,
    zIndex: modalZIndex(depth),
    /** 包在 children 外层，让内部浮层继续往上叠。 */
    childDepth: depth,
  };
}
