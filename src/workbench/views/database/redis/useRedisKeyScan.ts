/**
 * SCAN 分页状态：cursor、累计键、DBSIZE、扫描中。
 *
 * 三个必须守住的点：
 * - **竞态**：每次扫描领一个序号，晚到的旧响应直接丢弃（切 DB / 改 pattern /
 *   连续点刷新都会并发）；否则旧响应会把 cursor 退回去、或把同一批键追加两次。
 * - **未连接不发 SCAN**：后端只会回"连接尚未建立"，白白刷一条错误。
 * - **上限要可见**：到 MAX_SCAN_KEYS 后 `capped = true`，由 UI 明确提示，
 *   而不是像以前那样静默把后面的键丢掉。
 *
 * 当前 db 编号存在 store（`redisDbIndex`）：侧栏的库节点和工作区的库选择器
 * 必须操作同一份状态，否则会出现"侧栏点了 db 3，列表还是 db 0"。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { databaseApi } from "@/api/ops-api";
import type { DatabaseProfile, RedisKeyBrief } from "@/api/types/database";
import { useDatabaseStore } from "@/stores/database-store";
import { alertRedisFailure, MAX_SCAN_KEYS } from "./redis-shared";

const SCAN_PAGE_SIZE = 500;

export interface RedisKeyScanState {
  dbIndex: number;
  pattern: string;
  keys: RedisKeyBrief[];
  dbsize: number | null;
  scanning: boolean;
  hasMore: boolean;
  capped: boolean;
  setDbIndex: (value: number) => void;
  setPattern: (value: string) => void;
  /** reset=true 从头扫一页；false 续扫下一页。 */
  scan: (reset: boolean) => void;
  rescan: () => void;
}

export function useRedisKeyScan(
  profile: DatabaseProfile,
  connected: boolean,
  defaultDb: number,
): RedisKeyScanState {
  const { t } = useTranslation();
  const dbIndex = useDatabaseStore(
    (state) => state.redisDbIndex[profile.id] ?? defaultDb,
  );
  const selectRedisDb = useDatabaseStore((state) => state.selectRedisDb);
  const [pattern, setPatternState] = useState("*");
  const [keys, setKeys] = useState<RedisKeyBrief[]>([]);
  const [cursor, setCursor] = useState(0);
  const [dbsize, setDbsize] = useState<number | null>(null);
  const [scanning, setScanning] = useState(false);
  const [capped, setCapped] = useState(false);
  const seqRef = useRef(0);

  // 切库（侧栏点节点 / 工作区下拉）：列表与游标整体作废，旧响应靠序号丢弃。
  useEffect(() => {
    seqRef.current += 1;
    setKeys([]);
    setCursor(0);
    setCapped(false);
  }, [dbIndex]);

  const runScan = useCallback(
    async (reset: boolean) => {
      if (!connected) return;
      const seq = ++seqRef.current;
      setScanning(true);
      try {
        const page = await databaseApi.redisScan(
          profile.id,
          dbIndex,
          pattern || "*",
          reset ? 0 : cursor,
          SCAN_PAGE_SIZE,
        );
        // 过期响应：期间已有更新的扫描发起，整页丢弃。
        if (seq !== seqRef.current) return;
        setKeys((current) => {
          const merged = reset ? page.keys : [...current, ...page.keys];
          const seen = new Set<string>();
          const deduped = merged.filter((entry) =>
            seen.has(entry.key) ? false : (seen.add(entry.key), true),
          );
          if (deduped.length >= MAX_SCAN_KEYS) {
            setCapped(true);
            return deduped.slice(0, MAX_SCAN_KEYS);
          }
          return deduped;
        });
        setCursor(page.cursor);
        // DBSIZE 只有首屏才有值，翻页时沿用旧值。
        if (page.dbsize !== null) setDbsize(page.dbsize);
        if (reset) setCapped(false);
      } catch (failure) {
        if (seq === seqRef.current) alertRedisFailure(failure, t("扫描失败"));
      } finally {
        if (seq === seqRef.current) setScanning(false);
      }
    },
    [connected, profile.id, dbIndex, pattern, cursor, t],
  );

  const setDbIndex = useCallback(
    (value: number) => selectRedisDb(profile.id, value),
    [profile.id, selectRedisDb],
  );

  const setPattern = useCallback((value: string) => {
    setPatternState(value);
  }, []);

  return {
    dbIndex,
    pattern,
    keys,
    dbsize,
    scanning,
    hasMore: cursor !== 0 && !capped,
    capped,
    setDbIndex,
    setPattern,
    scan: (reset: boolean) => void runScan(reset),
    rescan: () => void runScan(true),
  };
}
