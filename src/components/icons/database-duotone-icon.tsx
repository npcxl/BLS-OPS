/**
 * 双色（duotone）数据库图标 —— 手写 SVG，itshover / lucide 均无同风格图形。
 *
 * 来源：andrsrxn--database.svg（24×24 duotone 风格：半透明色块底 + 描边线框），
 * 颜色走 currentColor，可随 text-* 类 / color prop 换色。
 * 从全局入口 `@/components/icons` 以 DatabaseDuotone / DatabaseDuotoneIcon 使用。
 */
import type { AnimatedIconProps } from "@/components/its-hover";

export function DatabaseDuotoneIcon({
  size = 24,
  color = "currentColor",
  strokeWidth = 1.5,
  className,
  ...rest
}: AnimatedIconProps) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke={color}
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden
      {...rest}
    >
      <g fill="none">
        <ellipse
          cx="12"
          cy="5.23"
          fill="currentColor"
          stroke="none"
          opacity=".2"
          rx="8.88"
          ry="3.44"
          transform="rotate(-180 12 5.23)"
        />
        <path d="M20.88 5.23v13.73" />
        <path
          fill="currentColor"
          stroke="none"
          d="M3.25 16.32c0-1.15 0-1.72.38-2.02c.37-.3.93-.18 2.04.06l5.95 1.27c.21.05.31.07.42.07s.21-.02.42-.06l6.02-1.28c1.12-.24 1.68-.36 2.05-.06s.37.87.37 2.01v2.19c0 .75 0 1.13-.22 1.4c-.2.27-.58.36-1.3.54l-6.86 1.68c-.24.05-.36.08-.48.08s-.24-.03-.48-.09l-6.78-1.67c-.73-.18-1.1-.27-1.31-.54c-.22-.27-.22-.65-.22-1.4z"
          opacity=".2"
        />
        <ellipse
          cx="12"
          cy="5.23"
          rx="8.88"
          ry="3.44"
          transform="rotate(-180 12 5.23)"
        />
        <path d="M3.12 11.95c0 1.87 3.98 3.38 8.88 3.38s8.88-1.51 8.88-3.38" />
        <path d="M6.06 11.3c.4.26 1.15.59 2.2.8c1.17.22 1.74.25 2.67.25m-4.87 5.31c.4.25 1.15.58 2.2.79c1.17.23 1.74.26 2.67.26m-7.81.12c0 1.87 3.98 3.38 8.88 3.38s8.88-1.51 8.88-3.38M3.12 5.23v13.38" />
      </g>
    </svg>
  );
}
