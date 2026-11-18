import { useEffect, useState } from "react";
import { Icon } from "@iconify/react";
import { useTranslation } from "react-i18next";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { cn } from "@/lib/cn";
import { WINDOW_ICONS } from "@/lib/icons/window-icons";

/**
 * Windows caption buttons — right-hand side, 最小化 / 最大化 / 关闭, close
 * hovered in red. macOS never renders this: the window keeps its native
 * decorations there (see `src-tauri/tauri.macos.conf.json`), so the traffic
 * lights stay real system controls.
 */
/**
 * 安全地拿窗口句柄。
 *
 * jsdom（组件测试）与浏览器预览里没有 Tauri 运行时，`getCurrentWindow()` 会
 * 在内部访问 `__TAURI_INTERNALS__` 时抛错。超能顶栏复用了这组按钮 —— 拿不到
 * 窗口就静默跳过，不能让整页跟着崩。
 */
function currentWindow(): ReturnType<typeof getCurrentWindow> | null {
  try {
    return getCurrentWindow();
  } catch {
    return null;
  }
}

export function WindowControls() {
  const maximized = useIsMaximized();
  const { t } = useTranslation();

  return (
    <div className="ml-auto flex items-stretch" data-tauri-drag-region="false">
      <CaptionButton
        label={t("Minimize")}
        icon={WINDOW_ICONS.minimize}
        onClick={() => void currentWindow()?.minimize()}
      />
      <CaptionButton
        label={maximized ? t("Restore") : t("Maximize")}
        icon={maximized ? WINDOW_ICONS.restore : WINDOW_ICONS.maximize}
        onClick={() => void currentWindow()?.toggleMaximize()}
      />
      <CaptionButton
        label={t("Close window")}
        icon={WINDOW_ICONS.close}
        danger
        onClick={() => void currentWindow()?.close()}
      />
    </div>
  );
}

function CaptionButton({
  label,
  icon,
  danger,
  onClick,
}: {
  label: string;
  icon: typeof WINDOW_ICONS[keyof typeof WINDOW_ICONS];
  danger?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      // The whole bar is the window drag region; without this the click is
      // swallowed by the drag handler.
      data-tauri-drag-region="false"
      onClick={onClick}
      className={cn(
        "flex h-9 w-[44px] items-center justify-center text-fg-muted transition-colors",
        danger ? "hover:bg-danger hover:text-white" : "hover:bg-surface-hover hover:text-fg",
      )}
    >
      <Icon icon={icon} width={10} height={10} aria-hidden />
    </button>
  );
}

/**
 * Maximized state is only read to swap the middle glyph — it is not persisted
 * and never blocks a click, so it starts `false` and follows window resize
 * events (which also fire on maximize / restore / snap).
 */
function useIsMaximized(): boolean {
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    const win = currentWindow();
    if (!win) return undefined;
    let alive = true;
    let unlisten: (() => void) | undefined;

    // Functional update: an unchanged value bails out without scheduling a
    // render (the initial probe resolves with the same `false`).
    const sync = () => {
      void win.isMaximized().then((value) => {
        if (alive) setMaximized((prev) => (prev === value ? prev : value));
      });
    };

    sync();
    void win.onResized(sync).then((off) => {
      if (alive) unlisten = off;
      else off();
    });

    return () => {
      alive = false;
      unlisten?.();
    };
  }, []);

  return maximized;
}
