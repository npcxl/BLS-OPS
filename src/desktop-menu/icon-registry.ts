/**
 * 图标跨窗口登记表。
 *
 * 菜单搬到独立 WebView 后，`ContextMenuItem.icon` 这种组件引用没法过 IPC：
 * 主窗口序列化时把组件换成**名字**，菜单窗口再按名字取回组件。两个窗口加载的
 * 是同一份 `@/components/icons`，映射天然一致。
 *
 * 名字表直接从模块命名空间生成，不手写清单：新增图标不用回来改这里。
 * 每个导出名都会被登记；同一个组件有多个别名时（Copy / ClipboardCopy），反查
 * 取第一个名字 —— 只要两个窗口用同一张表，取到哪个名字都无所谓。
 */
import * as Icons from "@/components/icons";
import type { IconComponent } from "@/components/icons";

const nameByIcon = new Map<unknown, string>();
const iconComponents = new Map<string, IconComponent>();

for (const [name, value] of Object.entries(Icons)) {
  // itshover 的动画图标是 `forwardRef` 的产物（typeof "object"），lucide 是
  // 普通函数组件（typeof "function"）—— 两种都要收。
  if (!value) continue;
  if (typeof value !== "function" && typeof value !== "object") continue;
  const icon = value as IconComponent;
  iconComponents.set(name, icon);
  if (!nameByIcon.has(icon)) nameByIcon.set(icon, name);
}

/** 组件 → 名字；未登记的图标返回 undefined（菜单项退化为无图标）。 */
export function iconNameOf(icon: unknown): string | undefined {
  if (!icon) return undefined;
  if (typeof icon !== "function" && typeof icon !== "object") return undefined;
  return nameByIcon.get(icon);
}

export function iconByName(name: string | undefined): IconComponent | undefined {
  return name ? iconComponents.get(name) : undefined;
}
