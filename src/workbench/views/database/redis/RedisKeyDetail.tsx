/**
 * 键详情面板与按类型的值编辑器（string / hash / list / set / zset / stream）。
 */
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Loader2,
  Pencil,

  Trash2,

} from "@/components/icons";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";

import { Tooltip } from "@/components/ui/tooltip";
import { cn } from "@/lib/cn";
import { databaseApi } from "@/api/ops-api";
import type {
  DatabaseProfile,
  RedisFieldEntry,

  RedisKeyInfo,

  RedisValuePayload,
  RedisZEntry,
} from "@/api/types/database";
import { toDbError, } from "@/stores/database-store";

/** 前端累计键数上限：持续翻页不设限会一直涨内存（10 万行 ≈ 30 MB）。 */
import {
  formatTtl,
  kindBadgeClass,
  alertRedisFailure,
  SET_PAGE_SIZE,
  TTL_PRESETS,
} from "./redis-shared";
import type { RedisMutate } from "./redis-shared";

export function ValuePanel({
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
  mutate: RedisMutate;
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
  /** 删除是不可撤销的：必须先过危险确认，且在服务端确认成功后才收起面板。 */
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteFailure, setDeleteFailure] = useState<unknown>(null);

  if (!payload) {
    return (
      <div className="flex h-full items-center justify-center px-6">
        <p className="text-center text-12 text-fg-subtle">{t("无法读取该键的内容")}</p>
      </div>
    );
  }

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
                onClick={() => {
                  setDeleteFailure(null);
                  setConfirmOpen(true);
                }}
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
  mutate: RedisMutate;
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
