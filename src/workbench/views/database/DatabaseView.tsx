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
import {
  Database as DatabaseIcon,
  TriangleAlert,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/cn";
import { toDbError, useDatabaseStore } from "@/stores/database-store";
import { useDatabaseWorkbenchStore } from "@/stores/database-workbench-store";
import {
  useDatabaseWorkspaceStore,
  type WorkItem,
} from "@/stores/database-workspace-store";
import { useWorkbenchStore } from "@/stores/workbench-store";
import type { WorkspaceTab } from "@/workbench/types";
import { CloseWorkItemDialog, type CloseAction } from "./CloseWorkItemDialog";
import { DdlPanel } from "./DdlPanel";
import { FieldCard } from "./FieldCard";
import { OpenItemsPanel } from "./OpenItemsPanel";
import { WorkItemHost } from "./WorkItemHost";

const FIELD_CARD_WIDTH = 260;

function StageBadge({ stage }: { stage: string }) {
  return (
    <span className="rounded bg-danger/15 px-1.5 py-0.5 text-11 font-medium text-danger">
      {stage}
    </span>
  );
}

export function DatabaseView({ tab }: { tab: WorkspaceTab }) {
  const { t } = useTranslation();
  const profileId = tab.profileId ?? null;

  const profiles = useDatabaseStore((state) => state.profiles);
  const sessions = useDatabaseStore((state) => state.sessions);
  const sessionErrors = useDatabaseStore((state) => state.sessionErrors);
  const ensureSession = useDatabaseStore((state) => state.ensureSession);
  const refreshStatus = useDatabaseStore((state) => state.refreshStatus);
  const reconnect = useDatabaseStore((state) => state.reconnect);
  const runSessionCommand = useDatabaseStore((state) => state.runSessionCommand);
  const invalidate = useDatabaseStore((state) => state.invalidate);

  const items = useDatabaseWorkspaceStore((state) => state.items);
  const activeId = useDatabaseWorkspaceStore((state) => state.activeId);
  const newQuery = useDatabaseWorkspaceStore((state) => state.newQuery);
  const closeItem = useDatabaseWorkspaceStore((state) => state.close);
  const rightCollapsed = useDatabaseWorkspaceStore((state) => state.rightCollapsed);
  const rightWidth = useDatabaseWorkspaceStore((state) => state.rightWidth);
  const rightPanel = useDatabaseWorkspaceStore((state) => state.rightPanel);
  const ddl = useDatabaseWorkspaceStore((state) => state.ddl);
  const hideDdl = useDatabaseWorkspaceStore((state) => state.hideDdl);
  const fieldCard = useDatabaseWorkspaceStore((state) => state.fieldCard);
  const hideFieldCard = useDatabaseWorkspaceStore((state) => state.hideFieldCard);
  const setRightCollapsed = useDatabaseWorkspaceStore((state) => state.setRightCollapsed);
  const setRightWidth = useDatabaseWorkspaceStore((state) => state.setRightWidth);

  const closeTabById = useWorkbenchStore((state) => state.closeTabById);

  const [notice, setNotice] = useState<string | null>(null);
  const [draggingRight, setDraggingRight] = useState(false);
  const [closing, setClosing] = useState<WorkItem | null>(null);
  /** 足够宽时字段卡片浮在列表左侧，不再挤压中央数据区。 */
  const [wide, setWide] = useState(() => window.innerWidth >= 1500);

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
    if (!session) void ensureSession(profileId);
    void refreshStatus(profileId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profileId]);

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

  const handleNewQuery = () => {
    if (!profileId || !profile) return;
    if (!session) {
      setNotice(t("连接尚未建立，无法新建查询"));
      return;
    }
    newQuery({
      profileId,
      connectionName: profile.name,
      database: session.current_database ?? profile.default_database,
    });
  };

  // DDL 面板只属于当前连接；切到另一个连接的标签时恢复列表。
  useEffect(() => {
    if (ddl && ddl.profileId !== profileId) hideDdl();
  }, [ddl, hideDdl, profileId]);

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
    const transaction = session?.transaction;
    const inTransaction =
      transaction === "in_transaction" || transaction === "in_transaction_read_only";
    if (latest.running || latest.pendingCount > 0 || inTransaction) {
      setClosing(latest);
      return;
    }
    useDatabaseWorkbenchStore.getState().dispose(latest.id);
    closeItem(latest.id);
  };

  const confirmClose = async (action: CloseAction) => {
    const item = closing;
    if (!item) return;
    try {
      // 先停掉运行中的查询，否则 COMMIT/ROLLBACK 会撞上"会话正忙"。
      if (item.running) {
        await useDatabaseWorkbenchStore.getState().cancel(item.id);
        // 最多等 5 秒让查询走到终态；仍不结束就让 COMMIT 自己报错。
        for (let attempt = 0; attempt < 50; attempt += 1) {
          const state = useDatabaseWorkbenchStore.getState().tabs[item.id]?.runState;
          if (state !== "running" && state !== "cancelling") break;
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
      }
      if (action === "commit" || action === "rollback") {
        await runSessionCommand(
          item.profileId,
          action === "commit" ? "COMMIT" : "ROLLBACK",
        );
      }
      useDatabaseWorkbenchStore.getState().dispose(item.id);
      closeItem(item.id);
      setClosing(null);
    } catch (failure) {
      setNotice(toDbError(failure).message);
    }
  };

  if (!profileId) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 bg-surface-1 px-6">
        <DatabaseIcon size={26} className="text-fg-subtle" />
        <p className="text-13 text-fg">{t("从左侧选择一个数据库连接")}</p>
        <p className="max-w-sm text-center text-11 leading-relaxed text-fg-subtle">
          {t("双击左侧表打开数据页；每个连接的工作项和查询都独立保存。")}
        </p>
        <Button variant="ghost" size="sm" onClick={() => closeTabById(tab.id)}>
          {t("关闭标签")}
        </Button>
      </div>
    );
  }

  if (!profile) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 bg-surface-1 px-6">
        <TriangleAlert size={20} className="text-danger" />
        <p className="text-12 text-fg">{t("连接配置已删除或不存在")}</p>
        <Button variant="ghost" size="sm" onClick={() => closeTabById(tab.id)}>
          {t("关闭标签")}
        </Button>
      </div>
    );
  }

  const showFieldCard = !!fieldCard && fieldCard.profileId === profileId;

  /**
   * 底部状态内容。表页由 TableBrowser 合并进它的底栏（汇总/分页同一行），
   * 其他工作项由 WorkItemHost 渲染在最底部；不再有单独的第二行。
   */
  const footerContent = (
    <div className="flex min-w-0 items-center gap-2">
      <span
        className={cn(
          "h-1.5 w-1.5 shrink-0 rounded-full",
          session ? "bg-success" : sessionError ? "bg-danger" : "bg-warning",
        )}
      />
      <span className="max-w-[120px] truncate">{profile.name}</span>
      {session?.transaction === "in_transaction" && (
        <span className="shrink-0 text-warning">{t("事务未提交")}</span>
      )}
      {session?.transaction === "in_transaction_read_only" && (
        <span className="shrink-0 text-warning">{t("只读事务")}</span>
      )}
      <button
        type="button"
        className="shrink-0 rounded px-1.5 py-0.5 text-11 text-fg-muted hover:bg-surface-hover hover:text-fg"
        onClick={() => {
          if (rightCollapsed) {
            hideDdl();
            setRightCollapsed(false);
          } else if (rightPanel === "ddl") {
            hideDdl();
          } else {
            setRightCollapsed(true);
          }
        }}
        title={
          rightCollapsed
            ? t("展开已打开列表")
            : rightPanel === "ddl"
              ? t("关闭 DDL，恢复已打开列表")
              : t("收起已打开列表")
        }
      >
        {t("已打开 {{count}}", { count: workspaceItems.length })}
      </button>
      <Button
        variant="ghost"
        size="xs"
        onClick={() => void invalidate(profileId)}
        title={t("刷新元数据缓存")}
      >
        {t("刷新")}
      </Button>
      <Button
        variant="ghost"
        size="xs"
        disabled={!session}
        onClick={() => void reconnect(profileId)}
        title={t("重新连接（不恢复事务/临时表）")}
      >
        {t("重连")}
      </Button>
      <span className="ml-1 shrink-0">
        {session ? `#${session.connection_id}` : t("未连接")}
        {status?.tunnel_local_port ? ` · 127.0.0.1:${status.tunnel_local_port}` : ""}
      </span>
    </div>
  );

  return (
    <div className="flex h-full min-h-0 flex-col bg-surface-1">
      {notice && (
        <div className="flex shrink-0 items-center gap-2 border-b border-warning/30 bg-warning/10 px-3 py-1 text-11 text-warning">
          <span className="min-w-0 flex-1">{notice}</span>
          <button type="button" onClick={() => setNotice(null)} aria-label={t("关闭")}>
            ×
          </button>
        </div>
      )}

      {!session && sessionError && (
        <div className="flex shrink-0 items-center gap-2 border-b border-danger/30 bg-danger/10 px-3 py-1.5 text-11 text-danger">
          <StageBadge stage={sessionError.stage} />
          <span className="min-w-0 flex-1 truncate" title={sessionError.detail ?? sessionError.message}>
            {sessionError.message}
          </span>
          <Button variant="ghost" size="xs" onClick={() => void ensureSession(profileId)}>
            {t("重试")}
          </Button>
        </div>
      )}

      <div className="flex min-h-0 flex-1">
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

        {!rightCollapsed && (
          <div
            className="relative shrink-0 border-l border-line"
            style={{
              // 非全屏：字段卡片占宽度；全屏：卡片浮在列表左侧，不挤压中央。
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
                {rightPanel === "ddl" && ddl && ddl.profileId === profileId ? (
                  <DdlPanel target={ddl} />
                ) : (
                  <OpenItemsPanel onRequestClose={requestClose} />
                )}
              </div>
            </div>

            <div
              className="absolute left-0 top-0 z-30 h-full w-[4px] cursor-col-resize hover:bg-accent/20"
              onMouseDown={(event) => {
                event.preventDefault();
                setDraggingRight(true);
              }}
            />
          </div>
        )}
      </div>

      <CloseWorkItemDialog
        item={closing}
        onCancel={() => setClosing(null)}
        onConfirm={(action) => void confirmClose(action)}
      />
    </div>
  );
}
