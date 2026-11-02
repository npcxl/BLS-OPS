import type { ReactNode } from "react";
import LiquidGlass from "liquid-glass-react";
import { ChevronRight } from "@/components/icons";
import type { ContextMenuItem } from "@/components/ui/context-menu";
import { cn } from "@/lib/cn";

/**
 * 菜单玻璃表面 —— 主菜单与子菜单共用，保证材质、描边、圆角、阴影、
 * 选中态与危险态在两层之间完全一致。
 *
 * # 分层（下 → 上）
 * 1. `LiquidGlass` 的 `.glass__warp`：背景模糊 + 边缘折射；
 * 2. `.menu-surface__tint`：主题染色的浅色/深色表面 + 描边 + 顶部高光；
 * 3. `.menu-surface__content`：菜单项与文字。
 *
 * 染色层放在库的内容层内部（`inset: 0`），因此一定覆盖整块面板，
 * 又不会被库的 warp 盖住；它只做装饰，`pointer-events: none`。
 *
 * # 库参数的真实含义（liquid-glass-react 1.1.1）
 * - `blurAmount` **不是像素**：实际 `backdrop-filter: blur((overLight ? 12 : 4) + blurAmount * 32)px`。
 *   这里要 16px 量级的模糊，让背后的表格/侧栏文字退化成柔和色块（0.4 → 16.8px）。
 * - `displacementScale` 是 `feDisplacementMap` 的 scale，位移幅度约 ±scale/2 px。
 *   70 是给胶囊按钮的默认值，铺满整块菜单会把背景文字撕成条（24 → 约 ±12px）。
 * - `aberrationIntensity` 同时决定三通道偏移（scale × 0.05 / 0.1）和边缘遮罩宽度；
 *   2 在整块面板上会出现明显的彩边（1 → 只在最外缘留一点色散）。
 * - `saturation` 是 `backdrop-filter: saturate()` 的百分比。
 * - `elasticity` 的位移/缩放会被 `.glass-host > * { transform: none }` 收掉，
 *   菜单不跟鼠标"晃"，这里保留库默认值即可。
 */
export const MENU_SURFACE_RADIUS = 12;

/** 面板内边距：菜单项自己带高度，四边只留一层薄边。 */
const MENU_SURFACE_PADDING = "p-1";

interface MenuSurfaceProps {
  children: ReactNode;
  className?: string;
  radius?: number;
  /**
   * 独立菜单窗口用 `flat`：那里没有主窗口的 DOM 可以采样，liquid-glass 的
   * 位移/折射层只会把桌面背景撕成色带。玻璃改由「原生 Acrylic + 染色层」
   * 组成（见 `.menu-surface--flat`），视觉令牌与页面内菜单同源。
   */
  flat?: boolean;
}

export function MenuSurface({
  children,
  className,
  radius = MENU_SURFACE_RADIUS,
  flat = false,
}: MenuSurfaceProps) {
  const body = (
    <div className="menu-surface__body">
      <span
        aria-hidden="true"
        data-menu-tint=""
        className="menu-surface__tint"
        style={{ borderRadius: radius }}
      />
      <div className={cn("menu-surface__content", MENU_SURFACE_PADDING)}>{children}</div>
    </div>
  );

  if (flat) {
    return (
      <div
        className={cn("menu-surface menu-surface--flat", className)}
        style={{ borderRadius: radius }}
      >
        {body}
      </div>
    );
  }

  return (
    <div className={cn("glass-host menu-surface", className)}>
      <LiquidGlass
        cornerRadius={radius}
        padding="0"
        displacementScale={24}
        blurAmount={0.4}
        saturation={120}
        aberrationIntensity={1}
        elasticity={0.15}
        className="menu-surface__glass"
      >
        {body}
      </LiquidGlass>
    </div>
  );
}

/** 分隔线：主菜单与子菜单共用同一条，避免两边颜色/间距漂移。 */
export function MenuSeparator() {
  return <div className="my-1 h-px bg-line" role="separator" />;
}

interface MenuItemRowProps {
  item: ContextMenuItem;
  highlighted: boolean;
  /** 该行是否有子菜单（只有主菜单的一级项会为 true）。 */
  hasChildren?: boolean;
  /** 子菜单当前是否正属于这一行（aria-expanded + 右侧箭头的高亮）。 */
  submenuOpen?: boolean;
  /** 主菜单需要它来把子菜单位置锚到行上；子菜单不需要。 */
  buttonRef?: (node: HTMLButtonElement | null) => void;
  /**
   * 整个菜单是否使用图标列。
   *
   * 只有当**至少一项**带图标时才为 true —— 否则不要给每行留一个 14px 的空
   * 图标位：那会把文字整体推右，左侧出现一条毫无意义的空白（很丑）。
   */
  showIconColumn?: boolean;
  onPointerEnter: () => void;
  onClick: () => void;
}

/**
 * 一行菜单项。选中是"一层薄膜"（`bg-menu-item-active`），不是实心色块；
 * 危险项整行文字/图标/左缘指示条都走 danger 色。
 *
 * 无图标的菜单（如连接/数据库的右键菜单）：文字**居中**、左右留白对称，
 * 不再偏左留空洞。
 */
export function MenuItemRow({
  item,
  highlighted,
  hasChildren = false,
  submenuOpen = false,
  buttonRef,
  showIconColumn = true,
  onPointerEnter,
  onClick,
}: MenuItemRowProps) {
  const Icon = item.icon;
  const iconSlot = showIconColumn || Boolean(Icon);

  return (
    <button
      ref={buttonRef}
      type="button"
      role="menuitem"
      aria-haspopup={hasChildren || undefined}
      aria-expanded={hasChildren ? submenuOpen : undefined}
      data-submenu-open={hasChildren && submenuOpen ? "true" : undefined}
      disabled={item.disabled}
      className={cn(
        "relative my-0.5 flex h-8 w-full cursor-default items-center rounded-[8px] gap-2 pl-3 pr-2 text-12 select-none transition-colors",
        !iconSlot && "justify-center gap-0 px-3",
        item.danger ? "text-danger" : highlighted ? "text-accent" : "text-fg",
        // 选中是"一层薄膜"，不是纯文字变色：亮/暗两套底色见 tokens。
        highlighted && (item.danger ? "bg-danger/10" : "bg-menu-item-active"),
        item.disabled && "pointer-events-none opacity-40",
      )}
      onPointerEnter={onPointerEnter}
      onClick={onClick}
    >
      {/* 左缘指示条：危险项跟着走 danger 色，别在红色文字旁边挂一条蓝杠 */}
      <span
        aria-hidden="true"
        className={cn(
          "pointer-events-none absolute left-0 top-1/2 h-4 w-[3px] -translate-y-1/2 rounded-r-full transition-opacity duration-150",
          item.danger ? "bg-danger" : "bg-accent",
          highlighted ? "opacity-100" : "opacity-0",
        )}
      />
      {Icon ? (
        <Icon
          size={14}
          strokeWidth={1.75}
          className={cn(
            "shrink-0",
            item.danger ? "text-danger/80" : highlighted ? "text-accent" : "text-fg-subtle",
          )}
        />
      ) : showIconColumn ? (
        <span className="w-[14px] shrink-0" />
      ) : null}
      <span
        className={cn(
          "min-w-0 truncate",
          iconSlot ? "flex-1 text-left" : "flex-1 text-center",
        )}
      >
        {item.label}
      </span>
      {item.hint && <span className="shrink-0 text-10 text-fg-subtle">{item.hint}</span>}
      {hasChildren && (
        <ChevronRight
          size={12}
          strokeWidth={1.75}
          aria-hidden="true"
          className="shrink-0 text-fg-subtle"
        />
      )}
    </button>
  );
}
