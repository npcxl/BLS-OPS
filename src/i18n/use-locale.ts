import { useTranslation } from "react-i18next";

import { changeLocale, LOCALES, type LocaleCode } from "./index";

/**
 * 语言切换的唯一入口（设置页用）。
 *
 * `changeLocale` 触发 `i18next.changeLanguage`，所有 `useTranslation()` 的
 * 组件**自动重渲染** —— 这就是"动态刷新"：切换即时生效，无需重启应用、
 * 无需刷新页面。语言偏好持久化在 `localStorage`（键见 `LOCALE_STORAGE_KEY`）。
 */
export function useLocale() {
  const { i18n } = useTranslation();
  const locale = (i18n.resolvedLanguage ?? i18n.language) as LocaleCode;

  return {
    locale,
    locales: LOCALES,
    setLocale: changeLocale,
  };
}
