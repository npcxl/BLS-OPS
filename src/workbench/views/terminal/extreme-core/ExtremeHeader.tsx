import { useCallback, useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useTranslation } from "react-i18next";
import {
  ChevronLeft,
  History,
  Languages,
  Monitor,
  Moon,
  PanelRight,
  Pin,
  PinOff,
  Sun,
} from "@/components/icons";
import ElectricLogo from "@/components/reactbits/ElectricLogo";
import { Select } from "@/components/ui/select";
import { cn } from "@/lib/cn";
import { useIsDarkTheme, useThemeMode, type ThemeMode } from "@/hooks/use-theme";
import type { LocaleCode } from "@/i18n";
import { useLocale } from "@/i18n/use-locale";
import { PageToolbar } from "@/workbench/page-layout";
import { WindowControls } from "@/workbench/window-controls";
import { ToolbarIcon } from "@/workbench/views/terminal/ToolbarIcon";

/**
 * 安全地拿当前窗口句柄。
 *
 * 浏览器预览与 jsdom 里没有 Tauri 运行时，`getCurrentWindow()` 会在内部
 * 访问 `__TAURI_INTERNALS__` 时抛错 —— 拿不到就当"没有窗口"，置顶按钮
 * 只是点不动，不能让整个顶栏跟着崩。
 */
function currentWindow(): ReturnType<typeof getCurrentWindow> | null {
  try {
    return getCurrentWindow();
  } catch {
    return null;
  }
}

/**
 * 窗口置顶开关。
 *
 * 初值从窗口本身读（`isAlwaysOnTop`），不是本地臆断 —— 上次关窗前置顶过、
 * 或者用户用系统快捷键切过，重新进来时按钮要和真实状态一致。
 */
function useAlwaysOnTop(): [boolean, () => void] {
  const [onTop, setOnTop] = useState(false);

  useEffect(() => {
    const win = currentWindow();
    // 窗口对象在测试替身里不一定带这一对方法 —— 缺了就当作"不支持置顶"，
    // 顶栏照常渲染，不要整页跟着报错。
    if (!win || typeof win.isAlwaysOnTop !== "function") return undefined;
    let alive = true;
    void win
      .isAlwaysOnTop()
      .then((value) => {
        if (alive && typeof value === "boolean") setOnTop(value);
      })
      .catch(() => {
        // 少数平台不提供查询：保持"未置顶"就够了，不必打扰用户。
      });
    return () => {
      alive = false;
    };
  }, []);

  const toggle = useCallback(() => {
    setOnTop((current) => {
      const next = !current;
      const win = currentWindow();
      if (win && typeof win.setAlwaysOnTop === "function") {
        void win.setAlwaysOnTop(next).catch(() => {});
      }
      return next;
    });
  }, []);

  return [onTop, toggle];
}

/** 顶栏底色深，随机色固定饱和度/亮度只换色相，免得抽到看不清的近黑色。 */
function randomLogoColor(): string {
  const hue = Math.random() * 360;
  const s = 0.85;
  const l = 0.6;
  const k = (n: number) => (n + hue / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  const to = (v: number) => Math.round(255 * v).toString(16).padStart(2, "0");
  return `#${to(f(0))}${to(f(8))}${to(f(4))}`;
}

/**
 * 超能模式 LOGO：官方 ElectricLogo 实时描出应用图标，颜色每 10 秒随机换一次。
 *
 * 动画参数与 React Bits 面板一致；canvas 内的颜色本来就带插值过渡，
 * 换色时是渐变过去的，不会闪一下。
 */
function ExtremeLogoMark() {
  const isDark = useIsDarkTheme();
  const [color, setColor] = useState("#3b82f6");

  useEffect(() => {
    const timer = setInterval(() => setColor(randomLogoColor()), 10000);
    return () => clearInterval(timer);
  }, []);

  return (
    <span data-tauri-drag-region="false" className="pointer-events-none relative block h-8 w-8 shrink-0">
      <ElectricLogo
        src="/logo.png"
        color={color}
        glowColor={color}
        scale={0.8}
        intensity={0.5}
        glow={0.65}
        fill={0}
        thickness={0.5}
        strands={6}
        bend={0.45}
        crackle={0.95}
        arcs={0.85}
        flicker={0.5}
        speed={2.4}
        interactive={false}
        cursorIntensity={0.75}
        cursorRadius={100}
        theme={isDark ? "dark" : "light"}
      />
    </span>
  );
}

export interface ExtremeHeaderProps {
  server: string | null;
  serverHost: string | null;
  /** Windows 用三个窗口按钮贴右边缘；macOS 让开原生红绿灯。 */
  mac: boolean;
  /** 回退到普通终端（SSH 会话与草稿都保留）。 */
  onBack: () => void;
  /** 右栏收起时，标题栏提供恢复入口。 */
  paneShown: boolean;
  onOpenPane: () => void;
  /** 任务历史浮层。 */
  onOpenHistory: () => void;
}

/**
 * 超能顶栏。
 *
 * 与其他页面共用 `PageToolbar` 的尺寸 token；差别只有右侧要放窗口按钮
 * （超能盖住了应用标题栏）。
 */
export function ExtremeHeader({
  server,
  serverHost,
  mac,
  onBack,
  paneShown,
  onOpenPane,
  onOpenHistory,
}: ExtremeHeaderProps) {
  const { t } = useTranslation();
  /** 主题：跟随系统 / 浅色 / 深色，与设置页同一个 store，改一边另一边跟着变。 */
  const [themeMode, setThemeMode] = useThemeMode();
  const { locale, locales, setLocale } = useLocale();
  const [onTop, toggleOnTop] = useAlwaysOnTop();

  const themeOptions = [
    {
      value: "system",
      label: t("Follow system"),
      icon: <Monitor size={13} strokeWidth={1.75} />,
    },
    { value: "light", label: t("Light"), icon: <Sun size={13} strokeWidth={1.75} /> },
    { value: "dark", label: t("Dark"), icon: <Moon size={13} strokeWidth={1.75} /> },
  ];

  return (
    <PageToolbar
      data-tauri-drag-region
      className={cn("extreme-core-header extreme-core-frosted relative z-20", mac ? "pl-[76px] pr-0" : "pr-0")}
    >
      <div className="page-toolbar-summary flex min-w-0 items-center gap-2 text-12" data-tauri-drag-region>
        {/* 超能模式专属标识；点击穿透给整条拖拽栏。 */}
        <ExtremeLogoMark />
        <span className="truncate font-medium" title={server ?? undefined}>
          {server ?? t("未绑定服务器")}
        </span>
        {serverHost && serverHost !== server && (
          <span className="truncate font-mono text-11 text-fg-subtle" title={serverHost}>
            {serverHost}
          </span>
        )}
      </div>
      <div className="ml-auto flex items-center gap-1" data-tauri-drag-region="false">
        <Select
          variant="menu"
          iconOnly
          className="shrink-0"
          value={themeMode}
          ariaLabel={t("Theme")}
          testId="extreme-theme-select"
          menuMinWidth={148}
          options={themeOptions}
          onChange={(next) => setThemeMode(next as ThemeMode)}
        />
        <Select
          variant="menu"
          iconOnly
          className="shrink-0"
          value={locale}
          ariaLabel={t("Language")}
          testId="extreme-locale-select"
          menuMinWidth={148}
          options={locales.map((item) => ({
            value: item.code,
            label: item.native,
            icon: <Languages size={13} strokeWidth={1.75} />,
          }))}
          onChange={(next) => setLocale(next as LocaleCode)}
        />
        <ToolbarIcon
          label={t("Always on top of other windows")}
          icon={onTop ? PinOff : Pin}
          active={onTop}
          onClick={toggleOnTop}
        />
        {!paneShown && (
          <ToolbarIcon label={t("远程工作区")} icon={PanelRight} onClick={onOpenPane} />
        )}
        <ToolbarIcon label={t("任务历史")} icon={History} onClick={onOpenHistory} />
        <ToolbarIcon label={t("返回普通终端，会话与任务都保留")} icon={ChevronLeft} onClick={onBack} />
        {!mac && <WindowControls />}
      </div>
    </PageToolbar>
  );
}
