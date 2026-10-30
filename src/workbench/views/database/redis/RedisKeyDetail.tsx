/**
 * 键详情面板与按类型的值编辑器（string / hash / list / set / zset / stream）。
 */
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Loader2,
  Minus,
  Pencil,
  Plus,
  RefreshCw,
  Trash2,
  TriangleAlert,
} from "@/components/icons";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { databaseApi } from "@/api/ops-api";
import { pushToast } from "@/components/ui/toast";
import { toDbError } from "@/stores/database-store";
import type {
  DatabaseProfile,
  RedisFieldEntry,

  RedisKeyInfo,

  RedisValuePayload,
  RedisZEntry,
} from "@/api/types/database";

/** 前端累计键数上限：持续翻页不设限会一直涨内存（10 万行 ≈ 30 MB）。 */
import {
  formatTtl,
  alertRedisFailure,
  SET_PAGE_SIZE,
} from "./redis-shared";
import type { RedisMutate } from "./redis-shared";

/** 参考图的表单行：左侧固定 78px 标签列（左对齐），右侧内容。 */
function FormRow({
  label,
  children,
  align = "center",
  grow = false,
}: {
  label: string;
  children: React.ReactNode;
  align?: "center" | "start";
  grow?: boolean;
}) {
  return (
    <div
      className={`flex min-w-0 gap-2 ${align === "start" ? "items-start" : "items-center"} ${
        grow ? "min-h-0 flex-1" : ""
      }`}
    >
      <span className="w-[78px] shrink-0 text-left text-11 leading-[24px] text-fg-muted">
        {label}
      </span>
      {children}
    </div>
  );
}

/** "上次刷新时间"：只显示粗粒度，不为了一个标签每秒重渲染。 */
function formatAgo(at: number): string {
  const seconds = Math.max(0, Math.round((Date.now() - at) / 1000));
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  return `${Math.round(seconds / 3600)}h`;
}

export function ValuePanel({
  profile,
  dbIndex,
  selectedKey,
  keyInfo,
  payload,
  mutate,
  onReadFull,
  onDeleted,
  onCreateKey,
  onReload,
}: {
  profile: DatabaseProfile;
  dbIndex: number;
  selectedKey: string;
  keyInfo: RedisKeyInfo | null;
  payload: RedisValuePayload | null;
  mutate: RedisMutate;
  /** 大 string 只回了预览：显式请求全量（后端有 8 MiB 硬上限）。 */
  onReadFull: () => void;
  onDeleted: () => void;
  /** 顶部工具条的 +：新建键（交给工作区，那里有对话框与刷新逻辑）。 */
  onCreateKey: () => void;
  /** 顶部工具条的刷新：重新读取本键（含 TTL/大小）。 */
  onReload: () => void;
}) {
  const { t } = useTranslation();
  const writable = !profile.read_only;
  /** 删除是不可撤销的：必须先过危险确认，且在服务端确认成功后才收起面板。 */
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteFailure, setDeleteFailure] = useState<unknown>(null);
  // 参考图是"表单式"编辑器：键名、值、TTL 都是本地草稿，点应用才落库。
  const [nameDraft, setNameDraft] = useState(selectedKey);
  const [valueDraft, setValueDraft] = useState("");
  const [ttlMode, setTtlMode] = useState<"seconds" | "hours" | "days">("seconds");
  const [ttlAmount, setTtlAmount] = useState("");
  const [loadedAt, setLoadedAt] = useState(() => Date.now());
  /** 键名默认只读，双击才进入编辑（参考图里也是双击改键名）。 */
  const [nameEditing, setNameEditing] = useState(false);
  /** 待转换的目标类型；非 null 时弹确认框。 */
  const [pendingType, setPendingType] = useState<string | null>(null);
  const [converting, setConverting] = useState(false);
  const [convertError, setConvertError] = useState<string | null>(null);

  useEffect(() => {
    setNameDraft(selectedKey);
  }, [selectedKey]);

  useEffect(() => {
    setValueDraft(payload && payload.kind === "string" ? payload.value : "");
    setLoadedAt(Date.now());
    setTtlAmount(
      keyInfo && keyInfo.ttl_ms > 0 ? String(Math.round(keyInfo.ttl_ms / 1000)) : "",
    );
  }, [selectedKey, payload, keyInfo]);

  if (!payload) {
    return (
      <div className="flex h-full items-center justify-center px-6">
        <p className="text-center text-12 text-fg-subtle">{t("无法读取该键的内容")}</p>
      </div>
    );
  }

  /** TTL 应用：留空 = PERSIST（永久）。 */
  const applyTtl = () => {
    const amount = Number(ttlAmount);
    const unit = ttlMode === "seconds" ? 1000 : ttlMode === "hours" ? 3_600_000 : 86_400_000;
    const ms = ttlAmount.trim() === "" ? null : Math.max(1, amount) * unit;
    void mutate(
      () => databaseApi.redisKeyExpire(profile.id, dbIndex, selectedKey, ms),
      ms === null ? t("已设为永久") : t("TTL 已更新"),
    );
  };

  const ttlUnit = ttlMode === "seconds" ? 1000 : ttlMode === "hours" ? 3_600_000 : 86_400_000;
  const draftTtlMs =
    ttlAmount.trim() === "" ? null : Math.max(1, Number(ttlAmount)) * ttlUnit;
  /** 与服务器现值比较：null 表示永久，-1 表示无 TTL。 */
  const ttlDirty = (draftTtlMs ?? -1) !== (keyInfo ? keyInfo.ttl_ms : -1);
  const valueDirty = payload?.kind === "string" && valueDraft !== payload.value;
  const dirty = valueDirty || ttlDirty;

  /**
   * 底部只有一个「应用」：值 + TTL 一起提交。
   * （此前 TTL 行里还有一个独立的「应用」，两个同名按钮非常容易点错。）
   */
  const applyAll = () => {
    if (valueDirty && payload?.kind === "string") {
      void mutate(
        () =>
          databaseApi.redisWriteString(profile.id, dbIndex, selectedKey, valueDraft, false),
        t("已保存"),
      );
    }
    if (ttlDirty) {
      void mutate(
        () => databaseApi.redisKeyExpire(profile.id, dbIndex, selectedKey, draftTtlMs),
        draftTtlMs === null ? t("已设为永久") : t("TTL 已更新"),
      );
    }
  };
  const resetAll = () => {
    if (payload?.kind === "string") setValueDraft(payload.value);
    setTtlAmount(
      keyInfo && keyInfo.ttl_ms > 0 ? String(Math.round(keyInfo.ttl_ms / 1000)) : "",
    );
    setTtlMode("seconds");
  };

  /** 当前值 → 可写文本（转换时作为原始数据）。 */
  const renderText = (): string => {
    if (!payload) return "";
    switch (payload.kind) {
      case "string":
        return valueDraft;
      case "list":
        return payload.items.join("\n");
      case "set":
        return payload.members.join("\n");
      case "hash":
        return payload.fields.map((entry) => `${entry.field}=${entry.value}`).join("\n");
      case "zset":
        return payload.entries.map((entry) => `${entry.member}\t${entry.score}`).join("\n");
      default:
        return "";
    }
  };

  /**
   * 转换键类型：Redis 没有"改类型"命令，只能读出现值 → 删键 → 按新类型写回。
   * 因此必须走不可撤销确认，且 TTL 不会保留。
   */
  const convertKey = async () => {
    const target = pendingType;
    if (!target || !payload) return;
    const text = renderText();
    setConverting(true);
    setConvertError(null);
    try {
      await databaseApi.redisKeyDelete(profile.id, dbIndex, selectedKey);
      if (target === "string") {
        await databaseApi.redisCreateString(profile.id, dbIndex, selectedKey, text);
      } else if (target === "list") {
        for (const line of text.split("\n")) {
          if (!line) continue;
          await databaseApi.redisWriteList(profile.id, dbIndex, selectedKey, {
            push: { front: false, value: line },
          });
        }
      } else if (target === "set") {
        for (const line of text.split("\n")) {
          if (!line) continue;
          await databaseApi.redisWriteSet(profile.id, dbIndex, selectedKey, line, true);
        }
      } else if (target === "hash") {
        for (const line of text.split("\n")) {
          const at = line.indexOf("=");
          if (at <= 0) continue;
          await databaseApi.redisWriteHashField(
            profile.id,
            dbIndex,
            selectedKey,
            line.slice(0, at),
            line.slice(at + 1),
          );
        }
      } else if (target === "zset") {
        for (const line of text.split("\n")) {
          const [member, score] = line.split("\t");
          const value = Number(score);
          if (!member || !Number.isFinite(value)) continue;
          await databaseApi.redisWriteZset(profile.id, dbIndex, selectedKey, member, value);
        }
      }
      setPendingType(null);
      pushToast(t("已转换为 {{type}}", { type: target }), "success");
      onReload();
    } catch (failure) {
      setConvertError(toDbError(failure).message);
    } finally {
      setConverting(false);
    }
  };

  const runDelete = async () => {
    setDeleting(true);
    setDeleteFailure(null);
    const ok = await mutate(
      () => databaseApi.redisKeyDelete(profile.id, dbIndex, selectedKey),
      t("键已删除"),
      // 错误就地显示在弹窗里：不再往顶部推一条一模一样的提示。
      (failure) => setDeleteFailure(failure),
    );
    setDeleting(false);
    if (!ok) return;
    setConfirmOpen(false);
    onDeleted();
  };

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      {/* 顶部工具条：+ / − 在左，刷新与获取在右（参考图顺序） */}
      <div className="flex h-7 shrink-0 items-center gap-1 border-b border-line px-2 text-10 text-fg-subtle">
        <Button
          variant="ghost"
          size="xs"
          className="h-5 w-5 px-0"
          aria-label={t("新建键")}
          onClick={onCreateKey}
        >
          <Plus size={12} />
        </Button>
        <Button
          variant="ghost"
          size="xs"
          className="h-5 w-5 px-0 text-danger"
          aria-label={t("删除键")}
          disabled={!writable}
          onClick={() => {
            setDeleteFailure(null);
            setConfirmOpen(true);
          }}
        >
          <Minus size={12} />
        </Button>
        <div className="flex-1" />
        <span className="shrink-0">
          {t("上次刷新时间: {{when}}", { when: formatAgo(loadedAt) })}
        </span>
        <Button variant="ghost" size="xs" className="h-5 px-1.5" onClick={onReload}>
          <RefreshCw size={11} />
          {t("刷新")}
        </Button>
        <Button
          variant="ghost"
          size="xs"
          className="h-5 px-1.5"
          disabled={payload.kind !== "string" || !payload.truncated}
          onClick={onReadFull}
        >
          {t("获取更多")}
        </Button>
        <Button
          variant="ghost"
          size="xs"
          className="h-5 px-1.5"
          disabled={payload.kind !== "string" || !payload.truncated}
          onClick={onReadFull}
        >
          {t("获取全部")}
        </Button>
      </div>

      {/* 只读连接必须一眼看出来，否则"应用永远是灰的"会被当成 bug */}
      {!writable && (
        <div className="flex shrink-0 items-center gap-1.5 border-b border-warning/30 bg-warning/10 px-3 py-1 text-11 text-warning">
          <TriangleAlert size={11} className="shrink-0" />
          {t("只读连接：编辑已禁用，可在连接设置里取消「只读」后重连。")}
        </div>
      )}

      {/* 名称/类型固定，值区自己滚；整块不再整体滚动，避免把 TTL 顶出去 */}
      <div className="flex min-h-0 flex-1 flex-col gap-2.5 overflow-hidden px-3 py-2.5">
        <FormRow label={t("键名称:")}>
          <input
            className="h-[24px] min-w-0 flex-1 rounded-[3px] border border-line bg-surface-1 px-1.5 font-mono text-11 text-fg outline-none focus:border-accent"
            value={nameDraft}
            readOnly={!writable || !nameEditing}
            onDoubleClick={() => {
              if (!writable) return;
              setNameEditing(true);
            }}
            onChange={(event) => setNameDraft(event.target.value)}
            onBlur={() => {
              setNameEditing(false);
              setNameDraft(selectedKey);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter" && nameDraft.trim() && nameDraft !== selectedKey) {
                void mutate(
                  () =>
                    databaseApi.redisKeyRename(
                      profile.id,
                      dbIndex,
                      selectedKey,
                      nameDraft.trim(),
                      false,
                    ),
                  t("已重命名"),
                );
                setNameEditing(false);
              }
              if (event.key === "Escape") {
                setNameDraft(selectedKey);
                setNameEditing(false);
              }
            }}
            title={writable ? t("双击编辑键名") : t("只读连接")}
          />
        </FormRow>

        <FormRow label={t("键类型:")}>
          {/* 类型可改：选中别的类型会走"读值→删键→按新类型写回"的转换确认 */}
          <select
            value={payload.kind}
            aria-label={t("键类型")}
            disabled={payload.kind === "stream" || payload.kind === "other"}
            onChange={(event) => {
              // 下拉本身不 disabled（否则只读用户点不动也看不到原因）。
              if (!writable) {
                pushToast(t("只读连接，不能修改键类型"), "error");
                return;
              }
              setConvertError(null);
              setPendingType(event.target.value);
            }}
            className="h-[24px] w-[205px] shrink-0 rounded-[3px] border border-line bg-surface-1 px-1 text-11 text-fg outline-none focus:border-accent disabled:opacity-60"
          >
            {["string", "hash", "list", "set", "zset"].map((kind) => (
              <option key={kind} value={kind}>
                {kind}
              </option>
            ))}
            {payload.kind === "stream" && <option value="stream">stream</option>}
            {payload.kind === "other" && <option value="other">{payload.type_name}</option>}
          </select>
          {keyInfo && (
            <span className="min-w-0 truncate text-10 text-fg-subtle">
              {keyInfo.memory_bytes !== null && `${keyInfo.memory_bytes} B`}
            </span>
          )}
        </FormRow>

        <FormRow label={t("值:")} align="start" grow>
          {/* self-stretch：FormRow 是 items-start 的横向 flex，子元素默认按内容高度，
              不加它值框只会有一行高，下面留一大块空白。 */}
          <div className="flex min-h-0 w-full min-w-0 flex-1 flex-col gap-1.5 self-stretch overflow-y-auto">
      {payload.kind === "string" && (
        <textarea
          data-redis-editor
          className="h-full min-h-[80px] w-full flex-1 resize-none rounded-[3px] border border-line bg-surface-1 px-1.5 py-1 font-mono text-11 leading-[18px] text-fg outline-none focus:border-accent"
          value={valueDraft}
          readOnly={!writable || payload.truncated}
          onChange={(event) => setValueDraft(event.target.value)}
          spellCheck={false}
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
        </FormRow>
      </div>

      {/* TTL 与保存按钮固定在编辑区**底部**：值区再长也压不到它们，
          编辑区高度变化时也不会把这两行滚出去。 */}
      <div className="flex shrink-0 items-center gap-2 border-t border-line px-3 py-2">
        <span className="w-[78px] shrink-0 text-left text-11 text-fg-muted">TTL:</span>
        <select
          value={ttlMode}
          aria-label={t("TTL 单位")}
          onChange={(event) => setTtlMode(event.target.value as "seconds" | "hours" | "days")}
          className="h-[24px] w-[205px] shrink-0 rounded-[3px] border border-line bg-surface-1 px-1 text-11 text-fg outline-none focus:border-accent"
        >
          <option value="seconds">{t("过期时间（秒）")}</option>
          <option value="hours">{t("过期时间（小时）")}</option>
          <option value="days">{t("过期时间（天）")}</option>
        </select>
        <input
          className="h-[24px] w-[200px] shrink-0 rounded-[3px] border border-line bg-surface-1 px-1.5 text-11 text-fg outline-none focus:border-accent"
          value={ttlAmount}
          placeholder={t("留空 = 永久")}
          inputMode="numeric"
          onChange={(event) => setTtlAmount(event.target.value.replace(/[^0-9]/g, ""))}
          onKeyDown={(event) => {
            if (event.key === "Enter") applyTtl();
          }}
        />
        <div className="flex-1" />
        <Button
          variant="secondary"
          size="xs"
          disabled={!writable || !dirty}
          onClick={applyAll}
        >
          {t("应用")}
        </Button>
        <Button variant="ghost" size="xs" disabled={!dirty} onClick={resetAll}>
          {t("放弃")}
        </Button>
      </div>

      <ConfirmDialog
        open={confirmOpen}
        risk="irreversible"
        title={t("删除键")}
        description={
          <span className="font-mono break-all text-fg">{selectedKey}</span>
        }
        consequences={[
          t("键与其全部数据会被立即删除，事务日志之外无法恢复。"),
          keyInfo
            ? t("类型 {{kind}} · {{count}} 字节 · TTL {{ttl}}", {
                kind: keyInfo.kind,
                count: keyInfo.memory_bytes ?? 0,
                ttl: formatTtl(keyInfo.ttl_ms),
              })
            : t("该键的内容会一并消失。"),
        ]}
        confirmLabel={t("删除")}
        pending={deleting}
        error={deleteFailure ?? undefined}
        onConfirm={() => void runDelete()}
        onCancel={() => setConfirmOpen(false)}
      />

      {/* 类型转换：本质是"删键重建"，必须说清楚并给二次确认 */}
      <ConfirmDialog
        open={pendingType !== null}
        risk="irreversible"
        title={t("转换为 {{type}}", { type: pendingType ?? "" })}
        description={
          <span className="font-mono break-all text-fg">{selectedKey}</span>
        }
        consequences={[
          t("Redis 没有改类型命令：会读取当前值、删除原键、再按新类型写回。"),
          t("原 TTL 不会保留；结构信息（如 hash 字段名、zset 分数）按文本重新解析。"),
          t("转换失败时原键已被删除，且无法回滚。"),
        ]}
        confirmLabel={t("转换")}
        pending={converting}
        error={convertError}
        onConfirm={() => void convertKey()}
        onCancel={() => {
          setPendingType(null);
          setConvertError(null);
        }}
      />
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
  mutate: RedisMutate;
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
    <div className="flex w-full min-w-0 flex-col gap-1.5">
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
  mutate: RedisMutate;
}) {
  const { t } = useTranslation();
  const writable = !profile.read_only && !payload.truncated;
  const [pushValue, setPushValue] = useState("");
  // 续读：payload 只给前 5000 条，剩下的靠 LRANGE 索引一页页补。
  const [extra, setExtra] = useState<string[]>([]);
  const [nextStart, setNextStart] = useState(payload.items.length);
  const [loadingMore, setLoadingMore] = useState(false);

  useEffect(() => {
    setExtra([]);
    setNextStart(payload.items.length);
  }, [payload]);

  const items = extra.length > 0 ? [...payload.items, ...extra] : payload.items;
  const loadMore = async () => {
    setLoadingMore(true);
    try {
      const page = await databaseApi.redisListPage(
        profile.id,
        dbIndex,
        selectedKey,
        nextStart,
        500,
      );
      setExtra((current) => [...current, ...page.items]);
      setNextStart(page.next_start);
    } catch (failure) {
      alertRedisFailure(failure, t("加载更多失败"));
    } finally {
      setLoadingMore(false);
    }
  };

  return (
    <div className="flex flex-col gap-1.5">
      <div className="text-11 text-fg-subtle">
        {payload.length} 项
        {payload.truncated && `（${t("显示前 {{count}} 项", { count: items.length })}）`}
      </div>
      {nextStart < payload.length && (
        <button
          type="button"
          disabled={loadingMore}
          className="self-start rounded-[6px] border border-line px-2 py-1 text-11 text-fg-muted hover:bg-surface-hover disabled:opacity-60"
          onClick={() => void loadMore()}
        >
          {loadingMore
            ? t("加载中…")
            : t("加载更多（已加载 {{loaded}}/{{total}}）", {
                loaded: items.length,
                total: payload.length,
              })}
        </button>
      )}
      <div className="overflow-hidden rounded-[8px] border border-line">
        {items.map((item, index) => (
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
  mutate: RedisMutate;
}) {
  const { t } = useTranslation();
  const writable = !profile.read_only;
  const [newMember, setNewMember] = useState("");
  /** 正在编辑的成员（双击进入）；成员不能原地改，保存时 SREM + SADD。 */
  const [editingMember, setEditingMember] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState("");
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

  /**
   * 成员"改名"= 删旧 + 加新。
   * 这不是原子操作：两步之间失败会只剩删除结果，所以调用方必须看到错误原文。
   */
  const saveMember = async (old: string) => {
    const next = editDraft.trim();
    if (!next || next === old) {
      setEditingMember(null);
      return;
    }
    await mutate(async () => {
      await databaseApi.redisWriteSet(profile.id, dbIndex, selectedKey, old, false);
      await databaseApi.redisWriteSet(profile.id, dbIndex, selectedKey, next, true);
    }, t("成员已更新"));
    setEditingMember(null);
  };

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
    <div className="flex w-full min-w-0 flex-col gap-1.5">
      <div className="text-11 text-fg-subtle">
        {payload.length} 成员
        {payload.truncated && `（${t("显示前 {{count}} 个", { count: members.length })}）`}
      </div>
      <div className="overflow-hidden rounded-[8px] border border-line">
        {members.map((member) => (
          <div key={member} className="flex items-center gap-2 border-b border-line/60 px-2 py-1 last:border-b-0">
            {editingMember === member ? (
              <input
                autoFocus
                className="h-[22px] min-w-0 flex-1 rounded-[3px] border border-accent bg-surface-1 px-1.5 font-mono text-11 text-fg outline-none"
                value={editDraft}
                onChange={(event) => setEditDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") void saveMember(member);
                  if (event.key === "Escape") setEditingMember(null);
                }}
              />
            ) : (
              <span
                className="min-w-0 flex-1 truncate font-mono text-11 text-fg"
                title={writable ? t("双击编辑成员") : member}
                onDoubleClick={() => {
                  if (!writable) {
                    pushToast(t("只读连接，不能修改成员"), "error");
                    return;
                  }
                  setEditingMember(member);
                  setEditDraft(member);
                }}
              >
                {member}
              </span>
            )}
            {writable && editingMember === member && (
              <>
                <Button variant="secondary" size="xs" onClick={() => void saveMember(member)}>
                  {t("保存")}
                </Button>
                <Button variant="ghost" size="xs" onClick={() => setEditingMember(null)}>
                  {t("取消")}
                </Button>
              </>
            )}
            {writable && editingMember !== member && (
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
  mutate: RedisMutate;
}) {
  const { t } = useTranslation();
  const writable = !profile.read_only;
  const [newMember, setNewMember] = useState("");
  const [newScore, setNewScore] = useState("");
  // 续读：ZRANGE 索引分页，超过首批 5000 个成员也能一页页看完。
  const [extra, setExtra] = useState<RedisZEntry[]>([]);
  const [nextStart, setNextStart] = useState(payload.entries.length);
  const [loadingMore, setLoadingMore] = useState(false);

  useEffect(() => {
    setExtra([]);
    setNextStart(payload.entries.length);
  }, [payload]);

  const entries = extra.length > 0 ? [...payload.entries, ...extra] : payload.entries;
  const loadMore = async () => {
    setLoadingMore(true);
    try {
      const page = await databaseApi.redisZsetPage(
        profile.id,
        dbIndex,
        selectedKey,
        nextStart,
        500,
      );
      setExtra((current) => [...current, ...page.entries]);
      setNextStart(page.next_start);
    } catch (failure) {
      alertRedisFailure(failure, t("加载更多失败"));
    } finally {
      setLoadingMore(false);
    }
  };

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
        {payload.truncated && `（${t("显示前 {{count}} 个", { count: entries.length })}）`}
      </div>
      {nextStart < payload.length && (
        <button
          type="button"
          disabled={loadingMore}
          className="self-start rounded-[6px] border border-line px-2 py-1 text-11 text-fg-muted hover:bg-surface-hover disabled:opacity-60"
          onClick={() => void loadMore()}
        >
          {loadingMore
            ? t("加载中…")
            : t("加载更多（已加载 {{loaded}}/{{total}}）", {
                loaded: entries.length,
                total: payload.length,
              })}
        </button>
      )}
      <div className="overflow-hidden rounded-[8px] border border-line">
        {entries.map((entry) => (
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
