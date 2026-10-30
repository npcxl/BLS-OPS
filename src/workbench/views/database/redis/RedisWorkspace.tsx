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
import { RedisToolbar, type KeyTypeFilter } from "./RedisToolbar";
import type { RedisGridView } from "./RedisKeyGrid";
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

const EDITOR_HEIGHT_KEY = "bls-ops.redis.editor-height";
const EDITOR_MIN = 180;
const EDITOR_MAX = 620;
const DEFAULT_EDITOR_HEIGHT = 300;

function readEditorHeight(): number {
  try {
    const raw = Number(localStorage.getItem(EDITOR_HEIGHT_KEY));
    if (Number.isFinite(raw) && raw >= EDITOR_MIN && raw <= EDITOR_MAX) return raw;
  } catch {
    // localStorage 不可用就用默认高度。
  }
  return DEFAULT_EDITOR_HEIGHT;
}



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
  // 编辑器在**下方**（参考图），高度可拖拽；视图/类型过滤只影响已加载的行。
  const [editorHeight, setEditorHeight] = useState(readEditorHeight);
  const [editorVisible, setEditorVisible] = useState(true);
  /** 键网格至少保留的高度：编辑器再高也不能把列表挤没。 */
  const GRID_MIN_HEIGHT = 180;
  const [containerHeight, setContainerHeight] = useState(0);
  const [view, setView] = useState<RedisGridView>("list");
  const [typeFilter, setTypeFilter] = useState<KeyTypeFilter>("all");
  const rootRef = useRef<HTMLDivElement | null>(null);
  const detailSeqRef = useRef(0);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const draggingRef = useRef(false);

  const writable = !profile.read_only;

  // 类型过滤只筛已加载的行：不触发全库扫描，也不改 SCAN 语义。
  const visibleKeys = useMemo(
    () =>
      typeFilter === "all"
        ? scan.keys
        : scan.keys.filter((entry) =>
            typeFilter === "other"
              ? !["string", "hash", "list", "set", "zset", "stream"].includes(entry.kind)
              : entry.kind === typeFilter,
          ),
    [scan.keys, typeFilter],
  );

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

  /** 键空间变化时清空选择/详情，避免旧库的键值留在新画面里。 */
  const resetKeyState = useCallback(() => {
    selection.clear();
    setDetailKey(null);
    setKeyInfo(null);
    setPayload(null);
    detailSeqRef.current += 1;
  }, [selection]);

  /** 搜索 / 刷新：先清旧状态再重扫（旧响应由序号守卫丢弃）。 */
  const refreshKeys = useCallback(() => {
    resetKeyState();
    scan.rescan();
  }, [resetKeyState, scan]);

  // 切换连接（profile 变化）同样要清掉上一个连接的键与详情。
  useEffect(() => {
    resetKeyState();
  }, [profile.id, resetKeyState]);

  /** 切库：清空列表与详情，旧响应靠各自的序号守卫丢弃。 */
  const changeDb = useCallback(
    (value: number) => {
      scan.setDbIndex(value);
      resetKeyState();
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
      const byKey = new Map(visibleKeys.map((entry) => [entry.key, entry]));
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
    [selection.selected, selection.activeKey, visibleKeys, t],
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
          onSelect: () => refreshKeys(),
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
    [copySelection, openKey, requestDelete, refreshKeys, selection.selected, t, writable],
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
      selection.selectAll(visibleKeys);
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
      refreshKeys();
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
    // 上下键由 RedisKeyGrid 处理：只有它知道展开后的行序与哪些行是分组。
  };

  // 编辑器高度拖拽：横向 4px 抓手，松手落 localStorage（沿用项目习惯）。
  useEffect(() => {
    const move = (event: MouseEvent) => {
      if (!draggingRef.current) return;
      const node = rootRef.current;
      if (!node) return;
      const next = node.getBoundingClientRect().bottom - event.clientY;
      setEditorHeight(Math.max(EDITOR_MIN, Math.min(EDITOR_MAX, next)));
    };
    const up = () => {
      if (!draggingRef.current) return;
      draggingRef.current = false;
      try {
        localStorage.setItem(EDITOR_HEIGHT_KEY, String(editorHeight));
      } catch {
        // 存不进去只影响下次默认高度。
      }
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
    return () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
  }, [editorHeight]);

  // 容器高度决定编辑器可用高度：窗口变矮时自动压缩编辑器，网格始终可用。
  useEffect(() => {
    const node = rootRef.current;
    if (!node) return;
    const observer = new ResizeObserver(() => setContainerHeight(node.clientHeight));
    observer.observe(node);
    setContainerHeight(node.clientHeight);
    return () => observer.disconnect();
  }, []);

  const dbOptions = useMemo(() => redisDbIndexes(profile), [profile]);
  const effectiveEditorHeight =
    containerHeight > 0
      ? Math.max(
          140,
          Math.min(editorHeight, Math.max(140, containerHeight - GRID_MIN_HEIGHT)),
        )
      : editorHeight;



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
        dbIndex={scan.dbIndex}
        dbOptions={dbOptions}
        onDbChange={changeDb}
        typeFilter={typeFilter}
        onTypeFilterChange={setTypeFilter}
        pattern={scan.pattern}
        scanning={scan.scanning}
        onPatternChange={scan.setPattern}
        onScan={refreshKeys}
        connected={connection.connected}
        connecting={connection.connecting}
        onReconnect={() => connection.reconnect()}
        writable={writable}
        onNewKey={() => setNewKeyOpen(true)}
        onTogglePubsub={() => setPubsubOpen((open) => !open)}
        pubsubOpen={pubsubOpen}
        editorVisible={editorVisible}
        onToggleEditor={() => setEditorVisible((visible) => !visible)}
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


      {/* 主体：键数据主区（上）+ 键值编辑器（下，参考图的底部停靠） */}
      <div className="flex min-h-0 flex-1 flex-col">
        {connection.connected ? (
          <RedisKeyGrid
            keys={visibleKeys}
            selected={selection.selected}
            activeKey={selection.activeKey}
            scanning={scan.scanning}
            hasMore={scan.hasMore}
            capped={scan.capped}
            view={view}
            onViewChange={setView}
            onRowClick={(key, index, mods) => {
              selection.click(key, index, mods, visibleKeys);
              // 单击 = 选中并加载详情（对齐参考图）；Ctrl/Shift 只做多选。
              if (!mods.ctrl && !mods.shift) void loadKey(key);
            }}
            onRowOpen={(key) => {
              openKey(key);
              // 双击 = 进入编辑：展开底部编辑器并把光标放进值输入框。
              setEditorVisible(true);
              window.setTimeout(() => {
                document
                  .querySelector<HTMLElement>(
                    "[data-redis-editor] textarea, [data-redis-editor] input",
                  )
                  ?.focus();
              }, 0);
            }}
            onNavigate={openKey}
            onRowContextMenu={(event, key) => {
              if (!selection.selected.has(key)) {
                // 用真实索引：Shift 连选依赖锚点下标，不能写死成 0。
                const index = Math.max(0, visibleKeys.findIndex((entry) => entry.key === key));
                selection.click(key, index, { ctrl: false, shift: false }, visibleKeys);
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

        {/* 键值编辑器：底部停靠，高度可拖拽；未选键时给空状态而不是消失 */}
        {connection.connected && editorVisible && detailKey && (
          <>
            <div
              role="separator"
              aria-orientation="horizontal"
              aria-label={t("调整编辑器高度")}
              className="h-1 shrink-0 cursor-row-resize bg-transparent hover:bg-accent/40"
              onMouseDown={() => {
                draggingRef.current = true;
              }}
            />
            <div
              data-redis-editor
              className="min-h-0 shrink-0 overflow-hidden border-t border-line"
              style={{ height: effectiveEditorHeight }}
            >
              {detailPane}
            </div>
          </>
        )}
      </div>

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
