/**
 * Nginx 管家 — site list, config editing, validation and reload (P3-1.4).
 *
 * The safety rule for this page: a config is written, then `nginx -t` runs,
 * and only a clean test triggers a reload. Saving a broken config therefore
 * leaves the site running with its old config instead of taking it offline —
 * and the operator is told exactly why the reload did not happen.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import {
  Check,
  FileCode2,
  Loader2,
  Pencil,
  RefreshCw,
  RotateCw,
  Save,
  ToggleLeft,
  ToggleRight,
  TriangleAlert,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { ContextMenu, useContextMenu } from "@/components/ui/context-menu";
import { cn } from "@/lib/cn";
import { opsApi, toErrorMessage, type NginxSite, type NginxTestResult } from "@/api/ops-api";
import { useCommandSession } from "@/hooks/use-command-session";
import {
  ModuleEmpty,
  ModuleFrame,
  RefreshButton,
  ToolbarStat,
  ToolbarStatus,
} from "@/workbench/views/module-frame";
import type { WorkspaceTab } from "@/workbench/types";

export function NginxManagerView({ tab }: { tab: WorkspaceTab }) {
  const session = useCommandSession(tab);

  const [sites, setSites] = useState<NginxSite[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [editing, setEditing] = useState<NginxSite | null>(null);
  const [pendingToggle, setPendingToggle] = useState<{ site: NginxSite; enable: boolean } | null>(
    null,
  );

  const load = useCallback(async () => {
    if (!session.ready) return;
    setLoading(true);
    setError(null);
    try {
      setSites(await opsApi.nginxSites(session.sessionId));
    } catch (cause) {
      setError(toErrorMessage(cause));
    } finally {
      setLoading(false);
    }
  }, [session.ready, session.sessionId]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const unlisten = listen<string>(`nginx-changed-${session.sessionId}`, () => {
      void load();
    });
    return () => void unlisten.then((fn) => fn());
  }, [load, session.sessionId]);

  const toggleSite = useCallback(
    async (site: NginxSite, enable: boolean) => {
      setBusy(site.name);
      setError(null);
      try {
        await opsApi.nginxSetSiteEnabled(session.sessionId, site.name, enable);
        await load();
      } catch (cause) {
        setError(toErrorMessage(cause));
      } finally {
        setBusy(null);
      }
    },
    [load, session.sessionId],
  );

  /**
   * Reload refuses to run on a config that does not validate: reloading a
   * broken file would take every site offline, so the test gates it.
   */
  const reloadNginx = useCallback(async () => {
    setBusy("reload");
    setError(null);
    try {
      const test = await opsApi.nginxTest(session.sessionId);
      if (!test.success) {
        setError(`配置校验失败，已取消重载：${test.output || "（无输出）"}`);
        return;
      }
      await opsApi.nginxReload(session.sessionId);
    } catch (cause) {
      setError(toErrorMessage(cause));
    } finally {
      setBusy(null);
    }
  }, [session.sessionId]);

  const menu = useContextMenu();
  const siteMenu = (site: NginxSite) =>
    menu.onContextMenu(() => [
      { id: "edit", label: "编辑配置", icon: Pencil, onSelect: () => setEditing(site) },
      { id: "sep1", separator: true },
      site.enabled
        ? {
            id: "disable",
            label: "停用站点",
            icon: ToggleLeft,
            danger: true,
            disabled: busy !== null,
            onSelect: () => setPendingToggle({ site, enable: false }),
          }
        : {
            id: "enable",
            label: "启用站点",
            icon: ToggleRight,
            disabled: busy !== null || site.source === "conf_d",
            onSelect: () => void toggleSite(site, true),
          },
      { id: "copy-path", label: "复制路径", onSelect: () => void navigator.clipboard.writeText(site.path) },
    ]);

  if (editing) {
    return (
      <ConfigEditor
        sessionId={session.sessionId}
        site={editing}
        onClose={() => {
          setEditing(null);
          void load();
        }}
        onError={setError}
      />
    );
  }

  return (
    <ModuleFrame
      tab={tab}
      session={session}
      icon={FileCode2}
      toolbar={
        <>
          <RefreshButton busy={loading} onClick={() => void load()} />
          <div className="mx-1 h-4 w-px bg-line" />
          <Button
            variant="ghost"
            size="xs"
            disabled={busy !== null}
            onClick={() => void reloadNginx()}
          >
            {busy === "reload" ? (
              <Loader2 size={12} className="animate-spin" />
            ) : (
              <RotateCw size={12} />
            )}
            校验并重载
          </Button>
          <ToolbarStatus>
            <ToolbarStat>
              {sites.length > 0
                ? `${sites.filter((site) => site.enabled).length} / ${sites.length} 个站点已启用`
                : ""}
            </ToolbarStat>
          </ToolbarStatus>
        </>
      }
    >
      {error && (
        <div className="mx-3 mt-3 rounded-[8px] border border-danger/30 bg-danger/10 px-3 py-2 text-12 text-danger">
          {error}
        </div>
      )}

      {!loading && !error && sites.length === 0 ? (
        <ModuleEmpty
          icon={FileCode2}
          title="没有找到 Nginx 站点"
          hint="已查找 /etc/nginx/sites-available 与 /etc/nginx/conf.d。若两者都不存在或为空，可能尚未安装 Nginx。"
        />
      ) : (
        <table className="w-full text-11">
          <thead className="sticky top-0 z-10 bg-surface-2 text-fg-subtle">
            <tr>
              <th className="w-[34px] px-3 py-1.5" />
              <th className="px-2 py-1.5 text-left font-semibold">站点</th>
              <th className="px-2 py-1.5 text-left font-semibold">域名</th>
              <th className="w-[92px] px-2 py-1.5 text-left font-semibold">端口</th>
              <th className="w-[128px] px-2 py-1.5 text-left font-semibold">来源</th>
              <th className="px-3 py-1.5 text-left font-semibold">配置文件</th>
            </tr>
          </thead>
          <tbody>
            {sites.map((site) => (
              <tr
                key={`${site.source}-${site.name}`}
                className="cursor-default border-t border-line hover:bg-surface-hover"
                onContextMenu={siteMenu(site)}
                onDoubleClick={() => setEditing(site)}
              >
                <td className="px-3 py-1.5">
                  <span
                    className={cn(
                      "block h-[6px] w-[6px] rounded-full",
                      site.enabled ? "bg-success" : "bg-fg-subtle",
                    )}
                  />
                </td>
                <td className="px-2 py-1.5 font-mono text-fg">
                  {site.name}
                  {site.is_default && (
                    <span className="ml-1.5 rounded-[4px] border border-line px-1 text-10 text-fg-subtle">
                      默认
                    </span>
                  )}
                  {busy === site.name && (
                    <RotateCw size={10} className="ml-1.5 inline animate-spin text-accent" />
                  )}
                </td>
                <td className="max-w-0 truncate px-2 py-1.5 text-fg-muted">
                  {site.server_names.length > 0 ? site.server_names.join(" ") : "—"}
                </td>
                <td className="px-2 py-1.5 font-mono text-fg-muted">
                  {site.listen_ports.length > 0 ? site.listen_ports.join(", ") : "—"}
                </td>
                <td className="px-2 py-1.5 text-fg-subtle">
                  {site.source === "conf_d" ? "conf.d" : "sites-available"}
                </td>
                <td className="max-w-0 truncate px-3 py-1.5 font-mono text-fg-subtle" title={site.path}>
                  {site.path}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <ContextMenu {...menu.props} title={pendingToggle?.site.name} />

      <ConfirmDialog
        open={pendingToggle !== null}
        title={`停用站点 ${pendingToggle?.site.name ?? ""}`}
        description={`确定停用“${pendingToggle?.site.name ?? ""}”？将移除 sites-enabled 中的软链接，站点会立即停止对外服务。`}
        confirmLabel="停用"
        danger
        onConfirm={() => {
          if (pendingToggle) void toggleSite(pendingToggle.site, pendingToggle.enable);
          setPendingToggle(null);
        }}
        onCancel={() => setPendingToggle(null)}
      />
    </ModuleFrame>
  );
}

/**
 * Config editor with a mandatory test before reload.
 *
 * Saving runs `nginx -t` and reports its output; the reload only happens when
 * that test passes. The pre-edit copy is kept at `<path>.blsops.bak` and the
 * path is shown, so a mistake is recoverable.
 */
function ConfigEditor({
  sessionId,
  site,
  onClose,
  onError,
}: {
  sessionId: string;
  site: NginxSite;
  onClose: () => void;
  onError: (message: string | null) => void;
}) {
  const [content, setContent] = useState<string | null>(null);
  const [original, setOriginal] = useState("");
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState<NginxTestResult | null>(null);
  const [reloaded, setReloaded] = useState(false);
  const [backupPath, setBackupPath] = useState<string | null>(null);
  const [error, setErrorLocal] = useState<string | null>(null);
  const loadedRef = useRef(false);

  useEffect(() => {
    if (loadedRef.current) return;
    loadedRef.current = true;
    void opsApi
      .nginxConfig(sessionId, site.path)
      .then((text) => {
        setContent(text);
        setOriginal(text);
      })
      .catch((cause) => setErrorLocal(toErrorMessage(cause)));
  }, [sessionId, site.path]);

  const dirty = content !== null && content !== original;

  const save = async () => {
    if (content === null) return;
    setSaving(true);
    setErrorLocal(null);
    setResult(null);
    setReloaded(false);
    try {
      const outcome = await opsApi.nginxSaveConfig(sessionId, site.path, content);
      setResult(outcome.test);
      setReloaded(outcome.reloaded);
      setBackupPath(outcome.backup_path);
      if (outcome.test.success) setOriginal(content);
      onError(null);
    } catch (cause) {
      const message = toErrorMessage(cause);
      setErrorLocal(message);
      onError(message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col bg-app">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-line bg-surface-1 px-3">
        <FileCode2 size={13} className="shrink-0 text-fg-subtle" />
        <span className="text-12 font-semibold text-fg">{site.name}</span>
        <span className="truncate font-mono text-11 text-fg-subtle">{site.path}</span>
        {dirty && <span className="shrink-0 text-11 text-warning">未保存</span>}
        <div className="ml-auto flex shrink-0 items-center gap-1">
          <Button
            variant="ghost"
            size="xs"
            disabled={saving || !dirty}
            onClick={() => void save()}
          >
            {saving ? <Loader2 size={12} className="animate-spin" /> : <Save size={12} />}
            保存并校验
          </Button>
          <Button variant="ghost" size="xs" onClick={onClose}>
            返回列表
          </Button>
        </div>
      </div>

      {error && (
        <div className="flex shrink-0 items-center gap-2 border-b border-danger/30 bg-danger/10 px-3 py-2 text-12 text-danger">
          <TriangleAlert size={13} className="shrink-0" />
          <span className="min-w-0 flex-1">{error}</span>
        </div>
      )}

      {result && (
        <div
          className={cn(
            "flex shrink-0 items-start gap-2 border-b px-3 py-2 text-11",
            result.success
              ? "border-success/30 bg-success/10 text-success"
              : "border-danger/30 bg-danger/10 text-danger",
          )}
        >
          {result.success ? (
            <Check size={13} className="mt-0.5 shrink-0" />
          ) : (
            <TriangleAlert size={13} className="mt-0.5 shrink-0" />
          )}
          <div className="min-w-0 flex-1">
            <p>
              {result.success
                ? reloaded
                  ? "配置校验通过，Nginx 已重载。"
                  : "配置校验通过，但重载未执行。"
                : "配置校验失败，Nginx 未重载（站点继续使用旧配置）。"}
            </p>
            {result.output && (
              <pre className="mt-1 overflow-x-auto whitespace-pre-wrap font-mono text-10 opacity-80">
                {result.output}
              </pre>
            )}
            {backupPath && (
              <p className="mt-1 text-fg-subtle">修改前的备份：{backupPath}</p>
            )}
          </div>
          {result.success && !reloaded && (
            <Button
              variant="ghost"
              size="xs"
              onClick={() => {
                void opsApi.nginxReload(sessionId).then(() => setReloaded(true));
              }}
            >
              <RefreshCw size={11} />
              手动重载
            </Button>
          )}
        </div>
      )}

      <textarea
        value={content ?? ""}
        onChange={(event) => setContent(event.target.value)}
        spellCheck={false}
        className="min-h-0 flex-1 resize-none bg-app p-3 font-mono text-12 leading-relaxed text-fg outline-none"
        placeholder="读取配置中…"
      />
    </div>
  );
}
