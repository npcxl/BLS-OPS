/**
 * Redis 键浏览器的纯逻辑层 —— 不依赖 React 与 Tauri IPC，方便单测。
 *
 * 从 RedisBrowser.tsx 抽出的部分：
 * - TTL 展示与快捷预设（formatTtl / TTL_PRESETS）
 * - 类型徽标配色（kindBadgeClass）
 * - db index 解析（initialDbIndex）
 * - 键列表合并去重（mergeKeyPage）—— SCAN 异步竞态的兜底防线
 * - hash 分页合并去重（mergeHashFields）—— HSCAN 续扫的兜底防线
 * - pub/sub 消息解码（decodePubsubMessage）—— Base64 无损传输的还原端
 */
import type {
  RedisFieldEntry,
  RedisKeyBrief,
  RedisPubSubEvent,
} from "@/api/types/database";

/** 类型徽标配色：一眼分清 string/hash/list/set/zset/stream。 */
const KIND_BADGE: Record<string, string> = {
  string: "bg-accent/15 text-accent",
  hash: "bg-ai/15 text-ai",
  list: "bg-success/15 text-success",
  set: "bg-warning/15 text-warning",
  zset: "bg-danger/15 text-danger",
  stream: "bg-fg-subtle/20 text-fg-muted",
  other: "bg-surface-hover text-fg-muted",
};

export function kindBadgeClass(kind: string): string {
  return KIND_BADGE[kind] ?? KIND_BADGE.other;
}

/**
 * TTL 展示：-1 = 永久（∞），其它负数 = 无 TTL（—），
 * 正数按量级换算 s/m/h/d（取整近似，仅供列表速览）。
 */
export function formatTtl(ttlMs: number): string {
  if (ttlMs === -1) return "∞";
  if (ttlMs < 0) return "—";
  const seconds = Math.round(ttlMs / 1000);
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)}h`;
  return `${Math.round(seconds / 86400)}d`;
}

/** 快捷 TTL 选项（毫秒）；null = 永久（PERSIST）。 */
export const TTL_PRESETS: Array<{ label: string; ms: number | null }> = [
  { label: "1h", ms: 3_600_000 },
  { label: "24h", ms: 86_400_000 },
  { label: "7d", ms: 7 * 86_400_000 },
  { label: "∞", ms: null },
];

/** db index 解析：配置里的 default_database 是字符串，解析失败或越界回退 0。 */
export function initialDbIndex(profile: {
  default_database?: string | null;
}): number {
  const parsed = Number(profile.default_database ?? "0");
  return Number.isInteger(parsed) && parsed >= 0 && parsed <= 15 ? parsed : 0;
}

/**
 * 键列表合并：SCAN 续扫 append，按键名去重。
 *
 * 这是异步竞态的兜底防线 —— 请求序号守卫挡住"旧响应覆盖新状态"，
 * 这里挡住"同一批键因重复到达/双击续扫出现两行"。reset 时直接替换。
 */
export function mergeKeyPage(
  current: RedisKeyBrief[],
  page: RedisKeyBrief[],
  reset: boolean,
): RedisKeyBrief[] {
  const merged = reset ? page : [...current, ...page];
  const seen = new Set<string>();
  return merged.filter((entry) =>
    seen.has(entry.key) ? false : (seen.add(entry.key), true),
  );
}

/** hash 分页合并：HSCAN 续扫按字段名去重（HSCAN 可能重扫到同一字段）。 */
export function mergeHashFields(
  current: RedisFieldEntry[],
  incoming: RedisFieldEntry[],
): RedisFieldEntry[] {
  const seen = new Set(current.map((entry) => entry.field));
  return [...current, ...incoming.filter((entry) => !seen.has(entry.field))];
}

/**
 * 消息负载解码：Rust 侧统一推 Base64（二进制无损）。
 * Base64 解码后再尝试严格 UTF-8：文本消息正常显示，
 * 真二进制消息回退显示 Base64 原文（数据本体可复制还原）。
 */
export function decodePubsubMessage(event: RedisPubSubEvent): string {
  if (event.messageBase64) {
    try {
      const raw = atob(event.messageBase64);
      const bytes = Uint8Array.from(raw, (char) => char.charCodeAt(0));
      return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      return `base64: ${event.messageBase64}`;
    }
  }
  return event.message ?? "";
}
