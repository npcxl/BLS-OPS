import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { opsApi } from "@/api/ops-api";

/**
 * 把托盘菜单文案同步给 Rust（i18n 只在前端做，Rust 侧不做翻译）。
 *
 * - 挂载时同步一次（此时 i18n 已就绪，语言就是用户上次的选择）；
 * - 订阅 `languageChanged`，切换语言即重发；
 * - 非 Tauri 环境（vitest / 纯浏览器）`invoke` 会同步 throw，静默忽略。
 */
export function useTrayLabels(): void {
  const { t, i18n } = useTranslation();

  useEffect(() => {
    const sync = () => {
      try {
        void opsApi.traySetLabels(t("Show window"), t("Quit")).catch(() => undefined);
      } catch {
        // 非 Tauri 环境，无托盘可同步。
      }
    };
    sync();
    i18n.on("languageChanged", sync);
    return () => i18n.off("languageChanged", sync);
  }, [t, i18n]);
}
