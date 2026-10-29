/**
 * 非活动工作项的结果缓存预算。
 *
 * 页面组件为保留滚动/筛选/草稿而常驻，但结果集不应无限占用内存。
 * 同时按当前页行数和估算字节数控制，可通过 localStorage 调整：
 * `ops.db.inactiveResultRows` / `ops.db.inactiveResultBytes`。
 */
import type { DbValue } from "@/api/types/database";

export const DEFAULT_INACTIVE_RESULT_ROWS = 500;
export const DEFAULT_INACTIVE_RESULT_BYTES = 8 * 1024 * 1024;
// 200k 行批次基准显示实际 JS 堆约为“文本长度估算”的 2 倍；
// 32 MiB 预算对应约 70 MiB 实际保留量，避免 100 个隐藏页吃满内存。
export const DEFAULT_GLOBAL_RESULT_BYTES = 32 * 1024 * 1024;

interface InactiveCacheEntry {
  id: string;
  bytes: number;
  evict: () => void;
  touched: number;
}

const inactiveCaches = new Map<string, InactiveCacheEntry>();
let touchCounter = 0;

export function globalResultByteBudget(): number {
  try {
    const raw = Number(localStorage.getItem("ops.db.globalResultBytes"));
    if (!Number.isFinite(raw)) return DEFAULT_GLOBAL_RESULT_BYTES;
    return Math.min(512 * 1024 * 1024, Math.max(8 * 1024 * 1024, Math.trunc(raw)));
  } catch {
    return DEFAULT_GLOBAL_RESULT_BYTES;
  }
}

export function unregisterInactiveResult(id: string): void {
  inactiveCaches.delete(id);
}

/** 登记一个隐藏工作项的结果；超出全局预算时淘汰最久未访问的隐藏页。 */
export function registerInactiveResult(
  id: string,
  bytes: number,
  evict: () => void,
): void {
  inactiveCaches.set(id, {
    id,
    bytes,
    evict,
    touched: ++touchCounter,
  });
  enforceGlobalResultBudget(id);
}

export function enforceGlobalResultBudget(keepId?: string): void {
  let total = 0;
  for (const entry of inactiveCaches.values()) total += entry.bytes;
  if (total <= globalResultByteBudget()) return;

  const candidates = [...inactiveCaches.values()]
    .filter((entry) => entry.id !== keepId)
    .sort((a, b) => a.touched - b.touched);
  for (const entry of candidates) {
    if (total <= globalResultByteBudget()) break;
    inactiveCaches.delete(entry.id);
    total -= entry.bytes;
    entry.evict();
  }
}

export function resetInactiveResultRegistryForTests(): void {
  inactiveCaches.clear();
  touchCounter = 0;
}

export function inactiveResultRowBudget(): number {
  try {
    const raw = Number(localStorage.getItem("ops.db.inactiveResultRows"));
    if (!Number.isFinite(raw)) return DEFAULT_INACTIVE_RESULT_ROWS;
    return Math.min(20_000, Math.max(50, Math.trunc(raw)));
  } catch {
    return DEFAULT_INACTIVE_RESULT_ROWS;
  }
}

export function inactiveResultByteBudget(): number {
  try {
    const raw = Number(localStorage.getItem("ops.db.inactiveResultBytes"));
    if (!Number.isFinite(raw)) return DEFAULT_INACTIVE_RESULT_BYTES;
    return Math.min(256 * 1024 * 1024, Math.max(256 * 1024, Math.trunc(raw)));
  } catch {
    return DEFAULT_INACTIVE_RESULT_BYTES;
  }
}

export function estimateDbValueBytes(value: DbValue): number {
  switch (value.kind) {
    case "null":
      return 8;
    case "text":
    case "json":
      return value.value.length * 2 + 32;
    case "binary":
      return value.base64.length + 40;
    case "int":
    case "decimal":
      return value.value.length + 24;
    case "float":
      return 32;
    case "date":
    case "date_time":
    case "time":
      return (value.value?.length ?? 0) * 2 + 32;
    case "bit":
      return value.bits.length + 24;
    case "unsupported":
      return value.preview.length * 2 + 48;
    default:
      return 32;
  }
}

export function estimateRowsBytes(rows: DbValue[][]): number {
  let bytes = 0;
  for (const row of rows) {
    for (const cell of row) bytes += estimateDbValueBytes(cell);
  }
  return bytes;
}

export function shouldEvictInactiveResult(args: {
  active: boolean;
  rowCount: number;
  pendingChanges: number;
  bytes?: number;
  rowBudget?: number;
  byteBudget?: number;
}): boolean {
  if (args.active) return false;
  // 有暂存修改时保留页面，避免用户切回来丢失行定位/编辑上下文。
  if (args.pendingChanges > 0) return false;
  const rowBudget = args.rowBudget ?? DEFAULT_INACTIVE_RESULT_ROWS;
  const byteBudget = args.byteBudget ?? DEFAULT_INACTIVE_RESULT_BYTES;
  return (
    args.rowCount > rowBudget || (args.bytes ?? 0) > byteBudget
  );
}
