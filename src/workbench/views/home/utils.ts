/** 首页纯展示工具：相对时间与时间戳标题，不碰任何状态。 */
import type { TFunction } from "i18next";

/**
 * 相对时间。key 直接用英文自然语言（`{{count}} minutes ago` 这种），
 * 中文由 `zh-CN/common.ts` 提供译文。
 *
 * 以前 key 是 `JustNow` / `DaysAgo` 这类英文标识符：`en` 走 natural keys，
 * 没有对应文案，英文界面会原样显示 `Edited DaysAgo` —— 就是"中英混排"的来源。
 *
 * `0`/`null` 一律是"从未"，不能当"刚刚"。
 */
export function relativeTime(timestamp: number | null | undefined, t: TFunction): string {
  if (!timestamp) return t("Never connected");
  const diff = Date.now() - timestamp;
  if (diff < 60_000) return t("Just now");
  if (diff < 3_600_000) return t("{{count}} minutes ago", { count: Math.floor(diff / 60_000) });
  if (diff < 86_400_000) return t("{{count}} hours ago", { count: Math.floor(diff / 3_600_000) });
  if (diff < 7 * 86_400_000) return t("{{count}} days ago", { count: Math.floor(diff / 86_400_000) });
  return new Date(timestamp).toLocaleDateString();
}

/** 悬停用的绝对时间；没有值时返回 undefined（不制造假时间）。 */
export function timestampTitle(timestamp: number | null | undefined): string | undefined {
  return timestamp ? new Date(timestamp).toLocaleString() : undefined;
}

/** 单行 SQL 摘要：换行/连续空白压成一个空格，超出长度再截断。 */
export function singleLine(text: string, max = 120): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}
