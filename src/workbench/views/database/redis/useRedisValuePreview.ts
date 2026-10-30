/**
 * 键表格的「值 / 大小」两列数据。
 *
 * 参考图里这两列是逐行值预览与字节数。它们只能**逐键**取（没有批量命令），
 * 所以这里做了三层限制，绝不打满连接：
 * - 只取调用方给的一小批键（工作区传当前可见的前 N 个）；
 * - 同一时刻最多 4 个请求；
 * - 结果按 `profile:db:key` 缓存，滚动回来不重复请求。
 *
 * 大小只对 string 有真实字节数（`read_value` 回 bytes）；集合类型不执行
 * MEMORY USAGE（全量执行会把 Redis 打满），因此留空而不是瞎猜。
 */
import { useEffect, useRef, useState } from "react";
import { databaseApi } from "@/api/ops-api";
import type { RedisValuePayload } from "@/api/types/database";

export interface RedisValuePreview {
  /** 值预览（单行、截断）；读不到时为空串。 */
  text: string;
  /** 字节数：只有 string 有。 */
  bytes: number | null;
}

const CACHE_LIMIT = 2_000;
const MAX_CONCURRENT = 4;

const cache = new Map<string, RedisValuePreview>();
const inflight = new Set<string>();

function previewOf(payload: RedisValuePayload): RedisValuePreview {
  switch (payload.kind) {
    case "string":
      return {
        text: payload.value.replace(/\s+/g, " ").slice(0, 120),
        bytes: payload.bytes,
      };
    case "hash":
      return {
        text: payload.fields
          .slice(0, 3)
          .map((entry) => `${entry.field}: ${entry.value}`)
          .join(", ")
          .slice(0, 120),
        bytes: null,
      };
    case "list":
      return { text: payload.items.slice(0, 3).join(", ").slice(0, 120), bytes: null };
    case "set":
      return { text: payload.members.slice(0, 3).join(", ").slice(0, 120), bytes: null };
    case "zset":
      return {
        text: payload.entries
          .slice(0, 3)
          .map((entry) => `${entry.member} (${entry.score})`)
          .join(", ")
          .slice(0, 120),
        bytes: null,
      };
    case "stream":
      return {
        text: payload.entries
          .slice(0, 2)
          .map((entry) => entry.id)
          .join(", ")
          .slice(0, 120),
        bytes: null,
      };
    default:
      return { text: "", bytes: null };
  }
}

export function useRedisValuePreview(
  profileId: string,
  dbIndex: number,
  keys: string[],
  enabled: boolean,
): Record<string, RedisValuePreview> {
  const [version, setVersion] = useState(0);
  const queueRef = useRef<string[]>([]);

  useEffect(() => {
    if (!enabled) return;
    queueRef.current = keys
      .map((key) => `${profileId}\u0001${dbIndex}\u0001${key}`)
      .filter((id) => !cache.has(id) && !inflight.has(id));
    if (queueRef.current.length === 0) return;

    let cancelled = false;
    const run = async () => {
      while (!cancelled && queueRef.current.length > 0) {
        const batch = queueRef.current.splice(0, MAX_CONCURRENT);
        await Promise.all(
          batch.map(async (id) => {
            const [, , key] = id.split("\u0001");
            inflight.add(id);
            try {
              const payload = await databaseApi.redisReadValue(
                profileId,
                dbIndex,
                key,
                false,
              );
              if (cache.size > CACHE_LIMIT) cache.clear();
              cache.set(id, previewOf(payload));
            } catch {
              // 键可能刚好过期：留空，不弹错误（列表里刷红点太吵）。
              cache.set(id, { text: "", bytes: null });
            } finally {
              inflight.delete(id);
            }
          }),
        );
        if (!cancelled) setVersion((current) => current + 1);
      }
    };
    void run();
    return () => {
      cancelled = true;
    };
    // version 只在取到新数据时递增，用它触发重渲染即可。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profileId, dbIndex, keys.join("\u0001"), enabled, version]);

  const result: Record<string, RedisValuePreview> = {};
  for (const key of keys) {
    const hit = cache.get(`${profileId}\u0001${dbIndex}\u0001${key}`);
    if (hit) result[key] = hit;
  }
  return result;
}
