/**
 * P5.5 —— **部署知识库** 页。
 *
 * ```text
 * 左：全部 / 全局 / 当前应用 / 当前环境 + 分类筛选
 * 中：标题 / 作用域 / 分类 / 标签 / 来源 / 最后验证日期 / Markdown 编辑 / 保存新版本
 * 右：当前版本 / 历史版本 / 内容哈希 / 被哪些方案引用 / 检索测试 / 恢复版本
 * ```
 *
 * 两条必须说清楚的话：
 *
 * 1. **空状态**：没有用户知识时，系统仍然用内置规则生成部署方案 ——
 *    知识库是补充，不是前提；
 * 2. **版本**：保存 = 新版本，旧版本永不覆盖；"恢复"也是产生**新**版本。
 *
 * 不用 Mock 数据：列表、版本、引用、检索全部来自 opsApi。
 */
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { opsApi, toErrorMessage } from "@/api/ops-api";
import type {
  KnowledgeCategory,
  KnowledgeDocument,
  KnowledgeHit,
  KnowledgeScope,
  KnowledgeSourceType,
  KnowledgeUsageRecord,
  KnowledgeVersion,
} from "@/api/types/deployment";
import { Button } from "@/components/ui/button";
import { ErrorText, selectClass } from "@/components/ui/modal";
import { cn } from "@/lib/cn";

type Props = {
  applicationId: string;
  environmentId: string;
};

const SCOPES: KnowledgeScope[] = ["global", "application", "environment"];

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

export function KnowledgePanel({ applicationId, environmentId }: Props) {
  const { t } = useTranslation();
  const [documents, setDocuments] = useState<KnowledgeDocument[]>([]);
  const [filter, setFilter] = useState<"all" | KnowledgeScope>("all");
  const [category, setCategory] = useState<KnowledgeCategory | "">("");
  const [selected, setSelected] = useState<KnowledgeDocument | null>(null);
  const [versions, setVersions] = useState<KnowledgeVersion[]>([]);
  const [usage, setUsage] = useState<KnowledgeUsageRecord[]>([]);
  const [hits, setHits] = useState<KnowledgeHit[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    const list = await opsApi.deploymentKnowledgeList(applicationId || undefined, environmentId || undefined);
    setDocuments(list);
    return list;
  };

  useEffect(() => {
    void (async () => {
      try {
        await load();
      } catch (cause) {
        setError(toErrorMessage(cause));
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [applicationId, environmentId]);

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

  const restore = async (version: number) => {
    if (!selected) return;
    setBusy(true);
    setError(null);
    try {
      const restored = await opsApi.deploymentKnowledgeRestore(selected.id, version);
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
  };

  return (
    <div className="grid h-full min-h-0 grid-cols-1 gap-3 lg:grid-cols-[200px_minmax(0,1fr)_280px]">
      {/* ---------- 左：筛选 ---------- */}
      <aside className="min-h-0 space-y-2 overflow-auto ops-scroll">
        <button
          type="button"
          onClick={() => void create()}
          className="w-full rounded-[7px] bg-accent px-2 py-1 text-11 font-medium text-white"
        >
          {t("New knowledge")}
        </button>
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
          {(["platform", "deployment_pattern", "sizing", "dns", "ssl", "health_check", "rollback", "security", "troubleshooting", "project_context", "custom"] as KnowledgeCategory[]).map(
            (item) => (
              <option key={item} value={item}>
                {t(item)}
              </option>
            ),
          )}
        </select>
        <ul className="space-y-1 text-11">
          {visible.length === 0 ? (
            <li className="text-fg-subtle">{t("No knowledge yet")}</li>
          ) : null}
          {visible.map((document) => (
            <li key={document.id}>
              <button
                type="button"
                onClick={() => void open(document)}
                className={cn(
                  "w-full truncate text-left",
                  selected?.id === document.id ? "text-fg" : "text-fg-subtle",
                )}
              >
                {document.title} · v{document.version}
              </button>
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
                {(["platform", "deployment_pattern", "sizing", "dns", "ssl", "health_check", "rollback", "security", "troubleshooting", "project_context", "custom"] as KnowledgeCategory[]).map(
                  (item) => (
                    <option key={item} value={item}>
                      {t(item)}
                    </option>
                  ),
                )}
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
            <textarea
              className="min-h-[220px] flex-1 rounded-[7px] border border-line bg-surface-2 p-2 text-11"
              placeholder="# Markdown"
              value={selected.content}
              onChange={(event) => setSelected({ ...selected, content: event.target.value })}
            />
            <div className="flex items-center gap-2">
              <Button size="sm" disabled={busy} onClick={() => void save()}>
                {t("Save as new version")}
              </Button>
              {selected.id ? (
                <Button size="sm" variant="secondary" disabled={busy} onClick={() => void searchTest()}>
                  {t("Retrieval test")}
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
            <div className="text-fg-subtle">
              {t("Current version")}: v{selected.version}
            </div>
            <div className="truncate text-10 text-fg-subtle">{selected.content_hash}</div>
            <div className="mt-2 text-fg-subtle">{t("History")}</div>
            <ul className="mt-1 space-y-1">
              {versions.length === 0 ? (
                <li className="text-10 text-fg-subtle">{t("No versions yet")}</li>
              ) : null}
              {versions.map((version) => (
                <li key={version.id} className="flex items-center gap-2">
                  <span>v{version.version}</span>
                  <button
                    type="button"
                    className="ml-auto rounded border border-line px-1 text-10"
                    disabled={busy}
                    onClick={() => void restore(version.version)}
                  >
                    {t("Restore")}
                  </button>
                </li>
              ))}
            </ul>
            <div className="mt-2 text-fg-subtle">{t("Used by proposals")}</div>
            <ul className="mt-1 space-y-1 text-10 text-fg-subtle">
              {usage.length === 0 ? (
                <li>{t("Not referenced yet")}</li>
              ) : null}
              {usage.map((record) => (
                <li key={record.id}>
                  {record.proposal_id} · v{record.version}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </aside>
    </div>
  );
}
