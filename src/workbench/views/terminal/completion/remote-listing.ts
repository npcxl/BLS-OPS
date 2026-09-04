/**
 * 远程目录列表的**共享读取层**（cd 补全与文件参数补全共用）。
 *
 * 只有一个数据源：当前 SSH 会话的 SFTP 列目录接口。**永不读本地文件系统**，
 * 也绝不执行并解析 `ls` 文本 —— 路径里的空格会让文本解析悄悄出错。
 *
 * 两个能力：
 * - 短时间缓存（默认 10s）：连续输入 `cd /var/l` 不该每次都打一次 SFTP；
 * - 显式失效：切换服务器、执行 mkdir/rmdir/mv/rm、手动刷新后必须失效
 *   （缓存了过期目录比不缓存更糟 —— 用户会看到不存在的补全）。
 */

import { opsApi, type RemoteFileEntry } from "@/api/ops-api";

/** 目录缓存的有效期（ms）。短到不会误导，长到能省掉连续输入时的往返。 */
export const CACHE_TTL_MS = 10_000;

interface CacheEntry {
  at: number;
  entries: RemoteFileEntry[];
}

const cache = new Map<string, CacheEntry>();
/** 正在飞的请求：同 key 只发一次，后来的调用共用同一个 promise。 */
const inFlight = new Map<string, Promise<RemoteFileEntry[]>>();

export type DirectoryLister = (args: {
  sessionId: string;
  path: string;
}) => Promise<RemoteFileEntry[]>;

/** 默认列目录实现：走 SFTP（与远程文件面板同一个接口）。 */
const defaultLister: DirectoryLister = async ({ sessionId, path }) => {
  const result = await opsApi.sftpListDir(sessionId, path);
  return result.entries;
};

let lister: DirectoryLister = defaultLister;

/** 替换列目录实现（测试用）。 */
export function setDirectoryLister(next: DirectoryLister | null): void {
  lister = next ?? defaultLister;
}

/**
 * 让目录缓存失效。
 *
 * - 不传参数：清空所有会话（切换服务器 / 断开连接时用）；
 * - 只传 `sessionId`：清空该会话（执行 mkdir/rmdir/mv/rm 等之后）；
 * - 两个都传：只清该目录（精确失效）。
 */
export function invalidateDirectoryCache(sessionId?: string, path?: string): void {
  if (sessionId === undefined) {
    cache.clear();
    inFlight.clear();
    return;
  }
  if (path === undefined) {
    for (const key of [...cache.keys()]) {
      if (key.startsWith(`${sessionId}::`)) cache.delete(key);
    }
    return;
  }
  cache.delete(cacheKey(sessionId, path));
}

export function cacheKey(sessionId: string, path: string): string {
  return `${sessionId}::${path}`;
}

/** 读取目录（带短缓存 + 同 key 合并请求）。失败不留缓存，直接抛给调用方。 */
export async function listDirectory(
  sessionId: string,
  path: string,
): Promise<RemoteFileEntry[]> {
  const key = cacheKey(sessionId, path);
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.entries;

  const pending = inFlight.get(key);
  if (pending) return pending;

  const task = (async () => {
    const entries = await lister({ sessionId, path });
    cache.set(key, { at: Date.now(), entries });
    return entries;
  })();

  inFlight.set(
    key,
    task.finally(() => inFlight.delete(key)),
  );
  return task.catch((cause) => {
    cache.delete(key);
    throw cause;
  });
}
