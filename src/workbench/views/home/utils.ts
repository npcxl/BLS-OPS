/** 首页纯展示工具：相对时间与时间戳标题，不碰任何状态。 */
import type { TFunction } from "i18next";

/**
 * 相对时间。插值/通用词复用 common（JustNow/MinutesAgo/…），纯函数接收 t。
 *
 * `0`/`null` 一律是"从未"，不能当"刚刚"。
 */
export function relativeTime(timestamp: number | null | undefined, t: TFunction): string {
  if (!timestamp) return t("Never connected");
  const diff = Date.now() - timestamp;
  if (diff < 60_000) return t("JustNow");
  if (diff < 3_600_000) return t("MinutesAgo", { count: Math.floor(diff / 60_000) });
  if (diff < 86_400_000) return t("HoursAgo", { count: Math.floor(diff / 3_600_000) });
  if (diff < 7 * 86_400_000) return t("DaysAgo", { count: Math.floor(diff / 86_400_000) });
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
