import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { opsApi } from "@/api/ops-api";
import type { ExtremeMemory } from "@/api/types/extreme";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { ChevronRight } from "@/components/icons";
import { useExtremeSettingsStore } from "@/stores/extreme-settings-store";

export function MemorySettings() {
  const { t } = useTranslation();
  const memoryEnabled = useExtremeSettingsStore((state) => state.memoryEnabled);
  const updateSettings = useExtremeSettingsStore((state) => state.update);
  const [items, setItems] = useState<ExtremeMemory[]>([]);
  const [text, setText] = useState("");
  const editorRef = useRef<HTMLTextAreaElement>(null);
  const [title, setTitle] = useState("");
  const [editing, setEditing] = useState<ExtremeMemory | null>(null);
  const [remove, setRemove] = useState<ExtremeMemory | null>(null);
  const [clearAll, setClearAll] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const reload = async () => setItems(await opsApi.extremeMemoryList());
  useEffect(() => { void reload().catch((cause) => setError(String(cause))); }, []);
  const save = async () => {
    if (!text.trim() || busy) return;
    setBusy(true); setError("");
    try {
      await opsApi.extremeMemorySave({
        id: editing?.id ?? crypto.randomUUID(), scope: "global",
        serverId: null, workspaceId: null,
        title: title.trim(), content: text.trim(), source: "user", updatedAt: Date.now(),
      });
      await reload(); setText(""); setTitle(""); setEditing(null);
    } catch (cause) { setError(String(cause)); } finally { setBusy(false); }
  };
  return (
    <div className="space-y-3">
      <p className="text-12 leading-5 text-fg-muted">{t("记忆保存在本机，开启后供所有对话参考。服务器状态可能变化，执行前仍会核实；请勿保存密码、密钥和令牌。")}</p>
      <div className="flex items-center justify-between gap-3">
        <span className="text-13 text-fg">{t("在对话中使用长期记忆")}</span>
        <button type="button" role="switch" aria-checked={memoryEnabled} aria-label={t("在对话中使用长期记忆")}
          onClick={() => updateSettings({ memoryEnabled: !memoryEnabled })}
          className={`relative h-5 w-9 rounded-full transition-colors ${memoryEnabled ? "bg-accent" : "bg-surface-active"}`}>
          <span className={`absolute top-0.5 size-4 rounded-full bg-white transition-[left] ${memoryEnabled ? "left-[18px]" : "left-0.5"}`} />
        </button>
      </div>
      {!memoryEnabled && <p className="text-12 text-fg-muted">{t("已关闭自动读取和保存；已有记忆仍可在此管理，会话历史不受影响。")}</p>}
      <p className="text-12 leading-5 text-fg-muted">{t("可在对话中说“记住：部署前先备份”，保存后所有对话都可以参考。")}</p>
      <p className="text-12 leading-5 text-fg-muted">{t("明确表达的长期习惯和个人偏好选择可能自动保存；任务或服务器的临时选择仍只留在对话上下文中。")}</p>
      <input value={title} onChange={(event) => setTitle(event.target.value)} maxLength={120} aria-label={t("记忆标题")}
        placeholder={t("记忆标题（留空时自动生成）")} className="w-full rounded-lg border border-line bg-surface-2 px-3 py-2 text-13 text-fg outline-none focus:border-accent" />
      <textarea ref={editorRef} value={text} onChange={(event) => setText(event.target.value)} maxLength={800} rows={3} placeholder={t("例如：部署前先检查站点目录")} className="w-full resize-y rounded-lg border border-line bg-surface-2 px-3 py-2 text-13 text-fg outline-none focus:border-accent" />
      <div className="flex justify-end gap-2">
        {editing && <Button size="sm" variant="ghost" onClick={() => { setEditing(null); setTitle(""); setText(""); }}>{t("取消")}</Button>}
        <Button size="sm" disabled={!text.trim() || busy} onClick={() => void save()}>{editing ? t("保存修改") : t("添加记忆")}</Button>
      </div>
      {error && <p role="alert" className="break-words text-12 text-danger">{error}</p>}
      {items.length > 0 && <div className="flex justify-between items-center gap-2"><span className="text-12 text-fg-muted">{t("已保存 {{count}} 条", { count: items.length })}</span><Button size="xs" variant="ghost" onClick={() => { setError(""); setClearAll(true); }}>{t("清空长期记忆")}</Button></div>}
      <div className="max-h-80 space-y-2 overflow-y-auto">
        {items.length === 0 && <p className="text-12 text-fg-subtle">{t("暂无长期记忆")}</p>}
        {items.map((item) => <details key={item.id} className="group rounded-xl border border-line/60 bg-surface-2">
          <summary className="flex cursor-pointer list-none items-center gap-2 rounded-xl px-4 py-3 text-13 font-medium text-fg hover:bg-surface-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent [&::-webkit-details-marker]:hidden">
            <ChevronRight size={14} className="shrink-0 text-fg-subtle transition-transform group-open:rotate-90" />
            <span className="min-w-0 flex-1 truncate">{item.title?.trim() || item.content.trim().split(/\n|[。！？]/)[0].slice(0, 80) || t("记忆")}</span>
            {item.scope !== "global" && <span className="shrink-0 text-11 text-fg-subtle">{t("旧记录")}</span>}
          </summary>
          <div className="space-y-3 px-4 pb-3 pt-1">
          <p className="whitespace-pre-wrap break-words text-13 leading-6 text-fg-muted">{item.content}</p>
          <div className="flex flex-wrap items-center gap-2 text-11 text-fg-subtle">
            <span>{item.scope === "global" ? t("全局记忆") : t("旧记录：未自动使用，编辑保存后转为全局")}</span>
            <span>{item.source === "user-choice" ? t("来自用户选择") : item.source.startsWith("observed:") ? t("服务器实测，7 天后不自动引用") : t("用户保存")} · {new Date(item.updatedAt).toLocaleString()}</span>
            {item.source.startsWith("observed:") && <span title={item.source}>{t("来源记录")} · {item.source.slice(9)}</span>}
            <span className="ml-auto" />
            <Button size="xs" variant="ghost" onClick={() => { setEditing(item); setTitle(item.title ?? ""); setText(item.content); requestAnimationFrame(() => { editorRef.current?.scrollIntoView({ behavior: "smooth", block: "center" }); editorRef.current?.focus({ preventScroll: true }); }); }}>{t("编辑")}</Button>
            <Button size="xs" variant="ghost" onClick={() => { setError(""); setRemove(item); }}>{t("删除")}</Button>
          </div>
          </div>
        </details>)}
      </div>
      <ConfirmDialog open={Boolean(remove)} title={t("删除长期记忆？")} description={t("删除后，后续对话将不再使用这条记忆。已有对话记录不受影响。")}
        danger pending={busy} error={error || undefined} onCancel={() => { setError(""); setRemove(null); }} onConfirm={() => {
          if (!remove || busy) return;
          setBusy(true);
          void opsApi.extremeMemoryDelete(remove.id).then(reload).then(() => setRemove(null)).catch((cause) => setError(String(cause))).finally(() => setBusy(false));
        }} />
      <ConfirmDialog open={clearAll} title={t("清空所有长期记忆？")} description={t("这会删除所有范围的长期记忆，已有对话历史不受影响。")}
        danger pending={busy} error={error || undefined} onCancel={() => { setError(""); setClearAll(false); }} onConfirm={() => {
          if (busy) return;
          setBusy(true);
          void opsApi.extremeMemoryClear().then(reload).then(() => { setClearAll(false); setEditing(null); setTitle(""); setText(""); }).catch((cause) => setError(String(cause))).finally(() => setBusy(false));
        }} />
    </div>
  );
}
