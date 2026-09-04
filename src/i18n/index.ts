/**
 * i18n 初始化 —— **同步**加载全部语言包（每个都是几 KB 的小文件，静态
 * import 让"切换语言"零等待、也避免首屏出现未翻译闪烁）。
 *
 * 动态刷新链路（用户裁决，勿回退）：
 * ```
 * changeLocale("zh-CN")
 *   → localStorage 持久化
 *   → i18next.changeLanguage()（事件广播）
 *   → 所有 useTranslation() 订阅的组件**自动重渲染** —— 无需重启、无需刷新
 * ```
 *
 * 两种使用方式：
 * - React 组件：`const { t } = useTranslation();`（响应式，语言切换即重渲染）
 * - 纯 TS 模块（错误消息工厂、store 里的提示语…）：`import { i18n } from "@/i18n"`
 *   然后 `i18n.t("...")` —— 非订阅式，但调用点在组件渲染期间执行时同样
 *   拿到当前语言。
 */

import i18next, { type i18n as I18n } from "i18next";
import { initReactI18next } from "react-i18next";

import {
  DEFAULT_LOCALE,
  LOCALE_STORAGE_KEY,
  isLocaleCode,
  type LocaleCode,
} from "./locales";
import zhCN from "./locales/zh-CN";
import zhTW from "./locales/zh-TW";
import ja from "./locales/ja";
import ko from "./locales/ko";
import es from "./locales/es";
import fr from "./locales/fr";
import de from "./locales/de";
import ru from "./locales/ru";
import ptBR from "./locales/pt-BR";

export { LOCALES, DEFAULT_LOCALE, localeLabel, type LocaleCode } from "./locales";

/**
 * natural keys：`en` 的资源**刻意为空** —— key 即英文文案，找不到时
 * i18next 返回 key 本身。这省掉一整份英文包的维护（措辞改 key 就行）。
 */
const resources: Record<string, { translation: Record<string, string> }> = {
  en: { translation: {} },
  "zh-CN": { translation: zhCN },
  "zh-TW": { translation: zhTW },
  ja: { translation: ja },
  ko: { translation: ko },
  es: { translation: es },
  fr: { translation: fr },
  de: { translation: de },
  ru: { translation: ru },
  "pt-BR": { translation: ptBR },
};

function storedLocale(): LocaleCode {
  try {
    const value = localStorage.getItem(LOCALE_STORAGE_KEY);
    return value && isLocaleCode(value) ? value : DEFAULT_LOCALE;
  } catch {
    // localStorage 不可用（极端 WebView 配置）→ 默认英文，不致命。
    return DEFAULT_LOCALE;
  }
}

/** 顶层同步初始化：任何组件渲染之前就绪，没有异步空窗。 */
export const i18n: I18n = i18next.createInstance();

void i18n.use(initReactI18next).init({
  resources,
  lng: storedLocale(),
  fallbackLng: "en",
  // React 已经转义插值，i18next 不再转义（否则会二次转义成 &amp;）。
  interpolation: { escapeValue: false },
  // 空翻译按"未翻译"处理，回退到英文而不是渲染空串。
  returnEmptyString: false,
  // natural keys：未命中时 i18next 默认就返回 key 本身（英文界面即 key 文案），
  // 且**仍会做插值**。切勿配置 parseMissingKeyHandler: (key) => key —— 它的返回值
  // 会覆盖已插值的结果，英文界面会把 "{{host}}" 这样的占位符原样显示出来。
});

/** 切换语言：持久化 + 广播。返回 promise 仅为 API 兼容，UI 无需 await。 */
export function changeLocale(code: LocaleCode): void {
  try {
    localStorage.setItem(LOCALE_STORAGE_KEY, code);
  } catch {
    // 存不进去就用当前会话的语言（下次启动回默认），别打断切换。
  }
  document.documentElement.lang = code;
  void i18n.changeLanguage(code);
}

// 启动时同步一次 <html lang>（无障碍 + 浏览器翻译插件提示）。
document.documentElement.lang = i18n.language;
