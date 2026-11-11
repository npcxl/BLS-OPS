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
import en from "./locales/en";
import zhCN from "./locales/zh-CN";

export { LOCALES, DEFAULT_LOCALE, localeLabel, type LocaleCode } from "./locales";

/**
 * natural keys：大部分 `t()` 的 key 就是英文文案，`en` 不需要条目 ——
 * 找不到时 i18next 原样返回 key。
 *
 * 例外是数据库工作台：那里的 `t("已打开")` 之类直接用了中文当 key，
 * 英文界面会漏出中文。`locales/en/*` 专门为这类 key 提供英文，未覆盖的
 * 仍旧回退到 key（中文），可以逐步补齐。
 *
 * 只保留中文（简体）与英文：其余语言目录已移除，避免半翻译状态。
 */
const resources: Record<string, { translation: Record<string, string> }> = {
  en: { translation: en },
  "zh-CN": { translation: zhCN },
};

/**
 * 首次启动的默认语言：按**使用者所在地区**推断。
 *
 * 桌面端不请求外部 IP 服务：CSP 不允许 `connect-src` 外连，离线时也不该卡在
 * 一个 HTTP 请求上，而且把用户 IP 发给第三方本身不合适。这里用系统语言偏好 +
 * 时区兜底，效果等价（中国大陆/港澳台的机器几乎都是 `zh-CN` 环境）：
 *
 * 1. `navigator.language` / `navigator.languages` 里有 `zh*` → 中文；
 * 2. 时区落在大中华区（上海/重庆/哈尔滨/乌鲁木齐/香港/澳门/台北）→ 中文；
 * 3. 其余 → 英文。
 *
 * 用户在设置里手动切换过一次后，`localStorage` 优先，不再走这条推断。
 */
function detectLocale(): LocaleCode {
  /*
   * 单测固定英文：happy-dom 会继承开发机的系统语言，断言（`toBe("Unknown error")`
   * 之类）就会随机器语言飘。测试要验证的是"英文 natural key 能出英文"，
   * 不该被地区推断影响。
   */
  if (import.meta.env.MODE === "test") return DEFAULT_LOCALE;
  try {
    const tags = [navigator.language, ...(navigator.languages ?? [])];
    if (tags.some((tag) => tag?.toLowerCase().startsWith("zh"))) return "zh-CN";
  } catch {
    // 没有 navigator（极端环境）→ 继续用时区判断。
  }
  try {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone ?? "";
    if (/^Asia\/(Shanghai|Chongqing|Harbin|Urumqi|Hong_Kong|Macau|Taipei)$/i.test(zone)) {
      return "zh-CN";
    }
  } catch {
    // ignore
  }
  return DEFAULT_LOCALE;
}

function storedLocale(): LocaleCode {
  try {
    const value = localStorage.getItem(LOCALE_STORAGE_KEY);
    return value && isLocaleCode(value) ? value : detectLocale();
  } catch {
    // localStorage 不可用（极端 WebView 配置）→ 按地区推断，不致命。
    return detectLocale();
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
