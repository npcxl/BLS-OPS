import { useEffect, useState, type ReactElement, type ReactNode } from "react";
import GlassIconsSource from "@/components/ui/glass-icons";

/** 第三方组件内部是 `@ts-nocheck`，这里补一个显式的宽松签名。 */
const GlassIcons = GlassIconsSource as unknown as (
  props: Record<string, unknown>,
) => ReactElement;

/** 简洁的向下箭头（不是下载图标）。 */
export function ScrollDownIcon({ size = 18 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M12 4v14" />
      <path d="m6 12 6 6 6-6" />
    </svg>
  );
}

/**
 * 单枚 Glass Icons 按钮的封装。
 *
 * 参数取 ReactBits 的 Clear 预设：无底板、圆角拉满、轻折射 + 少量色散，
 * 只保留一层很淡的磨砂与白色图标。`size` 按实际场景传入（默认 44），
 * 其余视觉参数与官网配置一致。
 */
export function GlassIconButton({
  label,
  onClick,
  size = 44,
  icon,
}: {
  label: string;
  onClick?: () => void;
  size?: number;
  icon?: ReactNode;
}) {
  /* 跟随应用实际主题：浅色用黑图标，深色用白图标。 */
  const [theme, setTheme] = useState<"light" | "dark">("dark");
  useEffect(() => {
    const root = document.documentElement;
    const sync = () => setTheme(root.dataset.theme === "light" ? "light" : "dark");
    sync();
    const observer = new MutationObserver(sync);
    observer.observe(root, { attributes: true, attributeFilter: ["data-theme"] });
    return () => observer.disconnect();
  }, []);

  return (
    <GlassIcons
      theme={theme}
      iconColor={theme === "light" ? "#111111" : "#ffffff"}
      items={[
        {
          id: "glass-icon",
          label,
          icon: icon ?? <ScrollDownIcon />,
          onClick,
        },
      ]}
      size={size}
      gap={0}
      columns={1}
      roundness={1}
      refraction={0.9}
      bevel={0.6}
      dispersion={0.6}
      frost={0.15}
      shine={0.85}
      tint="#dfdfdf"
      tintOpacity={0.06}
      plate="none"
      hover="press"
      labels="none"
      intro
      parallax={1}
    />
  );
}
