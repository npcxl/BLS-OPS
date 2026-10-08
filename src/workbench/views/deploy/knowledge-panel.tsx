/**
 * P5.5 —— **部署知识库** 页（P5.5.1 补齐管理能力）。
 *
 * ```text
 * 左：全部 / 全局 / 当前应用 / 当前环境 + 分类筛选 + 「显示已归档」
 * 中：标题 / 作用域 / 分类 / 标签 / 来源 / Markdown 编辑 / 保存新版本
 * 右：元数据（启用 / 状态 / 最近核对 / 备注）· 历史版本（预览 / 恢复）· 引用
 * ```
 *
 * 几条必须说清楚的话：
 *
 * 1. **空状态**：没有用户知识时，系统仍然用内置规则生成部署方案 ——
 *    知识库是补充，不是前提；
 * 2. **版本**：保存 = 新版本，旧版本永不覆盖；"恢复"也是产生**新**版本，
 *    历史记录不改写；
 * 3. **归档不是删除**：归档的文档不再参与检索，但内容与版本历史都还在，
 *    历史方案里的引用因此不会悬空；
 * 4. **元数据与内容分开**：启用 / 状态 / 最近核对 / 备注是元数据更新，
 *    **不产生新版本**（版本只由正文变更驱动）；
 * 5. **Markdown 导入**只读文件内容进编辑器，用户确认后才保存，绝不自动覆盖
 *    任何已有文档。
 *
 * 不用 Mock 数据：列表、版本、引用、检索全部来自 opsApi。
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Archive, FileUp, Eye } from "lucide-react";

import { opsApi, toErrorMessage } from "@/api/ops-api";
import type {
  KnowledgeCategory,
  KnowledgeDocStatus,
  KnowledgeDocument,
  KnowledgeHit,
  KnowledgeMetaUpdate,
  KnowledgeScope,
  KnowledgeSourceType,
  KnowledgeUsageRecord,
  KnowledgeVersion,
} from "@/api/types/deployment";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { ErrorText, selectClass } from "@/components/ui/modal";
import { cn } from "@/lib/cn";

type Props = {
  applicationId: string;
  environmentId: string;
};

const SCOPES: KnowledgeScope[] = ["global", "application", "environment"];

const CATEGORIES: KnowledgeCategory[] = [
  "platform",
  "deployment_pattern",
  "sizing",
  "dns",
  "ssl",
  "health_check",
  "rollback",
  "security",
  "troubleshooting",
  "project_context",
  "custom",
];

const STATUSES: KnowledgeDocStatus[] = ["draft", "active", "archived"];

/**
 * 状态展示（后端枚举 draft / active / archived）。
 *
 * key 带 `Knowledge` 前缀：`Archive` / `Published` 这些裸词已被
 * "压缩包" / "发布时间"占用，直接用会串味。
 */
const STATUS_LABELS: Record<KnowledgeDocStatus, string> = {
  draft: "Knowledge draft",
  active: "Knowledge published",
  archived: "Knowledge archived",
};

const STATUS_TONES: Record<KnowledgeDocStatus, string> = {
  draft: "border-line bg-surface-2 text-fg-muted",
  active: "border-accent/40 bg-accent/10 text-accent",
  archived: "border-line bg-surface-2 text-fg-subtle",
};

function newDocument(applicationId: string, environmentId: string): KnowledgeDocument {
  return {
    id: "",
    title: "",
    scope: environmentId ? "environment" : applicationId ? "application" : "global",
    application_id: applicationId || null,
    environment_id: environmentId || null,
    category: "custom",
    tags: [],
    source_type: "manual",
    source_name: "",
    version: 1,
    status: "draft",
    content: "",
    content_hash: "",
    enabled: true,
    last_verified_at: null,
    note: "",
    created_at: 0,
    updated_at: 0,
  };
}

/** 毫秒时间戳 → `<input type="date">` 的值。 */
function toDateInput(value: number | null): string {
  if (value == null) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const pad = (part: number) => String(part).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** `<input type="date">` 的值 → 毫秒时间戳（空 = 未核对）。 */
function fromDateInput(value: string): number | null {
  if (!value) return null;
  const parsed = Date.parse(`${value}T00:00:00`);
  return Number.isNaN(parsed) ? null : parsed;
}

export function KnowledgePanel({ applicationId, environmentId }: Props) {
  const { t } = useTranslation();
  const [documents, setDocuments] = useState<KnowledgeDocument[]>([]);
  const [filter, setFilter] = useState<"all" | KnowledgeScope>("all");
  const [category, setCategory] = useState<KnowledgeCategory | "">("");
  const [showArchived, setShowArchived] = useState(false);
  const [selected, setSelected] = useState<KnowledgeDocument | null>(null);
  const [versions, setVersions] = useState<KnowledgeVersion[]>([]);
  const [usage, setUsage] = useState<KnowledgeUsageRecord[]>([]);
  const [hits, setHits] = useState<KnowledgeHit[] | null>(null);
  const [preview, setPreview] = useState<KnowledgeVersion | null>(null);
  const [pendingArchive, setPendingArchive] = useState(false);
  const [pendingRestore, setPendingRestore] = useState<KnowledgeVersion | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const list = await opsApi.deploymentKnowledgeList(
      applicationId || undefined,
      environmentId || undefined,
      showArchived,
    );
    setDocuments(list);
    return list;
  }, [applicationId, environmentId, showArchived]);

  useEffect(() => {
    void (async () => {
      try {
        await load();
      } catch (cause) {
        setError(toErrorMessage(cause));
      }
    })();
  }, [load]);

  const visible = useMemo(() => {
    return documents.filter((document) => {
      if (filter !== "all" && document.scope !== filter) return false;
      if (category && document.category !== category) return false;
      return true;
    });
  }, [documents, filter, category]);

  const open = async (document: KnowledgeDocument) => {
    setSelected(document);
    setHits(null);
    setPreview(null);
    if (!document.id) {
      setVersions([]);
      setUsage([]);
      return;
    }
    try {
      const [history, used] = await Promise.all([
        opsApi.deploymentKnowledgeVersions(document.id),
        opsApi.deploymentKnowledgeUsage(document.id),
      ]);
      setVersions(history);
      setUsage(used);
    } catch (cause) {
      setError(toErrorMessage(cause));
    }
  };

  const save = async () => {
    if (!selected) return;
    setBusy(true);
    setError(null);
    try {
      const saved = await opsApi.deploymentKnowledgeSave(selected);
      setSelected(saved);
      await load();
      setVersions(await opsApi.deploymentKnowledgeVersions(saved.id));
    } catch (cause) {
      setError(toErrorMessage(cause));
    } finally {
      setBusy(false);
    }
  };

  /** 元数据更新：**不改内容、不产生新版本**。 */
  const saveMeta = async () => {
    if (!selected?.id) return;
    setBusy(true);
    setError(null);
    try {
      const update: KnowledgeMetaUpdate = {
        enabled: selected.enabled,
        status: selected.status,
        last_verified_at: selected.last_verified_at,
        note: selected.note,
      };
      const saved = await opsApi.deploymentKnowledgeUpdateMeta(selected.id, update);
      setSelected(saved);
      await load();
    } catch (cause) {
      setError(toErrorMessage(cause));
    } finally {
      setBusy(false);
    }
  };

  const confirmArchive = async () => {
    if (!selected?.id) return;
    setBusy(true);
    setError(null);
    try {
      await opsApi.deploymentKnowledgeArchive(selected.id);
      setPendingArchive(false);
      const list = await load();
      setSelected(list.find((document) => document.id === selected.id) ?? null);
    } catch (cause) {
      setError(toErrorMessage(cause));
    } finally {
      setBusy(false);
    }
  };

  /** 恢复 = 把目标版本内容作为**新版本**写入，历史不改写。 */
  const confirmRestore = async (version: number) => {
    if (!selected?.id) return;
    setBusy(true);
    setError(null);
    try {
      const restored = await opsApi.deploymentKnowledgeRestore(selected.id, version);
      setPendingRestore(null);
      setSelected(restored);
      await load();
      setVersions(await opsApi.deploymentKnowledgeVersions(restored.id));
    } catch (cause) {
      setError(toErrorMessage(cause));
    } finally {
      setBusy(false);
    }
  };

  const searchTest = async () => {
    if (!selected) return;
    setBusy(true);
    setError(null);
    try {
      const result = await opsApi.deploymentKnowledgeSearchTest({
        application_id: applicationId || null,
        environment_id: environmentId || null,
        terms: [selected.title, selected.category].filter(Boolean),
        limit: 8,
      });
      setHits(result);
    } catch (cause) {
      setError(toErrorMessage(cause));
    } finally {
      setBusy(false);
    }
  };

  const create = () => {
    setSelected(newDocument(applicationId, environmentId));
    setVersions([]);
    setUsage([]);
    setHits(null);
    setPreview(null);
  };

  /** 受限导入：文件选择器 → Rust 受限读取 → 内容进编辑器（不落库）。 */
  const importMarkdown = async () => {
    try {
      const { open: openFileDialog } = await import("@tauri-apps/plugin-dialog");
      const path = await openFileDialog({
        multiple: false,
        filters: [{ name: "Markdown", extensions: ["md", "markdown", "txt"] }],
      });
      if (typeof path !== "string" || !path) return;
      setBusy(true);
      setError(null);
      const imported = await opsApi.deploymentKnowledgeImportMarkdown(path);
      setSelected({
        ...newDocument(applicationId, environmentId),
        title: imported.suggested_title,
        content: imported.content,
        source_type: imported.source_type,
        source_name: imported.file_name,
      });
      setVersions([]);
      setUsage([]);
      setHits(null);
      setPreview(null);
    } catch (cause) {
      setError(toErrorMessage(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="grid h-full min-h-0 grid-cols-1 gap-3 lg:grid-cols-[200px_minmax(0,1fr)_300px]">
      {/* ---------- 左：筛选 ---------- */}
      <aside className="min-h-0 space-y-2 overflow-auto ops-scroll">
        <button
          type="button"
          onClick={() => void create()}
          className="w-full rounded-[7px] bg-accent px-2 py-1 text-11 font-medium text-white"
        >
          {t("New knowledge")}
        </button>
        <Button
          size="sm"
          variant="secondary"
          className="w-full"
          disabled={busy}
          onClick={() => void importMarkdown()}
        >
          <FileUp size={12} className="mr-1" />
          {t("Import Markdown")}
        </Button>
        <ul className="space-y-1 text-11">
          <li>
            <button
              type="button"
              onClick={() => setFilter("all")}
              className={cn("w-full text-left", filter === "all" ? "text-fg" : "text-fg-subtle")}
            >
              {t("All knowledge")} ({documents.length})
            </button>
          </li>
          {SCOPES.map((scope) => (
            <li key={scope}>
              <button
                type="button"
                onClick={() => setFilter(scope)}
                className={cn("w-full text-left", filter === scope ? "text-fg" : "text-fg-subtle")}
              >
                {t(scope)} (
                {documents.filter((document) => document.scope === scope).length})
              </button>
            </li>
          ))}
        </ul>
        <select
          className={cn(selectClass, "w-full")}
          value={category}
          onChange={(event) => setCategory(event.target.value as KnowledgeCategory | "")}
        >
          <option value="">{t("All categories")}</option>
          {CATEGORIES.map((item) => (
            <option key={item} value={item}>
              {t(item)}
            </option>
          ))}
        </select>
        <label className="flex items-center gap-1.5 text-11 text-fg-subtle">
          <input
            type="checkbox"
            checked={showArchived}
            onChange={(event) => setShowArchived(event.target.checked)}
          />
          {t("Show archived")}
        </label>
        <ul className="space-y-1 text-11">
          {visible.length === 0 ? (
            <li className="text-fg-subtle">{t("No knowledge yet")}</li>
          ) : null}
          {visible.map((document) => (
            <li key={document.id} className="flex items-center gap-1">
              {/* 按钮里只有"标题 · 版本"：状态徽标放在按钮外，避免污染其文本。 */}
              <button
                type="button"
                onClick={() => void open(document)}
                className={cn(
                  "min-w-0 flex-1 truncate text-left",
                  selected?.id === document.id ? "text-fg" : "text-fg-subtle",
                )}
              >
                {document.title} · v{document.version}
              </button>
              {!document.enabled ? (
                <span className="shrink-0 text-9 text-fg-subtle">{t("Disabled")}</span>
              ) : null}
              <span
                className={cn(
                  "shrink-0 rounded border px-1 text-9",
                  STATUS_TONES[document.status],
                )}
              >
                {t(STATUS_LABELS[document.status])}
              </span>
            </li>
          ))}
        </ul>
      </aside>

      {/* ---------- 中：编辑 ---------- */}
      <section className="flex min-h-0 flex-col rounded-md border border-line bg-surface">
        {error ? <ErrorText>{error}</ErrorText> : null}
        {!selected ? (
          <div className="p-3 text-11 text-fg-subtle">
            {t("No user knowledge: the system still generates proposals from its built-in rules.")}
          </div>
        ) : (
          <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-auto ops-scroll p-3">
            <input
              className={cn(selectClass, "w-full")}
              placeholder={t("Title")}
              value={selected.title}
              onChange={(event) => setSelected({ ...selected, title: event.target.value })}
            />
            <div className="flex flex-wrap gap-2">
              <select
                className={selectClass}
                value={selected.scope}
                onChange={(event) =>
                  setSelected({ ...selected, scope: event.target.value as KnowledgeScope })
                }
              >
                {SCOPES.map((scope) => (
                  <option key={scope} value={scope}>
                    {t(scope)}
                  </option>
                ))}
              </select>
              <select
                className={selectClass}
                value={selected.category}
                onChange={(event) =>
                  setSelected({ ...selected, category: event.target.value as KnowledgeCategory })
                }
              >
                {CATEGORIES.map((item) => (
                  <option key={item} value={item}>
                    {t(item)}
                  </option>
                ))}
              </select>
              <select
                className={selectClass}
                value={selected.source_type}
                onChange={(event) =>
                  setSelected({
                    ...selected,
                    source_type: event.target.value as KnowledgeSourceType,
                  })
                }
              >
                <option value="manual">{t("manual")}</option>
                <option value="markdown_file">{t("markdown_file")}</option>
                <option value="imported_text">{t("imported_text")}</option>
              </select>
              <input
                className={selectClass}
                placeholder={t("Source")}
                value={selected.source_name}
                onChange={(event) =>
                  setSelected({ ...selected, source_name: event.target.value })
                }
              />
              <input
                className={selectClass}
                placeholder={t("Tags (comma separated)")}
                value={selected.tags.join(",")}
                onChange={(event) =>
                  setSelected({
                    ...selected,
                    tags: event.target.value
                      .split(",")
                      .map((tag) => tag.trim())
                      .filter(Boolean),
                  })
                }
              />
            </div>

            {/* 元数据（与内容分开保存：不产生新版本） */}
            <div className="rounded-[7px] border border-line bg-surface-2 p-2">
              <div className="mb-1 text-10 text-fg-subtle">{t("Metadata")}</div>
              <div className="flex flex-wrap items-center gap-2">
                <label className="flex items-center gap-1.5 text-11 text-fg-muted">
                  <input
                    type="checkbox"
                    data-testid="knowledge-enabled"
                    checked={selected.enabled}
                    onChange={(event) =>
                      setSelected({ ...selected, enabled: event.target.checked })
                    }
                  />
                  {t("Enabled")}
                </label>
                <select
                  className={selectClass}
                  data-testid="knowledge-status"
                  value={selected.status}
                  onChange={(event) =>
                    setSelected({
                      ...selected,
                      status: event.target.value as KnowledgeDocStatus,
                    })
                  }
                >
                  {STATUSES.map((status) => (
                    <option key={status} value={status}>
                      {t(STATUS_LABELS[status])}
                    </option>
                  ))}
                </select>
                <label className="flex items-center gap-1.5 text-11 text-fg-muted">
                  {t("Last verified")}
                  <input
                    type="date"
                    className={selectClass}
                    data-testid="knowledge-verified"
                    value={toDateInput(selected.last_verified_at)}
                    onChange={(event) =>
                      setSelected({
                        ...selected,
                        last_verified_at: fromDateInput(event.target.value),
                      })
                    }
                  />
                </label>
                <input
                  className={cn(selectClass, "min-w-40 flex-1")}
                  placeholder={t("Knowledge note")}
                  value={selected.note}
                  onChange={(event) => setSelected({ ...selected, note: event.target.value })}
                />
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={busy || !selected.id}
                  onClick={() => void saveMeta()}
                >
                  {t("Save metadata")}
                </Button>
              </div>
              <p className="mt-1 text-10 text-fg-subtle">
                {t("Archived or disabled knowledge does not participate in AI retrieval.")}
              </p>
            </div>

            <textarea
              className="min-h-[200px] flex-1 rounded-[7px] border border-line bg-surface-2 p-2 text-11"
              placeholder="# Markdown"
              value={selected.content}
              onChange={(event) => setSelected({ ...selected, content: event.target.value })}
            />
            <div className="flex flex-wrap items-center gap-2">
              <Button size="sm" disabled={busy} onClick={() => void save()}>
                {t("Save as new version")}
              </Button>
              {selected.id ? (
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={busy}
                  onClick={() => void searchTest()}
                >
                  {t("Retrieval test")}
                </Button>
              ) : null}
              {selected.id && selected.status !== "archived" ? (
                <Button
                  size="sm"
                  variant="danger"
                  disabled={busy}
                  data-testid="knowledge-archive"
                  onClick={() => setPendingArchive(true)}
                >
                  <Archive size={12} className="mr-1" />
                  {t("Archive knowledge")}
                </Button>
              ) : null}
              <span className="text-10 text-fg-subtle">
                {t("Saving never overwrites the previous version.")}
              </span>
            </div>
            {hits ? (
              <div className="rounded-md border border-line bg-surface-2 p-2 text-10">
                <div className="text-fg-subtle">
                  {t("Retrieval results")}: {hits.length}
                </div>
                <ul className="mt-1 space-y-1">
                  {hits.map((hit) => (
                    <li key={`${hit.document_id}-${hit.version}`}>
                      <span className="mr-1 rounded border border-line px-1">
                        {hit.document_id}@{hit.version}
                      </span>
                      {hit.title}
                      {hit.suspicious ? (
                        <span className="ml-1 text-danger">
                          {t("Only usable as quoted data")}
                        </span>
                      ) : null}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </div>
        )}
      </section>

      {/* ---------- 右：版本与引用 ---------- */}
      <aside className="min-h-0 space-y-2 overflow-auto ops-scroll text-11">
        {selected ? (
          <div className="rounded-md border border-line bg-surface-2 p-2">
            <div className="flex items-center gap-1.5">
              <span className="text-fg-subtle">
                {t("Current version")}: v{selected.version}
              </span>
              <span
                className={cn(
                  "rounded border px-1 text-9",
                  STATUS_TONES[selected.status],
                )}
              >
                {t(STATUS_LABELS[selected.status])}
              </span>
            </div>
            <div className="truncate text-10 text-fg-subtle">{selected.content_hash}</div>
            <div className="mt-2 text-fg-subtle">{t("History")}</div>
            <ul className="mt-1 space-y-1">
              {versions.length === 0 ? (
                <li className="text-10 text-fg-subtle">{t("No versions yet")}</li>
              ) : null}
              {versions.map((version) => (
                <li key={version.id} className="flex items-center gap-1.5">
                  <span>v{version.version}</span>
                  {version.note ? (
                    <span className="min-w-0 flex-1 truncate text-10 text-fg-subtle">
                      {version.note}
                    </span>
                  ) : (
                    <span className="flex-1" />
                  )}
                  <button
                    type="button"
                    data-testid={`knowledge-preview-${version.version}`}
                    className="rounded border border-line px-1 text-10"
                    onClick={() => setPreview(version)}
                    title={t("Preview this version")}
                  >
                    <Eye size={11} />
                  </button>
                  <button
                    type="button"
                    data-testid={`knowledge-restore-${version.version}`}
                    className="rounded border border-line px-1 text-10"
                    disabled={busy || version.version === selected.version}
                    onClick={() => setPendingRestore(version)}
                  >
                    {t("Restore")}
                  </button>
                </li>
              ))}
            </ul>

            {preview ? (
              <div className="mt-2 rounded border border-line bg-surface p-2">
                <div className="flex items-center gap-2 text-10 text-fg-subtle">
                  <span>
                    {t("Previewing version {{version}}", { version: preview.version })}
                  </span>
                  <button
                    type="button"
                    className="ml-auto rounded border border-line px-1"
                    onClick={() => setPreview(null)}
                  >
                    {t("Close")}
                  </button>
                </div>
                <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-words text-10 text-fg-muted">
                  {preview.content}
                </pre>
              </div>
            ) : null}

            <div className="mt-2 text-fg-subtle">{t("Used by proposals")}</div>
            <ul className="mt-1 space-y-1 text-10 text-fg-subtle">
              {usage.length === 0 ? <li>{t("Not referenced yet")}</li> : null}
              {usage.map((record) => (
                <li key={record.id}>
                  {record.proposal_id} · v{record.version}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </aside>

      {/* 归档确认（软删除，不物理删除） */}
      {pendingArchive && selected ? (
        <ConfirmDialog
          open
          danger
          title={t("Archive knowledge")}
          description={t(
            "Archiving \"{{title}}\" hides it from AI retrieval; its content and version history are kept.",
            { title: selected.title },
          )}
          confirmLabel={t("Archive knowledge")}
          pending={busy}
          onCancel={() => setPendingArchive(false)}
          onConfirm={() => void confirmArchive()}
        />
      ) : null}

      {/* 恢复前明确告知目标版本，并说明"保存为新版本" */}
      {pendingRestore && selected ? (
        <ConfirmDialog
          open
          title={t("Restore version {{version}}", { version: pendingRestore.version })}
          description={t(
            "Version {{version}} content will be saved as a new version (v{{next}}). History is never rewritten.",
            { version: pendingRestore.version, next: selected.version + 1 },
          )}
          confirmLabel={t("Restore")}
          pending={busy}
          onCancel={() => setPendingRestore(null)}
          onConfirm={() => void confirmRestore(pendingRestore.version)}
        />
      ) : null}
    </div>
  );
}
