/**
 * 一个数据库标签 = 一个连接的工作区。
 *
 * 布局（与需求一致）：
 * - 顶部公共工具栏：新建连接 / 新建查询 / 任务入口 / 收展侧栏；
 * - 中央：当前工作项（表数据、SQL、结构），由右侧列表切换；
 * - 右侧：已打开工作项管理器（可收起、可调宽）；
 * - 底部状态栏：连接、库、工作项、事务、待修改。
 *
 * 左侧资产树在全局 `ContextSidebar`，不在本组件内。
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Database as DatabaseIcon, X } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { ErrorState } from "@/components/ui/error-state";
import { LoadingState } from "@/components/ui/loading";
import { Tooltip } from "@/components/ui/tooltip";
import { cn } from "@/lib/cn";
import {
  PageInspector,
  PageNotice,
  PageSurface,
  PageWorkspace,
} from "@/workbench/page-layout";
import { toDbError, useDatabaseStore } from "@/stores/database-store";
import { useDatabaseWorkbenchStore } from "@/stores/database-workbench-store";
import {
  orderedItems,
  useDatabaseWorkspaceStore,
  type WorkItem,
} from "@/stores/database-workspace-store";
import { useWorkbenchStore } from "@/stores/workbench-store";
import type { WorkspaceTab } from "@/workbench/types";
import { CloseWorkItemDialog, type CloseAction } from "./CloseWorkItemDialog";
import { CloseWorkItemsDialog, type CloseBatchAction } from "./CloseWorkItemsDialog";
import {
  assessCloseRisk,
  buildCloseBatch,
  hasCloseRisk,
  settleQueriesBeforeClose,
  type CloseBatch,
} from "./close-coordination";
import { ConnectionDialog } from "./ConnectionDialog";
import { ConnectionInfoPanel } from "./ConnectionInfoPanel";
import { DatabaseTabBar } from "./DatabaseTabBar";
import { DdlPanel } from "./DdlPanel";
import { EngineImplementationPanel } from "./EngineImplementationPanel";
import { listenDetachedSqlEvents } from "./detached-sql";
import { FieldCard } from "./FieldCard";
import { engineMeta, familyOf } from "./db-engines";
import { RedisBrowser } from "./RedisBrowser";
import { useEngineCatalog } from "./useEngineCatalog";
import { WorkItemHost } from "./WorkItemHost";

const FIELD_CARD_WIDTH = 260;

function StageBadge({ stage }: { stage: string }) {
  return (
    <span className="rounded bg-danger/15 px-1.5 py-0.5 text-11 font-medium text-danger">
      {stage}
    </span>
  );
}

/**
 * 标签入口：草稿标签只渲染连接表单 —— 一个还没保存的连接不该建会话。
 */
export function DatabaseView({ tab }: { tab: WorkspaceTab }) {
  if (tab.draftNewConnection) return <NewConnectionPane tabId={tab.id} />;
  return <ConnectionWorkspace tab={tab} />;
}

/**
 * 「新建连接」标签的内容。
 *
 * 保存成功后关掉这张草稿标签并跳到刚保存的连接：用户下一步一定是连上去看库，
 * 而不是回到一张已填完的空表单。列表按 `updated_at` 排序，新连接自然在最前。
 */
function NewConnectionPane({ tabId }: { tabId: string }) {
  const closeTabById = useWorkbenchStore((state) => state.closeTabById);
  const openDatabaseTab = useWorkbenchStore((state) => state.openDatabaseTab);
  return (
    <ConnectionDialog
      variant="inline"
      open
      profile={null}
      onClose={() => closeTabById(tabId)}
      onSaved={(saved) => {
        closeTabById(tabId);
        openDatabaseTab({
          id: saved.id,
          name: saved.name,
          host: saved.host,
          port: saved.port,
        });
      }}
    />
  );
}

function ConnectionWorkspace({ tab }: { tab: WorkspaceTab }) {
  const { t } = useTranslation();
  const profileId = tab.profileId ?? null;

  const profiles = useDatabaseStore((state) => state.profiles);
  const sessions = useDatabaseStore((state) => state.sessions);
  const sessionErrors = useDatabaseStore((state) => state.sessionErrors);
  const ensureSession = useDatabaseStore((state) => state.ensureSession);
  const clearSessionError = useDatabaseStore((state) => state.clearSessionError);
  const refreshStatus = useDatabaseStore((state) => state.refreshStatus);
  const reconnect = useDatabaseStore((state) => state.reconnect);
  const runSessionCommand = useDatabaseStore((state) => state.runSessionCommand);
  const invalidate = useDatabaseStore((state) => state.invalidate);

  const items = useDatabaseWorkspaceStore((state) => state.items);
  const activeId = useDatabaseWorkspaceStore((state) => state.activeId);
  const closeRequest = useDatabaseWorkspaceStore((state) => state.closeRequest);
  const consumeCloseRequest = useDatabaseWorkspaceStore(
    (state) => state.consumeCloseRequest,
  );
  const newQuery = useDatabaseWorkspaceStore((state) => state.newQuery);
  const closeItem = useDatabaseWorkspaceStore((state) => state.close);
  const rightWidth = useDatabaseWorkspaceStore((state) => state.rightWidth);
  const rightPanel = useDatabaseWorkspaceStore((state) => state.rightPanel);
  const ddl = useDatabaseWorkspaceStore((state) => state.ddl);
  const hideDdl = useDatabaseWorkspaceStore((state) => state.hideDdl);
  const connectionInfo = useDatabaseWorkspaceStore(
    (state) => state.connectionInfo,
  );
  const hideConnectionInfo = useDatabaseWorkspaceStore(
    (state) => state.hideConnectionInfo,
  );
  const fieldCard = useDatabaseWorkspaceStore((state) => state.fieldCard);
  const hideFieldCard = useDatabaseWorkspaceStore((state) => state.hideFieldCard);
  const setRightWidth = useDatabaseWorkspaceStore((state) => state.setRightWidth);

  const closeTabById = useWorkbenchStore((state) => state.closeTabById);

  const [notice, setNotice] = useState<string | null>(null);
  const [draggingRight, setDraggingRight] = useState(false);
  const [closing, setClosing] = useState<WorkItem | null>(null);
  const [closingOthers, setClosingOthers] = useState<CloseBatch | null>(null);
  const [closingScope, setClosingScope] = useState<"others" | "right">("others");
  /** 足够宽时字段卡片浮在列表左侧，不再挤压中央数据区。 */
  const [wide, setWide] = useState(() => window.innerWidth >= 1500);
  // 引擎目录决定"这是不是 Redis / 是不是文档型"：加载完成前不要建立会话，
  // 否则会拿 Redis 配置去走 SQL 的 db_connect。
  const catalog = useEngineCatalog();

  useEffect(() => {
    const onResize = () => setWide(window.innerWidth >= 1500);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  const profile = useMemo(
    () => profiles.find((entry) => entry.id === profileId) ?? null,
    [profileId, profiles],
  );
  const session = profileId ? sessions[profileId] : undefined;
  const sessionError = profileId ? sessionErrors[profileId] : null;
  const status = useDatabaseStore((state) =>
    profileId ? state.statuses[profileId] : undefined,
  );
  const workspaceItems = useMemo(
    () => items.filter((item) => item.profileId === profileId),
    [items, profileId],
  );


  useEffect(() => {
    if (!profileId) return;
    // Redis 连接不走 SQL 会话：键浏览器自己负责建连（db_redis_connect）。
    if (!catalog.ready) return;
    if (familyOf(profiles.find((entry) => entry.id === profileId)?.engine ?? "") === "redis") {
      void refreshStatus(profileId);
      return;
    }
    if (!session) void ensureSession(profileId);
    void refreshStatus(profileId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profileId, catalog.ready]);

  useEffect(() => {
    if (!draggingRight) return;
    const onMove = (event: MouseEvent) => {
      setRightWidth(window.innerWidth - event.clientX);
    };
    const onUp = () => setDraggingRight(false);
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [draggingRight, setRightWidth]);

  /**
   * 预览标签一旦开始"干活"，就自动升级为常驻标签：
   * 有未提交修改、未保存 SQL 或正在执行，都不该被下一次单击顶掉。
   * 判定放在这里而不是表格内部，是因为它同时要覆盖查询与结构工作项。
   */
  useEffect(() => {
    const workbench = useDatabaseWorkspaceStore.getState();
    for (const item of workspaceItems) {
      if (item.preview && (item.pendingCount > 0 || item.dirty || item.running)) {
        workbench.promote(item.id);
      }
    }
  }, [workspaceItems]);

  // 重连后 generation 变化：旧 SQL 结果不属于新连接，必须清空；
  // 否则用户会把上一个连接的查询结果当成新会话的结果。
  const generation = session?.generation ?? 0;
  const previousGeneration = useRef(generation);
  useEffect(() => {
    if (previousGeneration.current === generation) return;
    previousGeneration.current = generation;
    const workbench = useDatabaseWorkbenchStore.getState();
    for (const item of workspaceItems) {
      if (item.kind === "query") workbench.clearResults(item.id);
    }
  }, [generation, workspaceItems]);

  const handleNewQuery = (database?: string | null) => {
    if (!profileId || !profile) return;
    if (!session) {
      setNotice(t("连接尚未建立，无法新建查询"));
      return;
    }
    // 上下文优先：从表/结构/对象列表打开时用它们所属的库，
    // 从连接空白处打开时回退到会话当前库 / 连接默认库。
    newQuery({
      profileId,
      connectionName: profile.name,
      database:
        database ??
        session.current_database ??
        profile.default_database ??
        null,
    });
  };

  // DDL 面板只属于当前连接；切到另一个连接的标签时恢复列表。
  useEffect(() => {
    if (ddl && ddl.profileId !== profileId) hideDdl();
  }, [ddl, hideDdl, profileId]);

  // 连接信息面板按 profileId 匹配显示；不要在别的连接标签里清掉它，
  // 否则从资产树点另一个连接时，旧标签的 effect 会先把新面板关掉。

  // 独立 SQL 窗口执行结束后在主窗口给一条可见通知；
  // 事件只是通知，查询结果仍属于独立窗口。
  useEffect(() => {
    let alive = true;
    let unlisten: (() => void) | undefined;
    void listenDetachedSqlEvents((event) => {
      if (!alive || event.action !== "finished") return;
      setNotice(
        event.state === "completed"
          ? t("独立窗口「{{title}}」执行完成：{{rows}} 行 · {{ms}} ms", {
              title: event.title,
              rows: event.rows,
              ms: event.elapsedMs,
            })
          : t("独立窗口「{{title}}」执行结束：{{state}}", {
              title: event.title,
              state: event.state,
            }),
      );
    }).then((stop) => {
      if (alive) unlisten = stop;
      else stop();
    });
    return () => {
      alive = false;
      unlisten?.();
    };
  }, [t]);

  // 字段卡片同样只属于当前连接、当前表的工作项。
  const activeWorkItem = workspaceItems.find((item) => item.id === activeId) ?? null;
  useEffect(() => {
    if (!fieldCard) return;
    if (
      !activeWorkItem ||
      activeWorkItem.profileId !== fieldCard.profileId ||
      activeWorkItem.objectName !== fieldCard.table
    ) {
      hideFieldCard();
    }
  }, [activeWorkItem, fieldCard, hideFieldCard]);

  const requestClose = (item: WorkItem) => {
    const latest = useDatabaseWorkspaceStore
      .getState()
      .items.find((entry) => entry.id === item.id);
    if (!latest) return;
    if (
      latest.kind === "table" &&
      ddl &&
      ddl.profileId === latest.profileId &&
      ddl.database === latest.database &&
      ddl.table === latest.objectName
    ) {
      hideDdl();
    }
    if (
      fieldCard &&
      fieldCard.profileId === latest.profileId &&
      fieldCard.database === latest.database &&
      fieldCard.table === latest.objectName
    ) {
      hideFieldCard();
    }
    // 工作项可能属于另一个连接：事务状态必须取它自己的会话，不能拿当前标签的。
    const risk = assessCloseRisk(
      latest,
      sessions[latest.profileId] ?? session,
    );
    if (hasCloseRisk(risk)) {
      setClosing(latest);
      return;
    }
    useDatabaseWorkbenchStore.getState().dispose(latest.id, { clearDraft: true });
    closeItem(latest.id);
  };

  // 快捷键 / 命令面板投递的关闭请求：交给本连接的事务安全协调器处理。
  // 只认属于当前连接的请求，多个数据库标签不会互相误关。
  useEffect(() => {
    if (!closeRequest || closeRequest.profileId !== profileId) return;
    const item = items.find((entry) => entry.id === closeRequest.id);
    const mode = closeRequest.mode;
    consumeCloseRequest(closeRequest.id);
    if (!item) return;
    // 两种模式都走同一套风险检查，只是目标集合不同。
    if (mode === "right") requestCloseRight(item);
    else requestClose(item);
    // requestClose 每次渲染都是新闭包，进依赖会让 effect 反复触发；
    // 它只读取最新的 items/sessions，这里的闭包值已经足够。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [closeRequest, consumeCloseRequest, items, profileId]);

  /** 批量关闭也必须走协调器，不能直接过滤 items。 */
  const requestCloseOthers = (item: WorkItem) => {
    // “关闭其他”只作用于**本连接**的标签：标签条就是一个连接一条，
    // 关掉别的连接里的标签会让那边的上下文凭空消失。
    const others = items.filter(
      (entry) =>
        entry.profileId === item.profileId &&
        entry.id !== item.id &&
        !entry.pinned,
    );
    if (others.length === 0) return;
    const batch = buildCloseBatch(others, sessions);
    if (!batch.risks.some(hasCloseRisk)) {
      for (const entry of others) {
        useDatabaseWorkbenchStore.getState().dispose(entry.id, { clearDraft: true });
        closeItem(entry.id);
      }
      return;
    }
    setClosingScope("others");
    setClosingOthers(batch);
  };

  /** 关闭右侧：按标签条顺序（固定项置顶）关掉该项之后、同一连接的项目。 */
  const requestCloseRight = (item: WorkItem) => {
    const ordered = orderedItems(
      items.filter((entry) => entry.profileId === item.profileId),
    );
    const index = ordered.findIndex((entry) => entry.id === item.id);
    if (index < 0) return;
    const targets = ordered.slice(index + 1).filter((entry) => !entry.pinned);
    if (targets.length === 0) return;
    const batch = buildCloseBatch(targets, sessions);
    if (!batch.risks.some(hasCloseRisk)) {
      for (const entry of targets) {
        useDatabaseWorkbenchStore.getState().dispose(entry.id, { clearDraft: true });
        closeItem(entry.id);
      }
      return;
    }
    setClosingScope("right");
    setClosingOthers(batch);
  };

  const confirmCloseOthers = async (action: CloseBatchAction) => {
    const batch = closingOthers;
    if (!batch) return;
    const workbench = useDatabaseWorkbenchStore.getState();
    try {
      // 顺序必须是：取消查询 → 等后端终态 → 回滚事务 → 关闭工作项。
      await settleQueriesBeforeClose(
        batch.items.map((item) => item.id),
        {
          cancel: async (id) => {
            await useDatabaseWorkbenchStore.getState().cancel(id);
          },
          readState: (id) =>
            useDatabaseWorkbenchStore.getState().tabs[id]?.runState,
        },
      );

      if (action === "rollback") {
        const profiles = [
          ...new Set(
            batch.risks
              .filter((risk) => risk.inTransaction)
              .map((risk) => risk.item.profileId),
          ),
        ];
        for (const profileId of profiles) {
          await runSessionCommand(profileId, "ROLLBACK");
        }
      }

      for (const risk of batch.risks) {
        workbench.dispose(risk.item.id, { clearDraft: true });
        closeItem(risk.item.id);
      }
      setClosingOthers(null);
    } catch (failure) {
      // 查询超时/结果未知/回滚失败时保持对话框与工作项，不做部分关闭。
      setNotice(toDbError(failure).message);
    }
  };

  const confirmClose = async (action: CloseAction) => {
    const item = closing;
    if (!item) return;
    try {
      // 先停查询并确认终态；超时/未知时禁止继续 COMMIT/ROLLBACK 或关闭。
      await settleQueriesBeforeClose([item.id], {
        cancel: async (id) => {
          await useDatabaseWorkbenchStore.getState().cancel(id);
        },
        readState: (id) =>
          useDatabaseWorkbenchStore.getState().tabs[id]?.runState,
      });
      if (action === "commit" || action === "rollback") {
        await runSessionCommand(
          item.profileId,
          action === "commit" ? "COMMIT" : "ROLLBACK",
        );
      }
      useDatabaseWorkbenchStore.getState().dispose(item.id, { clearDraft: true });
      closeItem(item.id);
      setClosing(null);
    } catch (failure) {
      setNotice(toDbError(failure).message);
    }
  };

  if (!profileId) {
    return (
      <PageSurface>
        <PageWorkspace className="items-center justify-center">
          <EmptyState
            icon={<DatabaseIcon size={18} strokeWidth={1.5} />}
            title={t("从左侧选择一个数据库连接")}
            description={t("双击左侧表打开数据页；每个连接的工作项和查询都独立保存。")}
          />
        </PageWorkspace>
      </PageSurface>
    );
  }

  if (!profile) {
    return (
      <PageSurface>
        <PageWorkspace className="items-center justify-center">
          <EmptyState
            title={t("连接配置已删除或不存在")}
            action={
              <Button variant="ghost" size="sm" onClick={() => closeTabById(tab.id)}>
                {t("关闭标签")}
              </Button>
            }
          />
        </PageWorkspace>
      </PageSurface>
    );
  }

  // Redis 引擎：整块替换为键浏览器（SCAN / 类型化读写 / TTL / 发布订阅），
  // 不进入 SQL 工作台的工作项体系。
  if (!catalog.ready) {
    return (
      <PageSurface>
        {catalog.error ? (
          <div className="page-content page-content--reading">
            <ErrorState
              error={catalog.error}
              title={t("无法读取数据库引擎目录")}
              compact
              onRetry={catalog.reload}
            />
          </div>
        ) : (
          <LoadingState className="h-full" label={t("正在读取数据库引擎目录…")} />
        )}
      </PageSurface>
    );
  }

  const meta = engineMeta(profile.engine);
  // 未适配：不进 SQL 工作区让用户撞一条 "unsupported" 报错，而是把
  // "配置已保存 / 驱动未实现 / 每项能力的状态"如实摊开。
  if (!meta.known || !meta.supported) {
    return <EngineImplementationPanel profile={profile} descriptor={meta.descriptor} />;
  }

  const family = familyOf(profile.engine);
  if (family === "redis") {
    return <RedisBrowser profile={profile} />;
  }

  const showFieldCard = !!fieldCard && fieldCard.profileId === profileId;

  /**
   * 底部状态栏内容（**唯一**一条）。表页由 TableBrowser 合并进它自己的底栏
   * （范围/分页同一行），其他工作项由 WorkItemHost 渲染在最底部。
   *
   * 只放"跨工作项都成立"的信息：连接、库、事务、只读、连接标识。
   * 加载范围、耗时、草稿数属于具体工作项，由各自的底栏负责 —— 同一个数字
   * 不要在两条状态栏里各显示一遍。
   */
  const footerContent = (
    <div className="flex min-w-0 flex-wrap items-center justify-end gap-x-2 gap-y-1">
      <span
        className={cn(
          "h-1.5 w-1.5 shrink-0 rounded-full",
          session && session.state !== "lost" ? "bg-success" : sessionError ? "bg-danger" : "bg-warning",
        )}
      />
      <span className="max-w-[120px] truncate">{profile.name}</span>
      {session?.current_database && (
        <span className="max-w-[140px] truncate text-fg-muted">
          · {session.current_database}
        </span>
      )}
      {session?.transaction === "in_transaction" && (
        <span className="shrink-0 text-warning">{t("事务未提交")}</span>
      )}
      {session?.transaction === "in_transaction_read_only" && (
        <span className="shrink-0 text-warning">{t("只读事务")}</span>
      )}
      {(rightPanel === "ddl" || rightPanel === "connection") && (
        <Button
          variant="ghost"
          size="xs"
          className="h-auto px-1.5 py-0.5 text-11"
          onClick={() => {
            if (rightPanel === "ddl") hideDdl();
            else hideConnectionInfo();
          }}
        >
          {t("关闭详情")}
        </Button>
      )}
      <Tooltip side="top" label={t("刷新元数据缓存")}>
        <Button
          variant="ghost"
          size="xs"
          onClick={() => void invalidate(profileId)}
        >
          {t("刷新")}
        </Button>
      </Tooltip>
      <Tooltip side="top" label={t("重新连接（不恢复事务/临时表）")}>
        <Button
          variant="ghost"
          size="xs"
          onClick={() => void reconnect(profileId)}
        >
          {t("重连")}
        </Button>
      </Tooltip>
      <span className="ml-1 shrink-0 whitespace-nowrap">
        {session && session.state !== "lost" ? session.connection.label : t("未连接")}
        {status?.tunnel_local_port ? ` · 127.0.0.1:${status.tunnel_local_port}` : ""}
      </span>
    </div>
  );

  /**
   * 右侧只在**真的有东西要看**时出现：连接信息、DDL 预览、字段卡片。
   * 默认不再挂"已打开列表"—— 标签条已经是唯一的切换入口，两个列表并存
   * 会让人分不清哪个才是"当前工作项"。
   */
  const dockKind: "ddl" | "connection" | "field" | null = showFieldCard
    ? "field"
    : rightPanel === "ddl" && ddl && ddl.profileId === profileId
      ? "ddl"
      : rightPanel === "connection" && connectionInfo === profileId
        ? "connection"
        : null;

  return (
    <PageSurface>
      {notice && (
        <PageNotice
          tone="warning"
          action={
            <Button
              variant="ghost"
              size="xs"
              className="h-5 w-5 px-0"
              aria-label={t("关闭")}
              onClick={() => setNotice(null)}
            >
              <X size={11} />
            </Button>
          }
        >
          {notice}
        </PageNotice>
      )}

      {(!session || session.state === "lost") && sessionError && (
        <PageNotice
          tone="danger"
          action={
            <>
              <Button variant="ghost" size="xs" onClick={() => void reconnect(profileId)}>
                {t("重试")}
              </Button>
              <Button
                variant="ghost"
                size="xs"
                className="h-5 w-5 px-0"
                aria-label={t("关闭")}
                onClick={() => clearSessionError(profileId)}
              >
                <X size={11} />
              </Button>
            </>
          }
        >
          <span className="flex items-start gap-2">
            <StageBadge stage={sessionError.stage} />
            <span className="min-w-0 flex-1">
              <span className="block break-words leading-relaxed">{sessionError.message}</span>
              {sessionError.detail && (
                <span className="mt-0.5 block break-words text-10 text-fg-subtle">
                  {sessionError.detail}
                </span>
              )}
            </span>
          </span>
        </PageNotice>
      )}

      <DatabaseTabBar
        profileId={profileId}
        connectionName={profile.name}
        onRequestClose={requestClose}
        onRequestCloseOthers={requestCloseOthers}
        onRequestCloseRight={requestCloseRight}
        onNewQuery={() => handleNewQuery()}
      />

      <PageWorkspace row>
        <div className="relative min-w-0 flex-1">
          <WorkItemHost
            profileId={profileId}
            connectionName={profile.name}
            session={session ?? null}
            onRequestClose={requestClose}
            onNewQuery={handleNewQuery}
            footer={footerContent}
          />
        </div>

        {dockKind && (
          <PageInspector
            className="relative min-w-[160px]"
            style={{
              // 非全屏：字段卡片占宽度；全屏：卡片浮在检查器左侧，不挤压中央。
              width: rightWidth + (showFieldCard && !wide ? FIELD_CARD_WIDTH : 0),
            }}
          >
            {showFieldCard && fieldCard && wide && (
              <div
                className="absolute right-full top-0 z-20 h-full"
                style={{ width: FIELD_CARD_WIDTH }}
              >
                <FieldCard target={fieldCard} />
              </div>
            )}

            <div className="flex h-full min-h-0">
              {showFieldCard && fieldCard && !wide && (
                <div className="shrink-0" style={{ width: FIELD_CARD_WIDTH }}>
                  <FieldCard target={fieldCard} />
                </div>
              )}
              <div className="min-w-0 flex-1">
                {dockKind === "connection" ? (
                  <ConnectionInfoPanel profileId={profileId} />
                ) : dockKind === "ddl" && ddl ? (
                  <DdlPanel target={ddl} />
                ) : null}
              </div>
            </div>

            <div
              role="separator"
              aria-orientation="vertical"
              aria-label={t("调整右侧面板宽度")}
              tabIndex={0}
              className={cn(
                "page-resizer absolute left-0 top-0 z-30 h-full w-[5px] cursor-col-resize",
                draggingRight ? "bg-accent/25" : "hover:bg-accent/15",
              )}
              onMouseDown={(event) => {
                event.preventDefault();
                setDraggingRight(true);
              }}
              onDoubleClick={() => setRightWidth(220)}
              onKeyDown={(event) => {
                if (event.key === "ArrowLeft") {
                  event.preventDefault();
                  setRightWidth(rightWidth + 16);
                } else if (event.key === "ArrowRight") {
                  event.preventDefault();
                  setRightWidth(rightWidth - 16);
                }
              }}
            />
          </PageInspector>
        )}
      </PageWorkspace>

      <CloseWorkItemDialog
        item={closing}
        onCancel={() => setClosing(null)}
        onConfirm={(action) => void confirmClose(action)}
      />

      <CloseWorkItemsDialog
        batch={closingOthers}
        scope={closingScope}
        onCancel={() => setClosingOthers(null)}
        onConfirm={(action) => void confirmCloseOthers(action)}
      />
    </PageSurface>
  );
}
