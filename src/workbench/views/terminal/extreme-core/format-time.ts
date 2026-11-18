/**
 * 对话时间的展示格式（纯函数，便于单测）。
 *
 * 两套口径，对应两处界面：
 * * [`chatTime`] —— 气泡署名行：今天只给「14:01」，昨天起补日期前缀；
 * * [`dayTime`] —— 左栏悬停预览卡：今天/昨天用词（「今天 14:01」），更早给日期。
 *
 * 日期前缀用数字格式（`2026/11/16`）而不是「11月16日」：中英界面共用，
 * 不需要为日期再维护一套词条。无效时间戳返回空串 —— 旧记录没有 createdAt，
 * 界面据此**不显示**时间，绝不拿"现在"冒充历史时刻。
 */

export type Translate = (key: string, options?: Record<string, unknown>) => string;

function pad(value: number): string {
  return value < 10 ? `0${value}` : String(value);
}

function clockOf(date: Date): string {
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** 两个时刻是否同一个本地日历日（跨时区/夏令时都按本地日判断）。 */
function sameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

function dateOf(date: Date): string {
  return `${date.getFullYear()}/${pad(date.getMonth() + 1)}/${pad(date.getDate())}`;
}

/** 时间戳是否可用（旧记录缺字段 / 落库损坏时直接不显示）。 */
export function validTime(ts: number | undefined): ts is number {
  return typeof ts === "number" && Number.isFinite(ts) && ts > 0;
}

/** 气泡署名行：今天 `14:01`；昨天 `昨天 14:01`；更早 `2026/11/16 14:01`。 */
export function chatTime(ts: number | undefined, t: Translate, now = Date.now()): string {
  if (!validTime(ts)) return "";
  const date = new Date(ts);
  const today = new Date(now);
  const clock = clockOf(date);
  if (sameDay(date, today)) return clock;
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  if (sameDay(date, yesterday)) return t("昨天 {{time}}", { time: clock });
  return `${dateOf(date)} ${clock}`;
}

/** 预览卡：今天 `今天 14:01`；昨天 `昨天 14:01`；更早 `2026/11/16 14:01`。 */
export function dayTime(ts: number | undefined, t: Translate, now = Date.now()): string {
  if (!validTime(ts)) return "";
  const date = new Date(ts);
  const today = new Date(now);
  const clock = clockOf(date);
  if (sameDay(date, today)) return t("今天 {{time}}", { time: clock });
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  if (sameDay(date, yesterday)) return t("昨天 {{time}}", { time: clock });
  return `${dateOf(date)} ${clock}`;
}

/**
 * 预览卡的内容摘要：取**最后一条有正文的消息**，压成单段、截到上限。
 *
 * 不做 Markdown 解析（预览卡不值得为它跑一遍解析器）；只去掉最常见的
 * 标记符号，让摘要读起来是"人话"而不是 `#` 与 `*` 的噪声。
 */
export function previewSnippet(
  messages: { text: string }[],
  limit = 160,
): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const raw = messages[index]?.text?.trim();
    if (!raw) continue;
    const clean = raw
      .replace(/```[\s\S]*?```/g, " ")
      .replace(/[#>*`|]/g, "")
      .replace(/\s+/g, " ")
      .trim();
    if (!clean) continue;
    return clean.length <= limit ? clean : `${clean.slice(0, limit)}…`;
  }
  return "";
}
