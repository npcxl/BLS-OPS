/**
 * 右侧 DDL 预览面板：点表页的 DDL 时临时替换"已打开"列表并加宽，
 * 关闭后恢复列表和原宽度。这里只读，修改请到 SQL 编辑器执行。
 *
 * 视图本体在 `DdlCode`（与独立窗口共用）；本文件只管头部操作：
 * 折行、复制、在新窗口打开、关闭。
 */
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Copy, Loader2, Maximize2, X } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { pushToast } from "@/components/ui/toast";
import { copyText } from "@/lib/clipboard";
import { useDatabaseStore } from "@/stores/database-store";
import {
  useDatabaseWorkspaceStore,
  type DdlTarget,
} from "@/stores/database-workspace-store";
import { DdlCode } from "./DdlCode";
import { openDetachedDdlWindow } from "./detached-sql";

export function DdlPanel({ target }: { target: DdlTarget }) {
  const { t } = useTranslation();
  const detailKey = `${target.profileId}\u0001${target.database}\u0001${target.table}`;
  const detail = useDatabaseStore((state) => state.details[detailKey] ?? null);
  const loading = useDatabaseStore((state) => state.loading[detailKey] ?? false);
  const profileName = useDatabaseStore(
    (state) => state.profiles.find((entry) => entry.id === target.profileId)?.name ?? "",
  );
  const refreshTableDetail = useDatabaseStore((state) => state.refreshTableDetail);
  const hideDdl = useDatabaseWorkspaceStore((state) => state.hideDdl);
  const [copied, setCopied] = useState(false);
  // 侧栏窄：默认折行（配合挂起缩进好读），需要对照长行时可以关掉换横向滚动。
  const [wrap, setWrap] = useState(true);

  useEffect(() => {
    if (!detail) {
      void refreshTableDetail(target.profileId, target.database, target.table);
    }
  }, [detail, refreshTableDetail, target.database, target.profileId, target.table]);

  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1200);
    return () => window.clearTimeout(timer);
  }, [copied]);

  const createSql = detail?.create_sql ?? "";

  return (
    <aside className="flex h-full min-h-0 flex-col bg-surface-1">
      <div className="flex h-9 shrink-0 items-center gap-1 border-b border-line px-2">
        <span
          className="min-w-0 flex-1 truncate text-12 font-medium text-fg"
          title={`${target.database}.${target.table}`}
        >
          {target.table} · DDL
        </span>
        <Button
          variant={wrap ? "secondary" : "ghost"}
          size="xs"
          onClick={() => setWrap((value) => !value)}
          title={t("长行自动换行")}
        >
          {t("折行")}
        </Button>
        <Button
          variant="ghost"
          size="xs"
          className="h-6 w-6 px-0"
          disabled={!createSql}
          onClick={() =>
            void openDetachedDdlWindow({
              sql: createSql,
              title: `${target.table} · DDL`,
              connectionName: profileName,
              database: target.database,
            }).catch((failure: unknown) =>
              pushToast(
                failure instanceof Error ? failure.message : String(failure),
                "error",
              ),
            )
          }
          title={t("在新窗口打开")}
          aria-label={t("在新窗口打开")}
        >
          <Maximize2 size={11} />
        </Button>
        <Button
          variant="ghost"
          size="xs"
          className="h-6 w-6 px-0"
          disabled={!createSql}
          onClick={() => {
            void copyText(createSql).then((ok) => {
              if (ok) setCopied(true);
            });
          }}
          title={copied ? t("已复制") : t("复制 DDL")}
          aria-label={copied ? t("已复制") : t("复制 DDL")}
        >
          <Copy size={11} />
        </Button>
        <Button
          variant="ghost"
          size="xs"
          className="h-6 w-6 px-0"
          onClick={hideDdl}
          title={t("关闭 DDL，恢复已打开列表")}
          aria-label={t("关闭 DDL，恢复已打开列表")}
        >
          <X size={11} />
        </Button>
      </div>

      <div className="min-h-0 flex-1 overflow-hidden">
        {loading && !detail ? (
          <div className="flex h-full items-center gap-2 px-3 text-12 text-fg-subtle">
            <Loader2 size={13} className="animate-spin" />
            {t("加载表定义…")}
          </div>
        ) : createSql ? (
          <div className="h-full p-2">
            <DdlCode sql={createSql} wrap={wrap} />
          </div>
        ) : (
          <p className="px-3 py-2 text-12 text-fg-subtle">{t("没有可用的建表语句")}</p>
        )}
      </div>
    </aside>
  );
}
