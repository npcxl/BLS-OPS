/**
 * Redis 键浏览器 —— 引擎为 redis 的连接标签的完整工作区。
 *
 * 与 SQL 工作台的关系：完全平行。这里不用 WorkItem/查询任务体系，
 * 操作都是短命令（SCAN/GET/SET/DEL/…），状态保留在组件内。
 *
 * 布局：
 * - 顶部：连接状态 + db index 切换 + SCAN 模式搜索 + dbsize；
 * - 左：键列表（类型徽标 + TTL）；
 * - 右：键详情（元信息 + 按类型渲染的值 + 编辑入口）+ 发布订阅面板。
 * 只读连接（profile.read_only）隐藏一切写入口。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Loader2,
  Pencil,
  PlugZap,
  Plus,
  RefreshCw,
  Trash2,
  TriangleAlert,
  X,
} from "@/components/icons";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/select";
import { pushToast } from "@/components/ui/toast";
import { Tooltip } from "@/components/ui/tooltip";
import { cn } from "@/lib/cn";
import { databaseApi } from "@/api/ops-api";
import type {
  DatabaseProfile,
  RedisFieldEntry,
  RedisKeyBrief,
  RedisKeyInfo,
  RedisPubSubEvent,
  RedisValuePayload,
  RedisZEntry,
} from "@/api/types/database";
import { toDbError, useDatabaseStore } from "@/stores/database-store";

/** 前端累计键数上限：持续翻页不设限会一直涨内存（10 万行 ≈ 30 MB）。 */
const MAX_SCAN_KEYS = 5_000;

/**
 * 键浏览器里的操作失败：弹到顶部 alert（带阶段 + 后端原文）。
 *
 * 以前是顶栏下方一条 11px 红字，滚一下就看不见了。这类错误用户能自己重试，
 * 所以不常驻（8s 自动消失，仍然可以手动关）。
 */
function alertRedisFailure(failure: unknown, title: string): void {
  const info = toDbError(failure);
  pushToast(info.message, "error", {
    title,
    label: info.stage,
    detail: info.detail ?? undefined,
    persist: false,
  });
}

/** 与后端 `SET_PAGE_MAX` 对齐：SSCAN 单页最多 500 个成员。 */
const SET_PAGE_SIZE = 500;

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

function kindBadgeClass(kind: string) {
  return KIND_BADGE[kind] ?? KIND_BADGE.other;
}

function formatTtl(ttlMs: number): string {
  if (ttlMs === -1) return "∞";
  if (ttlMs < 0) return "—";
  const seconds = Math.round(ttlMs / 1000);
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)}h`;
  return `${Math.round(seconds / 86400)}d`;
}

/** 快捷 TTL 选项（毫秒）；null = 永久。 */
const TTL_PRESETS: Array<{ label: string; ms: number | null }> = [
  { label: "1h", ms: 3_600_000 },
  { label: "24h", ms: 86_400_000 },
  { label: "7d", ms: 7 * 86_400_000 },
  { label: "∞", ms: null },
];

export function RedisBrowser({
  profile,
}: {
  profile: DatabaseProfile;
}) {
  const { t } = useTranslation();
  const status = useDatabaseStore((state) => state.statuses[profile.id]);
  const sessionError = useDatabaseStore((state) => state.sessionErrors[profile.id]);
  const connecting = useDatabaseStore(
    (state) => !!state.redisConnecting[profile.id],
  );
  const redisConnect = useDatabaseStore((state) => state.redisConnect);
  const redisReconnect = useDatabaseStore((state) => state.redisReconnect);
  const refreshStatus = useDatabaseStore((state) => state.refreshStatus);
  /** Redis 的连接状态唯一来源：Rust 运行时状态，绝不看 SQL 会话。 */
  const connected = !!status?.connected;

  const [dbIndex, setDbIndex] = useState(() => {
    const parsed = Number(profile.default_database ?? "0");
    return Number.isInteger(parsed) && parsed >= 0 && parsed <= 15 ? parsed : 0;
  });
  const [pattern, setPattern] = useState("*");
  const [keys, setKeys] = useState<RedisKeyBrief[]>([]);
  const [cursor, setCursor] = useState(0);
  const [dbsize, setDbsize] = useState<number | null>(null);
  const [scanning, setScanning] = useState(false);

  // SCAN 竞态守卫：递增序号标识"最新一次扫描"。晚到的旧响应直接丢弃，
  // 否则旧结果会覆盖新结果（cursor 回退）或把同一批键 append 两次（重复键）。
  const scanSeqRef = useRef(0);

  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [keyInfo, setKeyInfo] = useState<RedisKeyInfo | null>(null);
  const [payload, setPayload] = useState<RedisValuePayload | null>(null);
  const [loadingValue, setLoadingValue] = useState(false);

  // 键详情竞态守卫：快速连点两个键时，晚到的旧键响应不能覆盖新键。
  const keySeqRef = useRef(0);

  const [pubsubOpen, setPubsubOpen] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const writable = !profile.read_only;

  /*
   * 首次挂载：先回读运行时状态，确认没连上才建连。
   *
   * 不能拿挂载瞬间的 statuses 判断 —— 侧栏刚点过"打开连接"时状态可能还没
   * 写回，那样会再发一条 db_redis_connect。store 里还有 in-flight 去重兜底。
   */
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      await refreshStatus(profile.id);
      if (cancelled) return;
      if (useDatabaseStore.getState().statuses[profile.id]?.connected) return;
      await redisConnect(profile.id);
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile.id]);

  const runScan = useCallback(
    async (reset: boolean) => {
      const seq = ++scanSeqRef.current;
      setScanning(true);
      try {
        const page = await databaseApi.redisScan(
          profile.id,
          dbIndex,
          pattern || "*",
          reset ? 0 : cursor,
          100,
        );
        // 过期响应：期间已有更新的扫描发起，丢弃，绝不覆盖新状态。
        if (seq !== scanSeqRef.current) return;
        setKeys((current) => {
          const merged = reset ? page.keys : [...current, ...page.keys];
          // 兜底去重：SCAN 重扫到同一个键、或双击"继续扫描"时不产生重复行。
          const seen = new Set<string>();
          const deduped = merged.filter((entry) =>
            seen.has(entry.key) ? false : (seen.add(entry.key), true),
          );
          // 前端累计上限：无限翻页会把内存吃光（10 万行约 30 MB 且不再释放）。
          return deduped.slice(0, MAX_SCAN_KEYS);
        });
        setCursor(page.cursor);
        setDbsize(page.dbsize);
      } catch (failure) {
        if (seq === scanSeqRef.current) alertRedisFailure(failure, t("扫描失败"));
      } finally {
        // 只有最新请求有权解除扫描态，避免旧请求提前解除。
        if (seq === scanSeqRef.current) setScanning(false);
      }
    },
    [profile.id, dbIndex, pattern, cursor, t],
  );

  // db 或模式变化：从头扫一页。没连上时绝不发 SCAN，否则只会拿到
  // "Redis 连接尚未建立"这种没意义的报错。
  useEffect(() => {
    if (!connected) return;
    void runScan(true);
    setSelectedKey(null);
    setKeyInfo(null);
    setPayload(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile.id, dbIndex, connected]);

  const loadKey = useCallback(
    async (key: string, full = false) => {
      const seq = ++keySeqRef.current;
      setSelectedKey(key);
      setLoadingValue(true);
      try {
        const [info, value] = await Promise.all([
          databaseApi.redisKeyInfo(profile.id, dbIndex, key),
          // 默认只取预览：大 string 只回前 256 KiB，完整内容要显式 full。
          databaseApi.redisReadValue(profile.id, dbIndex, key, full),
        ]);
        // 期间用户已点选了另一个键：丢弃本次响应。
        if (seq !== keySeqRef.current) return;
        setKeyInfo(info);
        setPayload(value);
      } catch (failure) {
        if (seq !== keySeqRef.current) return;
        alertRedisFailure(failure, t("读取键失败"));
        setKeyInfo(null);
        setPayload(null);
      } finally {
        if (seq === keySeqRef.current) setLoadingValue(false);
      }
    },
    [profile.id, dbIndex, t],
  );

  /** 写操作统一包装：成功后重读当前键 + 刷新列表 TTL/存在性。 */
  const mutate = useCallback(
    async (action: () => Promise<void>, successNotice?: string) => {
      try {
        await action();
        if (successNotice) setNotice(successNotice);
        if (selectedKey) await loadKey(selectedKey);
        void runScan(true);
      } catch (failure) {
        alertRedisFailure(failure, t("操作失败"));
      }
    },
    [selectedKey, loadKey, runScan, t],
  );

  return (
    <div className="relative flex h-full min-h-0 flex-col bg-surface-1">
      {/* 顶栏 */}
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-line px-3">
        <span className="min-w-0 truncate text-12 font-medium text-fg-muted">
          {profile.name}
        </span>
        <span
          className={cn(
            "h-1.5 w-1.5 shrink-0 rounded-full",
            connected
              ? "bg-success"
              : sessionError
                ? "bg-danger"
                : connecting
                  ? "bg-warning"
                  : "bg-fg-subtle/40",
          )}
        />
        {connected && status.server_version && (
          <span className="shrink-0 text-11 text-fg-subtle">
            Redis {status.server_version}
          </span>
        )}
        {dbsize !== null && (
          <span className="shrink-0 text-11 text-fg-subtle">
            {t("{{count}} 键", { count: dbsize })}
          </span>
        )}
        <div className="flex-1" />
        {notice && (
          <span className="truncate text-11 text-success">{notice}</span>
        )}
        {profile.read_only && (
          <span className="shrink-0 rounded bg-surface-hover px-1.5 py-0.5 text-10 text-fg-muted">
            {t("只读")}
          </span>
        )}
        {writable && (
          <Tooltip label={t("发布 / 订阅")} side="bottom">
            <Button
              variant="ghost"
              size="xs"
              className="h-5 w-5 px-0"
              aria-label={t("发布 / 订阅")}
              onClick={() => setPubsubOpen((open) => !open)}
            >
              <PlugZap size={13} />
            </Button>
          </Tooltip>
        )}
        <Tooltip label={connected ? t("刷新") : t("重新连接")} side="bottom">
          <Button
            variant="ghost"
            size="xs"
            className="h-5 w-5 px-0"
            aria-label={connected ? t("刷新") : t("重新连接")}
            disabled={connecting}
            onClick={() =>
              void (connected ? runScan(true) : redisReconnect(profile.id))
            }
          >
            <RefreshCw
              size={11}
              className={cn((scanning || connecting) && "animate-spin")}
            />
          </Button>
        </Tooltip>
      </div>

      {/* 搜索条 */}
      <div className="flex shrink-0 items-center gap-2 border-b border-line px-3 py-1.5">
        <Select
          value={String(dbIndex)}
          ariaLabel={t("db index")}
          onChange={(value) => setDbIndex(Number(value))}
          className="w-24"
          options={Array.from({ length: 16 }, (_, index) => ({
            value: String(index),
            label: `db ${index}`,
          }))}
        />
        <input
          className="h-[26px] min-w-0 flex-1 rounded-[6px] border border-line bg-surface-1 px-2 text-12 text-fg outline-none placeholder:text-fg-subtle focus:border-accent"
          value={pattern}
          onChange={(event) => setPattern(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") void runScan(true);
          }}
          placeholder={t("键名模式，例如 user:* 或 session:*")}
          aria-label={t("键名模式")}
        />
        <Button
          variant="secondary"
          size="xs"
          disabled={scanning || !connected}
          onClick={() => void runScan(true)}
        >
          {scanning ? <Loader2 size={11} className="animate-spin" /> : <RefreshCw size={11} />}
          {t("扫描")}
        </Button>
        {writable && (
          <Tooltip label={t("新建 string 键")} side="bottom">
            <Button
              variant="ghost"
              size="xs"
              className="h-5 w-5 px-0"
              aria-label={t("新建 string 键")}
              onClick={() => {
                const key = window.prompt(t("新键名"));
                if (!key?.trim()) return;
                const value = window.prompt(t("初始值"), "") ?? "";
                // 新建走 SET NX：键已存在时报错，绝不静默覆盖旧键。
                void mutate(
                  () =>
                    databaseApi.redisCreateString(profile.id, dbIndex, key.trim(), value),
                  t("键已创建"),
                );
              }}
            >
              <Plus size={13} />
            </Button>
          </Tooltip>
        )}
      </div>

      {/* 连接/扫描错误统一走顶部 alert（ToastHost），这里只留内容区的空态说明。 */}
      {!connected ? (
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 px-6">
          {connecting ? (
            <>
              <Loader2 size={18} className="animate-spin text-fg-subtle" />
              <p className="text-12 text-fg-subtle">
                {t("正在连接 {{name}}…", { name: profile.name })}
              </p>
            </>
          ) : (
            <>
              <TriangleAlert
                size={18}
                className={sessionError ? "text-danger" : "text-fg-subtle"}
              />
              <p className="max-w-md text-center text-12 leading-relaxed text-fg-muted">
                {sessionError?.message ?? t("连接已关闭，未连接到 Redis。")}
              </p>
              {sessionError?.detail && (
                <p className="max-w-md break-words text-center text-11 text-fg-subtle">
                  {sessionError.detail}
                </p>
              )}
              <Button
                variant="secondary"
                size="sm"
                onClick={() => void redisReconnect(profile.id)}
              >
                <RefreshCw size={12} />
                {t("重新连接")}
              </Button>
            </>
          )}
        </div>
      ) : (
        <div className="flex min-h-0 flex-1">
        {/* 键列表 */}
        <div className="flex w-[280px] shrink-0 flex-col border-r border-line">
          <div className="min-h-0 flex-1 overflow-y-auto px-1 py-1">
            {keys.length === 0 && !scanning && (
              <p className="px-2 py-4 text-11 leading-relaxed text-fg-subtle">
                {t("没有匹配的键。调整模式后回车重新扫描。")}
              </p>
            )}
            {keys.map((entry) => (
              <button
                key={entry.key}
                className={cn(
                  "flex w-full items-center gap-1.5 rounded-[6px] px-2 py-1 text-left hover:bg-surface-hover",
                  selectedKey === entry.key && "bg-accent/10 ring-1 ring-inset ring-accent/20",
                )}
                onClick={() => void loadKey(entry.key)}
              >
                <span
                  className={cn(
                    "shrink-0 rounded px-1 py-px text-9 font-medium",
                    kindBadgeClass(entry.kind),
                  )}
                >
                  {entry.kind}
                </span>
                <span className="min-w-0 flex-1 truncate text-12 text-fg">{entry.key}</span>
                <span className="shrink-0 text-10 text-fg-subtle">
                  {formatTtl(entry.ttl_ms)}
                </span>
              </button>
            ))}
            {cursor !== 0 && (
              <div className="px-2 py-1.5">
                <Button
                  variant="ghost"
                  size="xs"
                  className="w-full"
                  disabled={scanning || keys.length >= MAX_SCAN_KEYS}
                  onClick={() => void runScan(false)}
                >
                  {scanning
                    ? t("扫描中…")
                    : keys.length >= MAX_SCAN_KEYS
                      ? t("已到 {{count}} 个键上限，请用模式缩小范围", {
                          count: MAX_SCAN_KEYS,
                        })
                      : t("继续扫描（还有更多键）")}
                </Button>
              </div>
            )}
          </div>
        </div>

        {/* 值面板 */}
        <div className="min-w-0 flex-1 overflow-y-auto">
          {!selectedKey && (
            <div className="flex h-full items-center justify-center px-6">
              <p className="text-center text-12 leading-relaxed text-fg-subtle">
                {t("从左侧选择一个键查看内容")}
              </p>
            </div>
          )}
          {selectedKey && loadingValue && (
            <div className="flex h-full items-center justify-center">
              <Loader2 size={16} className="animate-spin text-fg-subtle" />
            </div>
          )}
          {selectedKey && !loadingValue && (
            <ValuePanel
              profile={profile}
              dbIndex={dbIndex}
              selectedKey={selectedKey}
              keyInfo={keyInfo}
              payload={payload}
              mutate={mutate}
              onReadFull={() => void loadKey(selectedKey, true)}
              onDeleted={() => {
                setSelectedKey(null);
                setKeyInfo(null);
                setPayload(null);
                void runScan(true);
              }}
            />
          )}
        </div>
        </div>
      )}

      {pubsubOpen && writable && (
        <PubSubPanel
          profile={profile}
          dbIndex={dbIndex}
          onClose={() => setPubsubOpen(false)}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// 值面板
// ---------------------------------------------------------------------------

function ValuePanel({
  profile,
  dbIndex,
  selectedKey,
  keyInfo,
  payload,
  mutate,
  onReadFull,
  onDeleted,
}: {
  profile: DatabaseProfile;
  dbIndex: number;
  selectedKey: string;
  keyInfo: RedisKeyInfo | null;
  payload: RedisValuePayload | null;
  mutate: (action: () => Promise<void>, successNotice?: string) => Promise<void>;
  /** 大 string 只回了预览：显式请求全量（后端有 8 MiB 硬上限）。 */
  onReadFull: () => void;
  onDeleted: () => void;
}) {
  const { t } = useTranslation();
  const writable = !profile.read_only;
  const [renaming, setRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState("");
  // 默认不覆盖：RENAMENX 目标存在即报错，勾选后才退回 RENAME。
  const [renameOverwrite, setRenameOverwrite] = useState(false);

  if (!payload) {
    return (
      <div className="flex h-full items-center justify-center px-6">
        <p className="text-center text-12 text-fg-subtle">{t("无法读取该键的内容")}</p>
      </div>
    );
  }

  const confirmDelete = () => {
    if (!window.confirm(t("删除键 {{key}}？该操作不可撤销。", { key: selectedKey }))) return;
    void mutate(() => databaseApi.redisKeyDelete(profile.id, dbIndex, selectedKey));
    onDeleted();
  };

  return (
    <div className="flex flex-col gap-2 p-3">
      {/* 元信息条 */}
      <div className="flex flex-wrap items-center gap-2 rounded-[8px] border border-line bg-surface-2/60 px-2.5 py-1.5">
        <span className="min-w-0 flex-1 truncate font-mono text-12 font-medium text-fg">
          {selectedKey}
        </span>
        {keyInfo && (
          <>
            <span className={cn("rounded px-1 py-px text-9 font-medium", kindBadgeClass(keyInfo.kind))}>
              {keyInfo.kind}
            </span>
            <span className="text-10 text-fg-subtle">TTL {formatTtl(keyInfo.ttl_ms)}</span>
            {keyInfo.memory_bytes !== null && (
              <span className="text-10 text-fg-subtle">
                {t("内存 {{bytes}} B", { bytes: keyInfo.memory_bytes })}
              </span>
            )}
          </>
        )}
        {writable && (
          <>
            <Tooltip label={t("重命名键")} side="top">
              <Button
                variant="ghost"
                size="xs"
                className="h-5 w-5 px-0"
                aria-label={t("重命名键")}
                onClick={() => {
                  setRenameValue(selectedKey);
                  setRenameOverwrite(false);
                  setRenaming(true);
                }}
              >
                <Pencil size={12} />
              </Button>
            </Tooltip>
            <Tooltip label={t("删除键")} side="top">
              <Button
                variant="ghost"
                size="xs"
                className="h-5 w-5 px-0 text-danger"
                aria-label={t("删除键")}
                onClick={confirmDelete}
              >
                <Trash2 size={12} />
              </Button>
            </Tooltip>
          </>
        )}
      </div>

      {/* TTL 快捷操作 */}
      {writable && keyInfo && (
        <div className="flex items-center gap-1.5 text-11 text-fg-muted">
          <span className="text-fg-subtle">TTL:</span>
          {TTL_PRESETS.map((preset) => (
            <Button
              key={preset.label}
              variant="ghost"
              size="xs"
              className="h-5 px-1.5"
              onClick={() =>
                void mutate(
                  () =>
                    databaseApi.redisKeyExpire(profile.id, dbIndex, selectedKey, preset.ms),
                  preset.ms === null ? t("已设为永久") : t("TTL 已更新"),
                )
              }
            >
              {preset.label}
            </Button>
          ))}
        </div>
      )}

      {renaming && writable && (
        <div className="flex items-center gap-2 rounded-[8px] border border-accent/40 bg-accent/5 px-2 py-1.5">
          <input
            className="h-[26px] min-w-0 flex-1 rounded-[6px] border border-line bg-surface-1 px-2 font-mono text-12 text-fg outline-none focus:border-accent"
            value={renameValue}
            onChange={(event) => setRenameValue(event.target.value)}
            autoFocus
          />
          <label className="flex shrink-0 items-center gap-1 text-10 text-warning">
            <input
              type="checkbox"
              checked={renameOverwrite}
              onChange={(event) => setRenameOverwrite(event.target.checked)}
            />
            {t("覆盖同名键")}
          </label>
          <Button
            variant="secondary"
            size="xs"
            onClick={() =>
              void mutate(
                () =>
                  databaseApi.redisKeyRename(
                    profile.id,
                    dbIndex,
                    selectedKey,
                    renameValue,
                    // 默认 RENAMENX：目标已存在就报错，勾选后才允许覆盖。
                    renameOverwrite,
                  ),
                t("已重命名"),
              ).then(() => setRenaming(false))
            }
          >
            {t("确认")}
          </Button>
          <Button variant="ghost" size="xs" onClick={() => setRenaming(false)}>
            {t("取消")}
          </Button>
        </div>
      )}

      {payload.kind === "string" && (
        <StringEditor
          profile={profile}
          dbIndex={dbIndex}
          selectedKey={selectedKey}
          payload={payload}
          mutate={mutate}
          onReadFull={onReadFull}
        />
      )}
      {payload.kind === "hash" && (
        <HashEditor
          profile={profile}
          dbIndex={dbIndex}
          selectedKey={selectedKey}
          payload={payload}
          mutate={mutate}
        />
      )}
      {payload.kind === "list" && (
        <ListEditor
          profile={profile}
          dbIndex={dbIndex}
          selectedKey={selectedKey}
          payload={payload}
          mutate={mutate}
        />
      )}
      {payload.kind === "set" && (
        <SetEditor
          profile={profile}
          dbIndex={dbIndex}
          selectedKey={selectedKey}
          payload={payload}
          mutate={mutate}
        />
      )}
      {payload.kind === "zset" && (
        <ZsetEditor
          profile={profile}
          dbIndex={dbIndex}
          selectedKey={selectedKey}
          payload={payload}
          mutate={mutate}
        />
      )}
      {payload.kind === "stream" && <StreamTable payload={payload} />}
      {payload.kind === "other" && (
        <p className="rounded-[8px] border border-line bg-surface-2/60 px-3 py-2 text-12 text-fg-muted">
          {t("类型 {{type}} 的键暂不支持查看。", { type: payload.type_name })}
        </p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// string
// ---------------------------------------------------------------------------

function StringEditor({
  profile,
  dbIndex,
  selectedKey,
  payload,
  mutate,
  onReadFull,
}: {
  profile: DatabaseProfile;
  dbIndex: number;
  selectedKey: string;
  payload: Extract<RedisValuePayload, { kind: "string" }>;
  mutate: (action: () => Promise<void>, successNotice?: string) => Promise<void>;
  onReadFull: () => void;
}) {
  const { t } = useTranslation();
  // 二进制值以 Base64 显示，仍可编辑 —— 保存时后端先 Base64 解码再写入，
  // 字节本体无损往返。
  // 截断的预览**不能**编辑：把前 256 KiB 写回去等于毁掉原值。
  const writable = !profile.read_only && !payload.truncated;
  const [value, setValue] = useState(payload.value);
  useEffect(() => setValue(payload.value), [payload.value]);

  const isJson = useMemo(() => {
    if (payload.binary) return false;
    try {
      JSON.parse(payload.value);
      return true;
    } catch {
      return false;
    }
  }, [payload.value, payload.binary]);

  return (
    <div className="flex flex-col gap-1.5">
      {payload.truncated && (
        <div className="flex flex-wrap items-center gap-2 rounded-[6px] border border-warning/40 bg-warning/10 px-2 py-1 text-11 text-warning">
          <span className="min-w-0 flex-1">
            {t("值有 {{bytes}} 字节，这里只显示前 256 KiB（不可编辑）", {
              bytes: payload.bytes.toLocaleString(),
            })}
          </span>
          <Button variant="secondary" size="xs" onClick={onReadFull}>
            {t("读取完整值")}
          </Button>
        </div>
      )}
      <div className="flex items-center gap-2 text-11 text-fg-subtle">
        {payload.binary ? (
          <>
            <span className="rounded bg-warning/15 px-1 py-px text-10 font-medium text-warning">
              {t("二进制")}
            </span>
            <span>{t("以 Base64 编码显示，保存时自动解码，数据无损")}</span>
          </>
        ) : (
          <span>{t("{{bytes}} 字节", { bytes: payload.bytes.toLocaleString() })}</span>
        )}
        {isJson && (
          <button
            className="text-accent"
            onClick={() => {
              try {
                setValue(JSON.stringify(JSON.parse(value), null, 2));
              } catch {
                // 不是合法 JSON 时保持原样。
              }
            }}
          >
            {t("格式化 JSON")}
          </button>
        )}
      </div>
      <textarea
        className="min-h-[220px] resize-y rounded-[8px] border border-line bg-surface-1 p-2 font-mono text-12 leading-relaxed text-fg outline-none focus:border-accent disabled:bg-surface-2 disabled:text-fg-subtle"
        value={value}
        onChange={(event) => setValue(event.target.value)}
        readOnly={payload.truncated}
        spellCheck={false}
      />
      {writable && value !== payload.value && (
        <div className="flex items-center gap-2">
          <Button
            variant="primary"
            size="xs"
            onClick={() =>
              void mutate(
                () =>
                  databaseApi.redisWriteString(
                    profile.id,
                    dbIndex,
                    selectedKey,
                    value,
                    payload.binary,
                  ),
                t("已保存"),
              )
            }
          >
            {t("保存修改")}
          </Button>
          <Button variant="ghost" size="xs" onClick={() => setValue(payload.value)}>
            {t("还原")}
          </Button>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// hash
// ---------------------------------------------------------------------------

function HashEditor({
  profile,
  dbIndex,
  selectedKey,
  payload,
  mutate,
}: {
  profile: DatabaseProfile;
  dbIndex: number;
  selectedKey: string;
  payload: Extract<RedisValuePayload, { kind: "hash" }>;
  mutate: (action: () => Promise<void>, successNotice?: string) => Promise<void>;
}) {
  const { t } = useTranslation();
  const writable = !profile.read_only;
  const [editing, setEditing] = useState<RedisFieldEntry | null>(null);
  const [newField, setNewField] = useState("");
  const [newValue, setNewValue] = useState("");

  // hash 走 HSCAN 分页：首页来自 payload，"加载更多"用 cursor 续扫。
  const [rows, setRows] = useState<RedisFieldEntry[]>(payload.fields);
  const [hashCursor, setHashCursor] = useState(payload.cursor);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  // 键重读（写操作后）或切换键：行列表重置为服务端最新首页。
  useEffect(() => {
    setRows(payload.fields);
    setHashCursor(payload.cursor);
    setLoadError(null);
  }, [payload]);

  const loadMore = async () => {
    setLoadingMore(true);
    setLoadError(null);
    try {
      const page = await databaseApi.redisHashScan(
        profile.id,
        dbIndex,
        selectedKey,
        hashCursor,
        200,
      );
      setRows((current) => {
        const seen = new Set(current.map((entry) => entry.field));
        return [...current, ...page.fields.filter((entry) => !seen.has(entry.field))];
      });
      setHashCursor(page.cursor);
    } catch (failure) {
      setLoadError(toDbError(failure).message);
    } finally {
      setLoadingMore(false);
    }
  };

  return (
    <div className="flex flex-col gap-1.5">
      <div className="text-11 text-fg-subtle">
        {t("{{shown}} / {{total}} 字段", { shown: rows.length, total: payload.length })}
      </div>
      <div className="overflow-hidden rounded-[8px] border border-line">
        {rows.map((entry) => (
          <div
            key={entry.field}
            className="flex items-center gap-2 border-b border-line/60 px-2 py-1 last:border-b-0"
          >
            <span className="w-[160px] shrink-0 truncate font-mono text-11 text-fg-muted">
              {entry.field}
            </span>
            {editing?.field === entry.field ? (
              <>
                <input
                  className="h-[24px] min-w-0 flex-1 rounded border border-accent/50 bg-surface-1 px-1.5 font-mono text-11 text-fg outline-none"
                  value={editing.value}
                  onChange={(event) => setEditing({ ...editing, value: event.target.value })}
                  autoFocus
                />
                <Button
                  variant="primary"
                  size="xs"
                  className="h-5"
                  onClick={() => {
                    void mutate(
                      () =>
                        databaseApi.redisWriteHashField(
                          profile.id,
                          dbIndex,
                          selectedKey,
                          entry.field,
                          editing.value,
                        ),
                      t("已保存"),
                    );
                    setEditing(null);
                  }}
                >
                  {t("保存")}
                </Button>
                <Button variant="ghost" size="xs" className="h-5" onClick={() => setEditing(null)}>
                  {t("取消")}
                </Button>
              </>
            ) : (
              <>
                <span className="min-w-0 flex-1 truncate font-mono text-11 text-fg">
                  {entry.value}
                </span>
                {writable && (
                  <>
                    <Button
                      variant="ghost"
                      size="xs"
                      className="h-5 w-5 px-0"
                      aria-label={t("编辑字段")}
                      onClick={() => setEditing(entry)}
                    >
                      <Pencil size={11} />
                    </Button>
                    <Button
                      variant="ghost"
                      size="xs"
                      className="h-5 w-5 px-0 text-danger"
                      aria-label={t("删除字段")}
                      onClick={() =>
                        void mutate(
                          () =>
                            databaseApi.redisWriteHashField(
                              profile.id,
                              dbIndex,
                              selectedKey,
                              entry.field,
                              null,
                            ),
                          t("字段已删除"),
                        )
                      }
                    >
                      <Trash2 size={11} />
                    </Button>
                  </>
                )}
              </>
            )}
          </div>
        ))}
      </div>
      {loadError && <p className="text-11 text-danger">{loadError}</p>}
      {hashCursor !== 0 && (
        <Button
          variant="ghost"
          size="xs"
          className="w-full"
          disabled={loadingMore}
          onClick={() => void loadMore()}
        >
          {loadingMore ? (
            <Loader2 size={11} className="animate-spin" />
          ) : (
            t("加载更多字段（HSCAN 续扫）")
          )}
        </Button>
      )}
      {writable && (
        <div className="flex items-center gap-2">
          <input
            className="h-[26px] w-[160px] rounded-[6px] border border-line bg-surface-1 px-2 font-mono text-11 text-fg outline-none focus:border-accent"
            placeholder={t("字段名")}
            value={newField}
            onChange={(event) => setNewField(event.target.value)}
          />
          <input
            className="h-[26px] min-w-0 flex-1 rounded-[6px] border border-line bg-surface-1 px-2 font-mono text-11 text-fg outline-none focus:border-accent"
            placeholder={t("值")}
            value={newValue}
            onChange={(event) => setNewValue(event.target.value)}
          />
          <Button
            variant="secondary"
            size="xs"
            disabled={!newField.trim()}
            onClick={() => {
              void mutate(
                () =>
                  databaseApi.redisWriteHashField(
                    profile.id,
                    dbIndex,
                    selectedKey,
                    newField.trim(),
                    newValue,
                  ),
                t("字段已写入"),
              );
              setNewField("");
              setNewValue("");
            }}
          >
            {t("添加字段")}
          </Button>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// list
// ---------------------------------------------------------------------------

function ListEditor({
  profile,
  dbIndex,
  selectedKey,
  payload,
  mutate,
}: {
  profile: DatabaseProfile;
  dbIndex: number;
  selectedKey: string;
  payload: Extract<RedisValuePayload, { kind: "list" }>;
  mutate: (action: () => Promise<void>, successNotice?: string) => Promise<void>;
}) {
  const { t } = useTranslation();
  const writable = !profile.read_only && !payload.truncated;
  const [pushValue, setPushValue] = useState("");

  return (
    <div className="flex flex-col gap-1.5">
      <div className="text-11 text-fg-subtle">
        {payload.length} 项
        {payload.truncated && `（${t("仅显示前 {{count}} 项，长列表暂不支持编辑", { count: payload.items.length })}）`}
      </div>
      <div className="overflow-hidden rounded-[8px] border border-line">
        {payload.items.map((item, index) => (
          <ListRow
            key={`${index}-${item}`}
            index={index}
            item={item}
            writable={writable}
            onSave={(value) =>
              mutate(
                () =>
                  databaseApi.redisWriteList(profile.id, dbIndex, selectedKey, {
                    set: { index, value },
                  }),
                t("已保存"),
              )
            }
            onRemove={() =>
              mutate(
                () =>
                  databaseApi.redisWriteList(profile.id, dbIndex, selectedKey, {
                    remove: { value: item },
                  }),
                t("已删除"),
              )
            }
          />
        ))}
      </div>
      {writable && (
        <div className="flex items-center gap-2">
          <input
            className="h-[26px] min-w-0 flex-1 rounded-[6px] border border-line bg-surface-1 px-2 font-mono text-11 text-fg outline-none focus:border-accent"
            placeholder={t("新元素值")}
            value={pushValue}
            onChange={(event) => setPushValue(event.target.value)}
          />
          <Button
            variant="secondary"
            size="xs"
            disabled={!pushValue}
            onClick={() => {
              void mutate(
                () =>
                  databaseApi.redisWriteList(profile.id, dbIndex, selectedKey, {
                    push: { front: true, value: pushValue },
                  }),
                t("已插入头部"),
              );
              setPushValue("");
            }}
          >
            {t("头部插入")}
          </Button>
          <Button
            variant="secondary"
            size="xs"
            disabled={!pushValue}
            onClick={() => {
              void mutate(
                () =>
                  databaseApi.redisWriteList(profile.id, dbIndex, selectedKey, {
                    push: { front: false, value: pushValue },
                  }),
                t("已追加尾部"),
              );
              setPushValue("");
            }}
          >
            {t("尾部追加")}
          </Button>
        </div>
      )}
    </div>
  );
}

function ListRow({
  index,
  item,
  writable,
  onSave,
  onRemove,
}: {
  index: number;
  item: string;
  writable: boolean;
  onSave: (value: string) => void;
  onRemove: () => void;
}) {
  const { t } = useTranslation();
  const [editing, setEditing] = useState<string | null>(null);
  return (
    <div className="flex items-center gap-2 border-b border-line/60 px-2 py-1 last:border-b-0">
      <span className="w-8 shrink-0 text-right font-mono text-10 text-fg-subtle">{index}</span>
      {editing !== null ? (
        <>
          <input
            className="h-[24px] min-w-0 flex-1 rounded border border-accent/50 bg-surface-1 px-1.5 font-mono text-11 text-fg outline-none"
            value={editing}
            onChange={(event) => setEditing(event.target.value)}
            autoFocus
          />
          <Button variant="primary" size="xs" className="h-5" onClick={() => { onSave(editing); setEditing(null); }}>
            {t("保存")}
          </Button>
          <Button variant="ghost" size="xs" className="h-5" onClick={() => setEditing(null)}>
            {t("取消")}
          </Button>
        </>
      ) : (
        <>
          <span className="min-w-0 flex-1 truncate font-mono text-11 text-fg">{item}</span>
          {writable && (
            <>
              <Button
                variant="ghost"
                size="xs"
                className="h-5 w-5 px-0"
                aria-label={t("编辑元素")}
                onClick={() => setEditing(item)}
              >
                <Pencil size={11} />
              </Button>
              <Button
                variant="ghost"
                size="xs"
                className="h-5 w-5 px-0 text-danger"
                aria-label={t("删除元素")}
                onClick={onRemove}
              >
                <Trash2 size={11} />
              </Button>
            </>
          )}
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// set
// ---------------------------------------------------------------------------

function SetEditor({
  profile,
  dbIndex,
  selectedKey,
  payload,
  mutate,
}: {
  profile: DatabaseProfile;
  dbIndex: number;
  selectedKey: string;
  payload: Extract<RedisValuePayload, { kind: "set" }>;
  mutate: (action: () => Promise<void>, successNotice?: string) => Promise<void>;
}) {
  const { t } = useTranslation();
  const writable = !profile.read_only;
  const [newMember, setNewMember] = useState("");
  // SSCAN 续扫：首屏只给一页，剩下的按游标追加（顺序稳定、不重复）。
  const [extra, setExtra] = useState<string[]>([]);
  const [cursor, setCursor] = useState(payload.cursor);
  const [loadingMore, setLoadingMore] = useState(false);
  useEffect(() => {
    setExtra([]);
    setCursor(payload.cursor);
  }, [payload]);

  const members = useMemo(() => {
    const seen = new Set<string>();
    return [...payload.members, ...extra].filter((member) =>
      seen.has(member) ? false : (seen.add(member), true),
    );
  }, [payload.members, extra]);

  const loadMore = async () => {
    if (cursor === 0 || loadingMore) return;
    setLoadingMore(true);
    try {
      const page = await databaseApi.redisSetScan(
        profile.id,
        dbIndex,
        selectedKey,
        cursor,
        SET_PAGE_SIZE,
      );
      setExtra((current) => [...current, ...page.members]);
      setCursor(page.cursor);
    } finally {
      setLoadingMore(false);
    }
  };

  return (
    <div className="flex flex-col gap-1.5">
      <div className="text-11 text-fg-subtle">
        {payload.length} 成员
        {payload.truncated && `（${t("显示前 {{count}} 个", { count: members.length })}）`}
      </div>
      <div className="overflow-hidden rounded-[8px] border border-line">
        {members.map((member) => (
          <div key={member} className="flex items-center gap-2 border-b border-line/60 px-2 py-1 last:border-b-0">
            <span className="min-w-0 flex-1 truncate font-mono text-11 text-fg">{member}</span>
            {writable && (
              <Button
                variant="ghost"
                size="xs"
                className="h-5 w-5 px-0 text-danger"
                aria-label={t("移除成员")}
                onClick={() =>
                  void mutate(
                    () => databaseApi.redisWriteSet(profile.id, dbIndex, selectedKey, member, false),
                    t("已移除"),
                  )
                }
              >
                <Trash2 size={11} />
              </Button>
            )}
          </div>
        ))}
      </div>
      {cursor !== 0 && (
        <Button variant="ghost" size="xs" disabled={loadingMore} onClick={() => void loadMore()}>
          {loadingMore
            ? t("加载中…")
            : t("加载更多（还有 {{count}} 个）", {
                count: Math.max(payload.length - members.length, 0),
              })}
        </Button>
      )}
      {writable && (
        <div className="flex items-center gap-2">
          <input
            className="h-[26px] min-w-0 flex-1 rounded-[6px] border border-line bg-surface-1 px-2 font-mono text-11 text-fg outline-none focus:border-accent"
            placeholder={t("新成员")}
            value={newMember}
            onChange={(event) => setNewMember(event.target.value)}
          />
          <Button
            variant="secondary"
            size="xs"
            disabled={!newMember.trim()}
            onClick={() => {
              void mutate(
                () =>
                  databaseApi.redisWriteSet(profile.id, dbIndex, selectedKey, newMember.trim(), true),
                t("已加入"),
              );
              setNewMember("");
            }}
          >
            {t("添加成员")}
          </Button>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// zset
// ---------------------------------------------------------------------------

function ZsetEditor({
  profile,
  dbIndex,
  selectedKey,
  payload,
  mutate,
}: {
  profile: DatabaseProfile;
  dbIndex: number;
  selectedKey: string;
  payload: Extract<RedisValuePayload, { kind: "zset" }>;
  mutate: (action: () => Promise<void>, successNotice?: string) => Promise<void>;
}) {
  const { t } = useTranslation();
  const writable = !profile.read_only;
  const [newMember, setNewMember] = useState("");
  const [newScore, setNewScore] = useState("");

  const updateScore = (entry: RedisZEntry, score: number) => {
    void mutate(
      () => databaseApi.redisWriteZset(profile.id, dbIndex, selectedKey, entry.member, score),
      t("分数已更新"),
    );
  };

  return (
    <div className="flex flex-col gap-1.5">
      <div className="text-11 text-fg-subtle">
        {payload.length} 成员
        {payload.truncated && `（${t("显示前 {{count}} 个", { count: payload.entries.length })}）`}
      </div>
      <div className="overflow-hidden rounded-[8px] border border-line">
        {payload.entries.map((entry) => (
          <ZsetRow
            key={entry.member}
            entry={entry}
            writable={writable}
            onSave={updateScore}
            onRemove={() =>
              mutate(
                () => databaseApi.redisWriteZset(profile.id, dbIndex, selectedKey, entry.member, null),
                t("已移除"),
              )
            }
          />
        ))}
      </div>
      {writable && (
        <div className="flex items-center gap-2">
          <input
            className="h-[26px] min-w-0 flex-1 rounded-[6px] border border-line bg-surface-1 px-2 font-mono text-11 text-fg outline-none focus:border-accent"
            placeholder={t("新成员")}
            value={newMember}
            onChange={(event) => setNewMember(event.target.value)}
          />
          <input
            className="h-[26px] w-[120px] rounded-[6px] border border-line bg-surface-1 px-2 font-mono text-11 text-fg outline-none focus:border-accent"
            placeholder={t("分数")}
            value={newScore}
            onChange={(event) => setNewScore(event.target.value)}
          />
          <Button
            variant="secondary"
            size="xs"
            disabled={!newMember.trim() || newScore === "" || Number.isNaN(Number(newScore))}
            onClick={() => {
              void mutate(
                () =>
                  databaseApi.redisWriteZset(
                    profile.id,
                    dbIndex,
                    selectedKey,
                    newMember.trim(),
                    Number(newScore),
                  ),
                t("已加入"),
              );
              setNewMember("");
              setNewScore("");
            }}
          >
            {t("添加成员")}
          </Button>
        </div>
      )}
    </div>
  );
}

function ZsetRow({
  entry,
  writable,
  onSave,
  onRemove,
}: {
  entry: RedisZEntry;
  writable: boolean;
  onSave: (entry: RedisZEntry, score: number) => void;
  onRemove: () => void;
}) {
  const { t } = useTranslation();
  const [score, setScore] = useState(String(entry.score));
  useEffect(() => setScore(String(entry.score)), [entry.score]);
  const changed = score !== String(entry.score) && !Number.isNaN(Number(score));
  return (
    <div className="flex items-center gap-2 border-b border-line/60 px-2 py-1 last:border-b-0">
      <span className="min-w-0 flex-1 truncate font-mono text-11 text-fg">{entry.member}</span>
      {writable ? (
        <input
          className="h-[22px] w-[90px] shrink-0 rounded border border-line bg-surface-1 px-1.5 text-right font-mono text-11 text-fg outline-none focus:border-accent"
          value={score}
          onChange={(event) => setScore(event.target.value)}
        />
      ) : (
        <span className="shrink-0 font-mono text-11 text-fg-muted">{score}</span>
      )}
      {writable && changed && (
        <Button variant="primary" size="xs" className="h-5" onClick={() => onSave(entry, Number(score))}>
          {t("保存")}
        </Button>
      )}
      {writable && (
        <Button
          variant="ghost"
          size="xs"
          className="h-5 w-5 px-0 text-danger"
          aria-label={t("移除成员")}
          onClick={onRemove}
        >
          <Trash2 size={11} />
        </Button>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// stream（只读表格：XRANGE 完整读取）
// ---------------------------------------------------------------------------

function StreamTable({ payload }: { payload: Extract<RedisValuePayload, { kind: "stream" }> }) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col gap-1.5">
      <div className="text-11 text-fg-subtle">
        {t("{{count}} 条（共 {{total}} 条）", {
          count: payload.entries.length,
          total: payload.length,
        })}
      </div>
      <div className="overflow-hidden rounded-[8px] border border-line">
        {payload.entries.map((entry) => (
          <div key={entry.id} className="border-b border-line/60 px-2 py-1.5 last:border-b-0">
            <div className="mb-0.5 font-mono text-10 text-accent">{entry.id}</div>
            <div className="flex flex-col gap-0.5">
              {entry.fields.map((field) => (
                <div key={field.field} className="flex gap-2">
                  <span className="w-[120px] shrink-0 truncate font-mono text-10 text-fg-muted">
                    {field.field}
                  </span>
                  <span className="min-w-0 flex-1 break-all font-mono text-11 text-fg">
                    {field.value}
                  </span>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// pub/sub 面板
// ---------------------------------------------------------------------------

/**
 * 消息负载解码：Rust 侧统一推 Base64（二进制无损）。
 * Base64 解码后再尝试严格 UTF-8：文本消息正常显示，
 * 真二进制消息回退显示 Base64（数据本体可复制还原）。
 */
function decodePubsubMessage(event: RedisPubSubEvent): string {
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

function PubSubPanel({
  profile,
  dbIndex,
  onClose,
}: {
  profile: DatabaseProfile;
  dbIndex: number;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [channel, setChannel] = useState("");
  const [subId, setSubId] = useState<string | null>(null);
  const [messages, setMessages] = useState<RedisPubSubEvent[]>([]);
  const [publishChannel, setPublishChannel] = useState("");
  const [publishMessage, setPublishMessage] = useState("");
  const listRef = useRef<HTMLDivElement>(null);

  // Channel 回调经 ref 保持稳定，避免重订阅。
  const onMessageRef = useRef((event: RedisPubSubEvent) => {
    // 连接断开/服务端结束任务时后端会推 closed：前端同步复位，
    // 输入框解锁、可以重新订阅，而不是一直显示"已订阅"却收不到消息。
    if (event.event === "closed") setSubId(null);
    setMessages((current) => [...current.slice(-199), event]);
  });

  const subIdRef = useRef<string | null>(null);
  useEffect(() => {
    subIdRef.current = subId;
  }, [subId]);

  // 面板关掉/组件卸载时必须退订：否则后端 PubSubTask 会一直占着连接收消息。
  useEffect(
    () => () => {
      const id = subIdRef.current;
      if (id) void databaseApi.redisUnsubscribe(id).catch(() => undefined);
    },
    [],
  );

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [messages.length]);

  const subscribe = async () => {
    if (!channel.trim()) return;
    try {
      const id = await databaseApi.redisSubscribe(
        profile.id,
        dbIndex,
        channel.trim(),
        (event) => onMessageRef.current(event),
      );
      setSubId(id);
    } catch (failure) {
      setMessages((current) => [
        ...current,
        {
          event: "error",
          subId: "",
          message: toDbError(failure).message,
        },
      ]);
    }
  };

  const unsubscribe = async () => {
    if (!subId) return;
    await databaseApi.redisUnsubscribe(subId).catch(() => undefined);
    setSubId(null);
  };

  return (
    <div className="absolute inset-y-0 right-0 z-20 flex w-[360px] flex-col border-l border-line bg-surface-1 shadow-[-12px_0_32px_rgb(15_23_42/0.08)]">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-line px-3">
        <span className="flex-1 text-12 font-medium text-fg-muted">{t("发布 / 订阅")}</span>
        <Button
          variant="ghost"
          size="xs"
          className="h-5 w-5 px-0"
          aria-label={t("关闭")}
          onClick={() => {
            // 关闭面板顺手退订，不能把订阅任务漏在后端。
            void unsubscribe().finally(onClose);
          }}
        >
          <X size={12} />
        </Button>
      </div>

      <div className="shrink-0 border-b border-line px-3 py-2">
        <div className="flex items-center gap-2">
          <input
            className="h-[26px] min-w-0 flex-1 rounded-[6px] border border-line bg-surface-1 px-2 font-mono text-11 text-fg outline-none focus:border-accent"
            placeholder={t("频道名，例如 orders:events")}
            value={channel}
            disabled={!!subId}
            onChange={(event) => setChannel(event.target.value)}
          />
          {subId ? (
            <Button variant="secondary" size="xs" onClick={() => void unsubscribe()}>
              {t("取消订阅")}
            </Button>
          ) : (
            <Button variant="secondary" size="xs" disabled={!channel.trim()} onClick={() => void subscribe()}>
              {t("订阅")}
            </Button>
          )}
        </div>
        {subId && (
          <p className="mt-1 text-10 text-success">
            {t("已订阅 {{channel}}，消息实时到达", { channel })}
          </p>
        )}
      </div>

      <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto px-3 py-2">
        {messages.length === 0 && (
          <p className="text-11 leading-relaxed text-fg-subtle">
            {t("订阅后，到达该频道的消息会实时出现在这里。")}
          </p>
        )}
        {messages.map((event, index) => (
          <div key={index} className="mb-1.5 rounded-[6px] border border-line/70 px-2 py-1">
            <div className="flex items-center gap-2">
              <span
                className={cn(
                  "text-10 font-medium",
                  event.event === "message" && "text-accent",
                  event.event === "error" && "text-danger",
                  event.event !== "message" && event.event !== "error" && "text-fg-subtle",
                )}
              >
                {event.event}
              </span>
              {event.channel && (
                <span className="min-w-0 truncate font-mono text-10 text-fg-subtle">
                  {event.channel}
                </span>
              )}
            </div>
            {event.messageBase64 ? (
              <div className="mt-0.5 break-all font-mono text-11 text-fg">
                {decodePubsubMessage(event)}
              </div>
            ) : (
              event.message && (
                <div className="mt-0.5 break-all font-mono text-11 text-fg">
                  {event.message}
                </div>
              )
            )}
          </div>
        ))}
      </div>

      <div className="shrink-0 border-t border-line px-3 py-2">
        <div className="mb-1 text-11 font-medium text-fg-muted">{t("发布消息")}</div>
        <div className="flex items-center gap-2">
          <input
            className="h-[26px] w-[130px] rounded-[6px] border border-line bg-surface-1 px-2 font-mono text-11 text-fg outline-none focus:border-accent"
            placeholder={t("频道")}
            value={publishChannel}
            onChange={(event) => setPublishChannel(event.target.value)}
          />
          <input
            className="h-[26px] min-w-0 flex-1 rounded-[6px] border border-line bg-surface-1 px-2 font-mono text-11 text-fg outline-none focus:border-accent"
            placeholder={t("消息内容")}
            value={publishMessage}
            onChange={(event) => setPublishMessage(event.target.value)}
          />
          <Button
            variant="secondary"
            size="xs"
            disabled={!publishChannel.trim()}
            onClick={async () => {
              try {
                const receivers = await databaseApi.redisPublish(
                  profile.id,
                  dbIndex,
                  publishChannel.trim(),
                  publishMessage,
                );
                setMessages((current) => [
                  ...current,
                  {
                    event: "message",
                    subId: "",
                    channel: publishChannel.trim(),
                    message: t("已发布给 {{count}} 个订阅者", { count: receivers }),
                  },
                ]);
              } catch (failure) {
                setMessages((current) => [
                  ...current,
                  { event: "error", subId: "", message: toDbError(failure).message },
                ]);
              }
            }}
          >
            {t("发布")}
          </Button>
        </div>
      </div>
    </div>
  );
}
