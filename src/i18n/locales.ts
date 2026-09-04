/**
 * 语言清单 —— **唯一定义"这个应用支持哪些语言"的地方**。
 *
 * 策略（2026-09-04 定稿）：
 * - **natural keys**：key 就是英文文案本身（`t("Connect")`），所以 `en`
 *   不需要翻译资源 —— 找不到 key 时 i18next 原样返回 key，界面即英文。
 * - `zh-CN` 必须**全量**（主用户是中文）；其余语言尽力覆盖，缺的条目
 *   由 `fallbackLng: "en"` 兜底 —— 界面永远不出现裸 key。
 * - 每个语言一个目录（`locales/<code>/`），目录内按模块分文件 ——
 *   语言文件**单独做，不要都堆在一个文件里**（用户裁决）。
 */

export const LOCALES = [
  { code: "en", english: "English", native: "English" },
  { code: "zh-CN", english: "Chinese (Simplified)", native: "简体中文" },
  { code: "zh-TW", english: "Chinese (Traditional)", native: "繁體中文" },
  { code: "ja", english: "Japanese", native: "日本語" },
  { code: "ko", english: "Korean", native: "한국어" },
  { code: "es", english: "Spanish", native: "Español" },
  { code: "fr", english: "French", native: "Français" },
  { code: "de", english: "German", native: "Deutsch" },
  { code: "ru", english: "Russian", native: "Русский" },
  { code: "pt-BR", english: "Portuguese (Brazil)", native: "Português (Brasil)" },
] as const;

export type LocaleCode = (typeof LOCALES)[number]["code"];

/** 默认语言：**英文**（用户裁决）。 */
export const DEFAULT_LOCALE: LocaleCode = "en";

export const LOCALE_STORAGE_KEY = "bls-ops.locale";

export function isLocaleCode(value: string): value is LocaleCode {
  return LOCALES.some((locale) => locale.code === value);
}

/** 语言切换器的展示名：用**各自语言**写（日本人看到的是「日本語」）。 */
export function localeLabel(code: LocaleCode): string {
  const locale = LOCALES.find((item) => item.code === code);
  return locale ? locale.native : code;
}
