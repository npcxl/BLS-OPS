/**
 * 首页的数据库侧数据：
 *
 * 1. **连接配置**：`useDatabaseStore.profiles`（本地 SQLite），首页不重复加载
 *    已有的列表；没人加载过才补一次。
 * 2. **实时状态**：逐连接回读 Rust 运行时的 `db_profile_status` —— 只读进程内
 *    状态，不会建连、不会探测。
 * 3. **最近查询**：`db_history_list`（本地 SQLite，按 created_at 倒序）。这是
 *    仓库里唯一可靠的"数据库使用历史"，没有记录的连接就不出现在最近列表里。
 *
 * 历史默认开启（`ops.db.history.enabled`），用户关掉后列表自然为空 —— 空就是
 * 空，不拿连接配置的 updated_at 冒充"最近访问"。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { databaseApi } from "@/api/ops-api";
import type { DatabaseProfile } from "@/api/types/database";
import { useDatabaseStore } from "@/stores/database-store";

export interface RecentDatabaseQuery {
  profileId: string;
  at: number;
  sql: string;
  succeeded: boolean;
}

interface DatabaseActivity {
  /** 最近查询过的连接，按时间倒序；同一连接只保留最新一条。 */
  recent: RecentDatabaseQuery[];
  loading: boolean;
  /** 连接配置是否已经成功读出来；false 时调用方必须显示"未知"而不是 0。 */
  profilesReady: boolean;
  profilesError: string | null;
}

function newestFirst(rows: RecentDatabaseQuery[]): RecentDatabaseQuery[] {
  return rows.sort((a, b) => b.at - a.at);
}

export function useDatabaseActivity(profiles: DatabaseProfile[]): DatabaseActivity {
  const refreshProfiles = useDatabaseStore((state) => state.refreshProfiles);
  const refreshStatus = useDatabaseStore((state) => state.refreshStatus);

  const [recent, setRecent] = useState<RecentDatabaseQuery[]>([]);
  const [loading, setLoading] = useState(false);
  const [profilesReady, setProfilesReady] = useState(
    () => useDatabaseStore.getState().profiles.length > 0,
  );
  const [profilesError, setProfilesError] = useState<string | null>(
    () => useDatabaseStore.getState().profileError?.message ?? null,
  );
  const requestRef = useRef(0);
  const mountedRef = useRef(true);
  const profilesSeeded = useRef(false);
  const statusSeeded = useRef(new Set<string>());
  const historySignature = useRef<string | null>(null);

  const signature = profiles.map((profile) => profile.id).join("\u0001");

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // 连接配置只补读一次：已有列表说明其它模块已经加载过了。
  useEffect(() => {
    if (profilesSeeded.current) return;
    profilesSeeded.current = true;
    if (useDatabaseStore.getState().profiles.length > 0) {
      setProfilesReady(true);
      return;
    }
    void (async () => {
      await refreshProfiles();
      if (!mountedRef.current) return;
      const error = useDatabaseStore.getState().profileError;
      if (error) {
        setProfilesError(error.message);
        return;
      }
      setProfilesError(null);
      setProfilesReady(true);
    })();
  }, [refreshProfiles]);

  // 每个连接的运行时状态只回读一次；新保存的连接会在这里补一次。
  useEffect(() => {
    for (const profile of profiles) {
      if (statusSeeded.current.has(profile.id)) continue;
      statusSeeded.current.add(profile.id);
      void refreshStatus(profile.id);
    }
  }, [profiles, refreshStatus]);

  const loadHistory = useCallback(async (profilesToRead: DatabaseProfile[]) => {
    const request = ++requestRef.current;
    if (profilesToRead.length === 0) {
      setRecent([]);
      setLoading(false);
      return;
    }

    setLoading(true);
    const rows = await Promise.all(
      profilesToRead.map(async (profile) => {
        try {
          const history = await databaseApi.historyList(profile.id);
          if (!Array.isArray(history) || history.length === 0) return null;
          // 后端已按 created_at DESC 排序，取第一条即最新。
          const latest = history[0];
          return {
            profileId: profile.id,
            at: latest.created_at,
            sql: latest.sql,
            succeeded: latest.succeeded,
          } satisfies RecentDatabaseQuery;
        } catch {
          // 单个连接读不到历史不影响其它连接：它只是不出现在"最近"里。
          return null;
        }
      }),
    );

    if (!mountedRef.current || request !== requestRef.current) return;
    setRecent(newestFirst(rows.filter((row): row is RecentDatabaseQuery => row !== null)));
    setLoading(false);
  }, []);

  useEffect(() => {
    if (historySignature.current === signature) return;
    historySignature.current = signature;
    void loadHistory(profiles);
  }, [signature, profiles, loadHistory]);

  return { recent, loading, profilesReady, profilesError };
}
