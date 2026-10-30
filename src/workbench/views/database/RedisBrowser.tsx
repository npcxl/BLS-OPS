/**
 * Redis 连接标签的入口。
 *
 * 1824 行的单体已经拆到 `./redis/`：
 * - `useRedisConnection` / `useRedisKeyScan` / `useRedisKeySelection`：状态
 * - `RedisKeyGrid` / `RedisKeyDetail` / `RedisPubSubPanel` / `RedisStatusBar`：视图
 * - `RedisWorkspace`：编排（工具栏、分栏、快捷键、右键菜单、危险确认）
 *
 * 这里只保留 `RedisBrowser` 这个名字：DatabaseView 与既有测试都按它引用，
 * 不让上层跟着改。
 */
import type { DatabaseProfile } from "@/api/types/database";
import { RedisWorkspace } from "./redis/RedisWorkspace";

export function RedisBrowser({ profile }: { profile: DatabaseProfile }) {
  return <RedisWorkspace profile={profile} />;
}
