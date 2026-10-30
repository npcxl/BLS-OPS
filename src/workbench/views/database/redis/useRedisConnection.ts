/**
 * Redis 连接状态与建连动作（唯一来源：store 的 `statuses`）。
 *
 * 挂载时先回读运行时状态，确认没连上才建连 —— 不能拿挂载瞬间的空状态判断，
 * 否则侧栏刚点过"打开连接"时这里会再发一条 `db_redis_connect`（store 里还有
 * in-flight 去重兜底，但前端也不该白跑一趟）。
 */
import { useCallback, useEffect } from "react";
import type { DbErrorInfo } from "@/api/types/database";
import { useDatabaseStore } from "@/stores/database-store";

export interface RedisConnectionState {
  connected: boolean;
  connecting: boolean;
  error: DbErrorInfo | null;
  serverVersion: string | null;
  tunnelPort: number | null;
  connect: () => void;
  reconnect: () => void;
  refresh: () => void;
}

export function useRedisConnection(profileId: string): RedisConnectionState {
  const status = useDatabaseStore((state) => state.statuses[profileId]);
  const error = useDatabaseStore((state) => state.sessionErrors[profileId] ?? null);
  const connecting = useDatabaseStore(
    (state) => !!state.redisConnecting[profileId],
  );
  const redisConnect = useDatabaseStore((state) => state.redisConnect);
  const redisReconnect = useDatabaseStore((state) => state.redisReconnect);
  const refreshStatus = useDatabaseStore((state) => state.refreshStatus);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      await refreshStatus(profileId);
      if (cancelled) return;
      if (useDatabaseStore.getState().statuses[profileId]?.connected) return;
      await redisConnect(profileId);
    })();
    return () => {
      cancelled = true;
    };
  }, [profileId, refreshStatus, redisConnect]);

  const connect = useCallback(() => void redisConnect(profileId), [redisConnect, profileId]);
  const reconnect = useCallback(
    () => void redisReconnect(profileId),
    [redisReconnect, profileId],
  );
  const refresh = useCallback(
    () => void refreshStatus(profileId),
    [refreshStatus, profileId],
  );

  return {
    connected: !!status?.connected,
    connecting,
    error,
    serverVersion: status?.server_version ?? null,
    tunnelPort: status?.tunnel_local_port ?? null,
    connect,
    reconnect,
    refresh,
  };
}
