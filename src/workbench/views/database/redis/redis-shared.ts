/**
 * Redis 工作区共用的常量与错误处理（从 RedisBrowser 拆出）。
 */
import { pushErrorToast } from "@/components/ui/toast";

/**
 * 前端累计键上限。
 *
 * 网格是虚拟滚动（只渲染可视区），所以可以放开到 20 万；真正的内存上限来自
 * 每行约 120 字节（key + type + ttl），20 万行 ≈ 24 MB。到顶后列表会明确
 * 提示"已达上限"，而不是像以前那样静默丢弃后面的键。
 */
export const MAX_SCAN_KEYS = 200_000;

/**
 * 键浏览器里的操作失败：弹到顶部 alert（带阶段 + 后端原文 + 复制）。
 *
 * 以前是顶栏下方一条 11px 红字，滚一下就看不见了。这类错误用户能自己重试，
 * 所以不常驻（8s 自动消失，仍然可以手动关）。
 */
export function alertRedisFailure(failure: unknown, title: string): void {
  pushErrorToast(failure, { title, persist: false });
}

/**
 * 写操作的统一包装：成功回读当前键并刷新列表，失败交给调用方或顶部提示。
 *
 * 返回值必须看：删除/重命名这类操作"失败了也以为成功"是事故 —— 面板关掉了、
 * 列表刷新了，服务器上的数据其实没动。
 */
export type RedisMutate = (
  action: () => Promise<void>,
  successNotice?: string,
  /** 给了就**不弹**全局提示，由调用方在弹窗里就地显示（避免同一错误出现两次）。 */
  onError?: (failure: unknown) => void,
) => Promise<boolean>;

/** 与后端 `SET_PAGE_MAX` 对齐：SSCAN 单页最多 500 个成员。 */
export const SET_PAGE_SIZE = 500;

/** 类型徽标配色：一眼分清 string/hash/list/set/zset/stream。 */
export const KIND_BADGE: Record<string, string> = {
  string: "bg-accent/15 text-accent",
  hash: "bg-ai/15 text-ai",
  list: "bg-success/15 text-success",
  set: "bg-warning/15 text-warning",
  zset: "bg-danger/15 text-danger",
  stream: "bg-fg-subtle/20 text-fg-muted",
  other: "bg-surface-hover text-fg-muted",
};

export function kindBadgeClass(kind: string) {
  return KIND_BADGE[kind] ?? KIND_BADGE.other;
}

export function formatTtl(ttlMs: number): string {
  if (ttlMs === -1) return "∞";
  if (ttlMs < 0) return "—";
  const seconds = Math.round(ttlMs / 1000);
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)}h`;
  return `${Math.round(seconds / 86400)}d`;
}

/** 快捷 TTL 选项（毫秒）；null = 永久。 */
export const TTL_PRESETS: Array<{ label: string; ms: number | null }> = [
  { label: "1h", ms: 3_600_000 },
  { label: "24h", ms: 86_400_000 },
  { label: "7d", ms: 7 * 86_400_000 },
  { label: "∞", ms: null },
];
