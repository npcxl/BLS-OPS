/**
 * Redis 工作区：Navicat 式"网格 + 详情"布局。
 *
 * 职责边界：
 * - `useRedisConnection` → 连接状态 / 建连 / 重连（唯一来源是 statuses）
 * - `useRedisKeyScan`    → SCAN 分页、DBSIZE、竞态守卫
 * - `useRedisKeySelection` → 多选与锚点
 * - `RedisKeyGrid`       → 虚拟滚动网格（只上报事件）
 * - `RedisKeyDetail`     → 按类型的值编辑器
 * - 本组件只做编排：工具栏、分栏、快捷键、右键菜单、危险确认、状态栏
 *
 * 多选与批量操作**不是**事务：Redis 没有跨键事务语义，这里逐条执行并如实
 * 汇报成功/失败条数，绝不把"N 条 DEL"包装成"原子批量"。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {

  Loader2,
  RefreshCw,

  TriangleAlert,

} from "@/components/icons";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { ContextMenu, useContextMenu } from "@/components/ui/context-menu";
import { pushToast } from "@/components/ui/toast";
import { copyText } from "@/lib/clipboard";
import { databaseApi } from "@/api/ops-api";
import type {
  DatabaseProfile,
  RedisKeyInfo,
  RedisValuePayload,
} from "@/api/types/database";
import { NewKeyDialog } from "./RedisNewKeyDialog";
import { ValuePanel } from "./RedisKeyDetail";
import { RedisKeyGrid } from "./RedisKeyGrid";
import { PubSubPanel } from "./RedisPubSubPanel";
import { RedisStatusBar } from "./RedisStatusBar";
import { RedisToolbar } from "./RedisToolbar";
import {
  alertRedisFailure,
  formatTtl,
  redisDbIndexes,
  redisDefaultDb,
  type RedisMutate,
} from "./redis-shared";
import { useRedisConnection } from "./useRedisConnection";
import { useRedisKeyScan } from "./useRedisKeyScan";
import { useRedisKeySelection } from "./useRedisKeySelection";

const DETAIL_WIDTH_KEY = "bls-ops.redis.detail-width";
const DETAIL_MIN = 300;
const DETAIL_MAX = 900;
const DEFAULT_DETAIL_WIDTH = 420;

function readDetailWidth(): number {
  try {
    const raw = Number(localStorage.getItem(DETAIL_WIDTH_KEY));
    if (Number.isFinite(raw) && raw >= DETAIL_MIN && raw <= DETAIL_MAX) return raw;
  } catch {
    // localStorage 不可用就用默认宽度。
  }
  return DEFAULT_DETAIL_WIDTH;
}

/** 窄窗口阈值：低于它就自动收起详情栏，保证键列表不被挤没。 */
const NARROW_WIDTH = 880;
/** 键列表至少保留的宽度（详情栏最多占剩余空间）。 */
const GRID_MIN_WIDTH = 320;

export function RedisWorkspace({ profile }: { profile: DatabaseProfile }) {
  const { t } = useTranslation();
  const connection = useRedisConnection(profile.id);
  const scan = useRedisKeyScan(profile, connection.connected, redisDefaultDb(profile));
  const selection = useRedisKeySelection();
  const menu = useContextMenu();

  const [detailKey, setDetailKey] = useState<string | null>(null);
  const [keyInfo, setKeyInfo] = useState<RedisKeyInfo | null>(null);
  const [payload, setPayload] = useState<RedisValuePayload | null>(null);
  const [loadingValue, setLoadingValue] = useState(false);
  const [newKeyOpen, setNewKeyOpen] = useState(false);
  const [pubsubOpen, setPubsubOpen] = useState(false);
  const [deleteTargets, setDeleteTargets] = useState<string[] | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [detailWidth, setDetailWidth] = useState(readDetailWidth);
  const [detailVisible, setDetailVisible] = useState(true);
  const [containerWidth, setContainerWidth] = useState(0);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const detailSeqRef = useRef(0);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const draggingRef = useRef(false);

  const writable = !profile.read_only;

  /** 读取一个键的元信息 + 值。晚到的旧响应直接丢弃（快速连点两个键）。 */
  const loadKey = useCallback(
    async (key: string, full = false) => {
      const seq = ++detailSeqRef.current;
      setDetailKey(key);
      setLoadingValue(true);
      try {
        const [info, value] = await Promise.all([
          databaseApi.redisKeyInfo(profile.id, scan.dbIndex, key),
          databaseApi.redisReadValue(profile.id, scan.dbIndex, key, full),
        ]);
        if (seq !== detailSeqRef.current) return;
        setKeyInfo(info);
        setPayload(value);
      } catch (failure) {
        if (seq !== detailSeqRef.current) return;
        alertRedisFailure(failure, t("读取键失败"));
        setKeyInfo(null);
        setPayload(null);
      } finally {
        if (seq === detailSeqRef.current) setLoadingValue(false);
      }
    },
    [profile.id, scan.dbIndex, t],
  );

  /**
   * 写操作统一入口：成功后回读当前键并刷新列表；失败默认弹顶部提示。
   * `onError` 由调用方就地显示（表单内），避免同一个错误出现两次。
   */
  const mutate = useCallback<RedisMutate>(
    async (action, successNotice, onError) => {
      try {
        await action();
        if (successNotice) pushToast(successNotice, "success");
        if (detailKey) await loadKey(detailKey);
        scan.rescan();
        return true;
      } catch (failure) {
        if (onError) onError(failure);
        else alertRedisFailure(failure, t("操作失败"));
        return false;
      }
    },
    [detailKey, loadKey, scan, t],
  );

  const openKey = useCallback(
    (key: string) => {
      selection.setActive(key);
      void loadKey(key);
    },
    [loadKey, selection],
  );

  /** 切库：清空列表与详情，旧响应靠各自的序号守卫丢弃。 */
  const changeDb = useCallback(
    (value: number) => {
      scan.setDbIndex(value);
      selection.clear();
      setDetailKey(null);
      setKeyInfo(null);
      setPayload(null);
      detailSeqRef.current += 1;
    },
    [scan, selection],
  );

  // 连上之后才扫；断开时把详情收起（键已经不可读了）。
  useEffect(() => {
    if (connection.connected) {
      scan.rescan();
      return;
    }
    selection.clear();
    setDetailKey(null);
    setKeyInfo(null);
    setPayload(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connection.connected, scan.dbIndex]);

  /** 复制：默认只复制键名；`withHeader` 时复制 TSV（含类型与 TTL）。 */
  const copySelection = useCallback(
    async (withHeader: boolean) => {
      const targets =
        selection.selected.size > 0
          ? [...selection.selected]
          : selection.activeKey
            ? [selection.activeKey]
            : [];
      if (targets.length === 0) return;
      const byKey = new Map(scan.keys.map((entry) => [entry.key, entry]));
      const rows = targets.map((key) => {
        const entry = byKey.get(key);
        return entry
          ? `${entry.key}\t${entry.kind}\t${formatTtl(entry.ttl_ms)}`
          : key;
      });
      // Ctrl+C 只复制键名（粘到 CLI 里直接能用）；Ctrl+Shift+C 才是带表头的 TSV。
      const text = withHeader
        ? `Key\tType\tTTL\n${rows.join("\n")}`
        : targets.join("\n");
      const ok = await copyText(text);
      pushToast(
        ok ? t("已复制 {{count}} 个键", { count: targets.length }) : t("复制失败"),
        ok ? "success" : "error",
      );
    },
    [selection.selected, selection.activeKey, scan.keys, t],
  );

  const requestDelete = useCallback((keys: string[]) => {
    if (keys.length === 0) return;
    setDeleteError(null);
    setDeleteTargets(keys);
  }, []);

  /** 逐条删除并如实汇报，不假装原子。 */
  const confirmDelete = useCallback(async () => {
    const keys = deleteTargets ?? [];
    if (keys.length === 0) return;
    setDeleting(true);
    setDeleteError(null);
    let failed = 0;
    for (const key of keys) {
      try {
        await databaseApi.redisKeyDelete(profile.id, scan.dbIndex, key);
      } catch {
        failed += 1;
      }
    }
    setDeleting(false);
    if (failed > 0) {
      setDeleteError(
        t("{{failed}}/{{total}} 个键删除失败，请检查权限或键是否已被修改", {
          failed,
          total: keys.length,
        }),
      );
      return;
    }
    setDeleteTargets(null);
    selection.remove(keys);
    if (detailKey && keys.includes(detailKey)) {
      setDetailKey(null);
      setKeyInfo(null);
      setPayload(null);
    }
    pushToast(t("已删除 {{count}} 个键", { count: keys.length }), "success");
    scan.rescan();
  }, [deleteTargets, detailKey, profile.id, scan, selection, t]);

  const keyMenu = useCallback(
    (key: string) => {
      const multi = selection.selected.size > 1 && selection.selected.has(key);
      return [
        {
          id: "open",
          label: t("打开"),
          hint: "Enter",
          onSelect: () => openKey(key),
        },
        {
          id: "copy-key",
          label: multi ? t("复制 {{count}} 个键名", { count: selection.selected.size }) : t("复制键名"),
          hint: "Ctrl+C",
          onSelect: () => void copySelection(false),
        },
        {
          id: "copy-tsv",
          label: t("复制为 TSV（含类型与 TTL）"),
          hint: "Ctrl+Shift+C",
          onSelect: () => void copySelection(true),
        },
        { separator: true as const },
        {
          id: "refresh",
          label: t("刷新列表"),
          hint: "F5",
          onSelect: () => scan.rescan(),
        },
        ...(writable
          ? [
              { separator: true as const },
              {
                id: "delete",
                label: multi
                  ? t("删除选中的 {{count}} 个键", { count: selection.selected.size })
                  : t("删除键"),
                danger: true,
                onSelect: () =>
                  requestDelete(
                    selection.selected.size > 1 && selection.selected.has(key)
                      ? [...selection.selected]
                      : [key],
                  ),
              },
            ]
          : []),
      ];
    },
    [copySelection, openKey, requestDelete, scan, selection.selected, t, writable],
  );

  /** 键盘：全部作用在已加载的结果上，绝不触发全库扫描。 */
  const onKeyDown = (event: React.KeyboardEvent) => {
    const meta = event.ctrlKey || event.metaKey;
    const key = event.key.toLowerCase();
    if (meta && key === "f") {
      event.preventDefault();
      searchRef.current?.focus();
      searchRef.current?.select();
      return;
    }
    if (meta && key === "a") {
      event.preventDefault();
      selection.selectAll(scan.keys);
      return;
    }
    if (meta && key === "c") {
      event.preventDefault();
      void copySelection(event.shiftKey);
      return;
    }
    if (meta && key === "s") {
      // 保存由详情面板里的编辑器负责（输入框内 Ctrl+S 不劫持）。
      return;
    }
    if (event.key === "F5") {
      event.preventDefault();
      scan.rescan();
      return;
    }
    if (event.key === "F2" || event.key === "Enter") {
      if (selection.activeKey) {
        event.preventDefault();
        openKey(selection.activeKey);
      }
      return;
    }
    if (event.key === "Delete" && writable) {
      const targets =
        selection.selected.size > 0
          ? [...selection.selected]
          : selection.activeKey
            ? [selection.activeKey]
            : [];
      if (targets.length > 0) {
        event.preventDefault();
        requestDelete(targets);
      }
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      if (scan.keys.length === 0) return;
      event.preventDefault();
      const current = selection.activeKey
        ? scan.keys.findIndex((entry) => entry.key === selection.activeKey)
        : -1;
      const next = Math.max(
        0,
        Math.min(scan.keys.length - 1, current + (event.key === "ArrowDown" ? 1 : -1)),
      );
      const target = scan.keys[next];
      if (target) {
        selection.click(target.key, next, { ctrl: false, shift: false }, scan.keys);
        openKey(target.key);
      }
    }
  };

  // 详情栏宽度拖拽：4px 抓手，松手落 localStorage。
  useEffect(() => {
    const move = (event: MouseEvent) => {
      if (!draggingRef.current) return;
      const base = window.innerWidth - event.clientX;
      setDetailWidth(Math.max(DETAIL_MIN, Math.min(DETAIL_MAX, base)));
    };
    const up = () => {
      if (!draggingRef.current) return;
      draggingRef.current = false;
      try {
        localStorage.setItem(DETAIL_WIDTH_KEY, String(detailWidth));
      } catch {
        // 存不进去只影响下次默认宽度。
      }
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
    return () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
  }, [detailWidth]);

  // 容器宽度决定布局形态：窄窗口把详情改成浮层，键列表保持最小可用宽度。
  useEffect(() => {
    const node = rootRef.current;
    if (!node) return;
    const observer = new ResizeObserver(() => setContainerWidth(node.clientWidth));
    observer.observe(node);
    setContainerWidth(node.clientWidth);
    return () => observer.disconnect();
  }, []);

  const dbOptions = useMemo(() => redisDbIndexes(profile), [profile]);
  const narrow = containerWidth > 0 && containerWidth < NARROW_WIDTH;
  // 详情栏最多占"总宽 - 键列表最小宽"，窗口缩小时自动收窄而不是把网格挤没。
  const effectiveDetailWidth = Math.max(
    260,
    Math.min(detailWidth, Math.max(260, containerWidth - GRID_MIN_WIDTH)),
  );

  /** 详情内容只写一次：宽窗口是第三栏，窄窗口是右侧浮层。 */
  const detailPane = detailKey ? (
    loadingValue && !payload ? (
      <div className="flex h-full items-center justify-center">
        <Loader2 size={16} className="animate-spin text-fg-subtle" />
      </div>
    ) : (
      <ValuePanel
        profile={profile}
        dbIndex={scan.dbIndex}
        selectedKey={detailKey}
        keyInfo={keyInfo}
        payload={payload}
        mutate={mutate}
        onReadFull={() => void loadKey(detailKey, true)}
        onDeleted={() => {
          setDetailKey(null);
          setKeyInfo(null);
          setPayload(null);
          scan.rescan();
        }}
      />
    )
  ) : (
    <div className="flex h-full flex-col items-center justify-center gap-2 px-6">
      <p className="text-center text-12 leading-relaxed text-fg-subtle">
        {selection.selected.size > 1
          ? t("已选中 {{count}} 个键。双击其中一个查看详情。", {
              count: selection.selected.size,
            })
          : t("选中一个键查看详情；双击打开编辑。")}
      </p>
      <p className="text-center text-11 leading-relaxed text-fg-subtle">
        {t("支持 String / Hash / List / Set / ZSet / Stream；Ctrl+C 复制键名，Ctrl+Shift+C 复制 TSV。")}
      </p>
    </div>
  );

  return (
    <div
      ref={rootRef}
      className="relative flex h-full min-h-0 flex-col bg-surface-1 outline-none"
      tabIndex={-1}
      onKeyDown={onKeyDown}
    >
      <RedisToolbar
        profileName={profile.name}
        host={profile.host}
        port={profile.port}
        dbIndex={scan.dbIndex}
        dbOptions={dbOptions}
        serverVersion={connection.serverVersion}
        connected={connection.connected}
        connecting={connection.connecting}
        sessionError={connection.error}
        onReconnect={() => connection.reconnect()}
        onDbChange={changeDb}
        writable={writable}
        pattern={scan.pattern}
        scanning={scan.scanning}
        onPatternChange={scan.setPattern}
        onScan={() => scan.rescan()}
        onNewKey={() => setNewKeyOpen(true)}
        onTogglePubsub={() => setPubsubOpen((open) => !open)}
        pubsubOpen={pubsubOpen}
        detailVisible={detailVisible}
        onToggleDetail={() => setDetailVisible((visible) => !visible)}
        patternRef={searchRef}
      />

      {/* 连接错误：只留一条，位置固定在网格上方，不弹第二个 toast */}
      {connection.error && !connection.connected && (
        <div className="flex shrink-0 items-start gap-2 border-b border-danger/30 bg-danger/10 px-3 py-1.5 text-11 text-danger">
          <TriangleAlert size={12} className="mt-0.5 shrink-0" />
          <div className="min-w-0 flex-1">
            <p className="break-words leading-relaxed">{connection.error.message}</p>
            {connection.error.detail && (
              <p className="mt-0.5 break-words text-10 text-fg-subtle">
                {connection.error.detail}
              </p>
            )}
          </div>
          <Button
            variant="ghost"
            size="xs"
            className="shrink-0"
            onClick={() => connection.reconnect()}
          >
            {t("重试")}
          </Button>
        </div>
      )}


      {/* 主体：网格 + 可拖拽分栏 + 详情 */}
      <div className="flex min-h-0 flex-1">
        {connection.connected ? (
          <RedisKeyGrid
            keys={scan.keys}
            selected={selection.selected}
            activeKey={selection.activeKey}
            scanning={scan.scanning}
            hasMore={scan.hasMore}
            capped={scan.capped}
            onRowClick={(key, index, mods) =>
              selection.click(key, index, mods, scan.keys)
            }
            onRowOpen={openKey}
            onRowContextMenu={(event, key) => {
              if (!selection.selected.has(key)) {
                selection.click(key, 0, { ctrl: false, shift: false }, scan.keys);
              }
              menu.onContextMenu(() => keyMenu(key))(event);
            }}
            onLoadMore={() => scan.scan(false)}
          />
        ) : (
          <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 px-6">
            {connection.connecting ? (
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
                  className={connection.error ? "text-danger" : "text-fg-subtle"}
                />
                <p className="max-w-md text-center text-12 leading-relaxed text-fg-muted">
                  {connection.error?.message ?? t("连接已关闭，未连接到 Redis。")}
                </p>
                <Button variant="secondary" size="sm" onClick={() => connection.reconnect()}>
                  <RefreshCw size={12} />
                  {t("重新连接")}
                </Button>
              </>
            )}
          </div>
        )}

        {/* 宽窗口：详情作为第三栏，可拖拽调宽 */}
        {connection.connected && detailVisible && !narrow && (
          <>
            <div
              role="separator"
              aria-orientation="vertical"
              aria-label={t("调整详情宽度")}
              className="w-1 shrink-0 cursor-col-resize bg-transparent hover:bg-accent/40"
              onMouseDown={() => {
                draggingRef.current = true;
              }}
            />
            <div
              className="min-h-0 shrink-0 overflow-hidden border-l border-line"
              style={{ width: effectiveDetailWidth }}
            >
              {detailPane}
            </div>
          </>
        )}
      </div>

      {/* 窄窗口：详情改成右侧浮层，键列表保持可用宽度 */}
      {connection.connected && detailVisible && narrow && (
        <div className="absolute inset-y-0 right-0 z-20 w-[min(440px,88%)] border-l border-line bg-surface-1 shadow-2xl">
          {detailPane}
        </div>
      )}

      {pubsubOpen && connection.connected && (
        <PubSubPanel
          profile={profile}
          dbIndex={scan.dbIndex}
          onClose={() => setPubsubOpen(false)}
        />
      )}

      <RedisStatusBar
        connected={connection.connected}
        connecting={connection.connecting}
        host={profile.host}
        port={profile.port}
        tunnelPort={connection.tunnelPort}
        dbIndex={scan.dbIndex}
        loaded={scan.keys.length}
        dbsize={scan.dbsize}
        hasMore={scan.hasMore}
        capped={scan.capped}
        serverVersion={connection.serverVersion}
      />

      <NewKeyDialog
        open={newKeyOpen}
        profileId={profile.id}
        dbIndex={scan.dbIndex}
        onClose={() => setNewKeyOpen(false)}
        onCreated={(key) => {
          scan.rescan();
          openKey(key);
        }}
      />

      <ContextMenu {...menu.props} />

      <ConfirmDialog
        open={deleteTargets !== null}
        title={
          deleteTargets && deleteTargets.length > 1
            ? t("删除 {{count}} 个键", { count: deleteTargets.length })
            : t("删除键")
        }
        description={t(
          "删除不可撤销。这不是事务：多个键会逐条删除，中途失败的部分不会回滚。",
        )}
        consequences={deleteTargets?.slice(0, 5)}
        confirmLabel={t("删除")}
        danger
        pending={deleting}
        error={deleteError}
        onConfirm={() => void confirmDelete()}
        onCancel={() => {
          setDeleteTargets(null);
          setDeleteError(null);
        }}
      />
    </div>
  );
}
