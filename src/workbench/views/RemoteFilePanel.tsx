import { Suspense, lazy, useCallback, useEffect, useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  ClipboardCopy,
  CornerDownLeft,
  Copy,
  FilePlus2,
  FolderPlus,
  Loader2,
  Pause,
  Pencil,
  RefreshCw,
  Trash2,
  Upload,
} from "lucide-react";
import { ContextMenu, type ContextMenuState, contextMenuStateAt } from "@/components/ui/context-menu";
import { Button } from "@/components/ui/button";
import { ErrorText, Field, Modal, fieldClass } from "@/components/ui/modal";
import { opsApi, toErrorMessage, type RemoteFileEntry } from "@/api/ops-api";
import { fileKind, isEditableKind } from "@/lib/file-kind";
import { useSubmit } from "@/hooks/use-submit";
import { cn } from "@/lib/cn";

const DEFAULT_WIDTH = 320;
const MIN_WIDTH = 240;
const MAX_WIDTH = 560;

/**
 * The editor (and its CodeMirror dependency tree) is code-split: it loads the
 * first time a text file is actually opened, never on app start.
 */
const FileEditorModal = lazy(() => import("@/workbench/views/FileEditorModal"));

/** Pure POSIX path ops — remote paths never follow the local OS's rules. */
export function parentOf(path: string): string {
  const cut = path.lastIndexOf("/");
  if (cut <= 0) return "/";
  return path.slice(0, cut);
}

/** Lexically joins + resolves `.` / `..` (used for `cd` following). */
function joinPath(base: string, target: string): string {
  const raw = target.startsWith("/") ? target : `${base}/${target}`;
  const parts: string[] = [];
  for (const component of raw.split("/")) {
    if (component === "" || component === ".") continue;
    if (component === "..") parts.pop();
    else parts.push(component);
  }
  return parts.length === 0 ? "/" : `/${parts.join("/")}`;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = "B";
  for (const next of units) {
    if (value < 1024) break;
    value /= 1024;
    unit = next;
  }
  return `${value >= 100 ? Math.round(value) : value.toFixed(1)} ${unit}`;
}

function formatTime(seconds?: number | null): string {
  if (!seconds) return "—";
  return new Date(seconds * 1000).toLocaleString(undefined, {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

type PanelStatus =
  | { state: "idle" }
  | { state: "loading" }
  | { state: "ready" }
  | { state: "empty" }
  | { state: "error"; message: string }
  | { state: "disconnected" };

export interface FilePanelFollow {
  nonce: number;
  /** Raw argument of the `cd` command: "", "~", "-", "..", "/x", "dir". */
  arg: string;
}

interface RemoteFilePanelProps {
  sessionId: string;
  connected: boolean;
  /** Shell-to-panel sync: bumps whenever the user types `cd …`. */
  follow: FilePanelFollow;
  onClose: () => void;
}

/** Name prompt for the create/rename dialogs (replaces window.prompt). */
type NameDialog = {
  title: string;
  label: string;
  initial: string;
  submitLabel: string;
  /** Validates the typed name; returns an error message or null. */
  validate: (name: string) => string | null;
  onConfirm: (name: string) => Promise<unknown>;
};

/** The in-app editor target, when open. */
type EditorTarget = { path: string; name: string; language?: ReturnType<typeof fileKind>["language"] };

/**
 * Remote file browser for one SSH session.
 *
 * Data comes exclusively from the SFTP subsystem of this session's connection —
 * never from shell commands, never from mock data. The panel is keyed by
 * session id, so tabs never see each other's directory state.
 *
 * Operations: browse, rename, copy, delete (recursive), mkdir, create file,
 * drag & drop upload into the current directory, and double-click editing of
 * text/code files (SQL, conf, JS, Java, …) with syntax highlighting.
 */
export function RemoteFilePanel({ sessionId, connected, follow, onClose }: RemoteFilePanelProps) {
  const [width, setWidth] = useState(DEFAULT_WIDTH);
  /** Canonical navigation history: back/forward + current location. */
  const [nav, setNav] = useState<{ stack: string[]; index: number }>({ stack: [], index: -1 });
  const [home, setHome] = useState<string | null>(null);
  const [entries, setEntries] = useState<RemoteFileEntry[]>([]);
  const [status, setStatus] = useState<PanelStatus>({ state: "idle" });
  const [selected, setSelected] = useState<string | null>(null);
  const [menu, setMenu] = useState<ContextMenuState | null>(null);
  const [nameDialog, setNameDialog] = useState<NameDialog | null>(null);
  const [editor, setEditor] = useState<EditorTarget | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [uploads, setUploads] = useState<{ total: number; done: number } | null>(null);
  const [uploadNotice, setUploadNotice] = useState<string | null>(null);

  const cwd = nav.index >= 0 && nav.index < nav.stack.length ? nav.stack[nav.index] : null;
  const selectedEntry = entries.find((entry) => entry.path === selected) ?? null;

  const load = useCallback(
    async (path: string) => {
      setStatus({ state: "loading" });
      setSelected(null);
      try {
        const result = await opsApi.sftpListDir(sessionId, path);
        setEntries(result.entries);
        setStatus(result.entries.length === 0 ? { state: "empty" } : { state: "ready" });
        // Reconcile with the canonical path the server actually resolved.
        setNav((current) => {
          if (current.stack[current.index] === result.path) return current;
          return {
            stack: [...current.stack.slice(0, current.index + 1), result.path],
            index: current.index + 1,
          };
        });
      } catch (cause) {
        setStatus({ state: "error", message: toErrorMessage(cause) });
      }
    },
    [sessionId],
  );

  // Open SFTP and land in the home directory when the session comes up.
  useEffect(() => {
    if (!connected) {
      setStatus({ state: "disconnected" });
      setEntries([]);
      setNav({ stack: [], index: -1 });
      return;
    }
    let cancelled = false;
    (async () => {
      setStatus({ state: "loading" });
      try {
        const homePath = await opsApi.sftpOpen(sessionId);
        if (cancelled) return;
        setHome(homePath);
        setNav({ stack: [homePath], index: 0 });
        const result = await opsApi.sftpListDir(sessionId, homePath);
        if (cancelled) return;
        setEntries(result.entries);
        setStatus(result.entries.length === 0 ? { state: "empty" } : { state: "ready" });
      } catch (cause) {
        if (!cancelled) setStatus({ state: "error", message: toErrorMessage(cause) });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [connected, sessionId]);

  // Follow `cd` typed in the terminal. Nonce 0 is the initial state, not a
  // command — reacting to it would reload the home listing a second time.
  const followNonce = follow.nonce;
  useEffect(() => {
    if (followNonce === 0) return;
    const arg = follow.arg.trim();
    if (!cwd) return;

    let target: string | null = null;
    if (arg === "" || arg === "~") {
      target = home ?? cwd; // bare `cd` goes home; keep cwd if home is unknown
    } else if (arg === "-") {
      target = nav.index > 0 ? nav.stack[nav.index - 1] : cwd;
    } else if (arg === "..") {
      target = parentOf(cwd);
    } else {
      const expanded = arg.startsWith("~")
        ? joinPath(home ?? cwd, arg.slice(1).replace(/^\/+/, "") || ".")
        : arg;
      target = joinPath(cwd, expanded);
    }
    if (target) void load(target);
    // `cwd`/`nav` intentionally excluded: respond to each nonce exactly once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [followNonce]);

  const navigate = useCallback(
    (path: string) => {
      setNav((current) => ({
        stack: [...current.stack.slice(0, current.index + 1), path],
        index: current.index + 1,
      }));
      void load(path);
    },
    [load],
  );

  const goBack = () => {
    if (nav.index <= 0) return;
    const target = nav.stack[nav.index - 1];
    setNav((current) => ({ ...current, index: current.index - 1 }));
    void load(target);
  };

  const goForward = () => {
    if (nav.index >= nav.stack.length - 1) return;
    const target = nav.stack[nav.index + 1];
    setNav((current) => ({ ...current, index: current.index + 1 }));
    void load(target);
  };

  const goUp = () => {
    if (!cwd) return;
    navigate(parentOf(cwd));
  };

  const refresh = () => {
    if (cwd) void load(cwd);
  };

  const openEntry = useCallback(
    (entry: RemoteFileEntry) => {
      if (entry.kind === "directory") {
        navigate(entry.path);
        return;
      }
      // Text/code files open in the editor; other types explain themselves.
      if (isEditableKind(entry.name)) {
        setEditor({ path: entry.path, name: entry.name, language: fileKind(entry.name).language });
        return;
      }
      setNotice(`“${entry.name}”是${fileKind(entry.name).label}，暂不支持在应用内打开。`);
    },
    [navigate],
  );

  // Non-blocking notice (used for unsupported types) — auto-dismisses.
  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(null), 4000);
    return () => window.clearTimeout(timer);
  }, [notice]);

  // -- file operations -------------------------------------------------------

  const runAndRefresh = useCallback(
    (action: () => Promise<unknown>) => {
      void action()
        .then(() => {
          if (cwd) return load(cwd);
          return undefined;
        })
        .catch((cause) => setStatus({ state: "error", message: toErrorMessage(cause) }));
    },
    [cwd, load],
  );

  const [deleteTarget, setDeleteTarget] = useState<RemoteFileEntry | null>(null);

  const removeEntry = (entry: RemoteFileEntry) => {
    setDeleteTarget(entry);
  };

  const confirmRemove = () => {
    if (!deleteTarget) return;
    const target = deleteTarget;
    setDeleteTarget(null);
    runAndRefresh(() => opsApi.sftpRemove(sessionId, target.path));
  };

  const renameEntry = (entry: RemoteFileEntry) => {
    setNameDialog({
      title: "重命名",
      label: "新名称",
      initial: entry.name,
      submitLabel: "重命名",
      validate: validateName,
      onConfirm: (name) => opsApi.sftpRename(sessionId, entry.path, name),
    });
  };

  const copyEntry = (entry: RemoteFileEntry) => {
    const dot = entry.name.lastIndexOf(".");
    const suggested =
      dot > 0 ? `${entry.name.slice(0, dot)} - 副本${entry.name.slice(dot)}` : `${entry.name} - 副本`;
    setNameDialog({
      title: "创建副本",
      label: "副本名称",
      initial: suggested,
      submitLabel: "创建副本",
      validate: validateName,
      onConfirm: (name) => opsApi.sftpCopy(sessionId, entry.path, name),
    });
  };

  const createFolder = () => {
    if (!cwd) return;
    setNameDialog({
      title: "新建文件夹",
      label: "文件夹名称",
      initial: "新建文件夹",
      submitLabel: "创建",
      validate: validateName,
      onConfirm: (name) => opsApi.sftpMkdir(sessionId, `${cwd === "/" ? "" : cwd}/${name}`),
    });
  };

  const createFile = () => {
    if (!cwd) return;
    setNameDialog({
      title: "新建文件",
      label: "文件名称",
      initial: "新建文件.txt",
      submitLabel: "创建",
      validate: validateName,
      onConfirm: (name) => opsApi.sftpTouch(sessionId, `${cwd === "/" ? "" : cwd}/${name}`),
    });
  };

  const uploadFiles = useCallback(
    async (paths: string[]) => {
      if (!cwd || paths.length === 0) return;
      setUploadNotice(null);
      setUploads({ total: paths.length, done: 0 });
      try {
        await opsApi.sftpUpload(sessionId, paths, cwd);
        await load(cwd);
        setUploadNotice(paths.length === 1 ? "文件上传完成" : `${paths.length} 个文件上传完成`);
      } catch (cause) {
        setStatus({ state: "error", message: toErrorMessage(cause) });
      } finally {
        setUploads(null);
      }
    },
    [cwd, load, sessionId],
  );

  useEffect(() => {
    if (!uploadNotice) return;
    const timer = window.setTimeout(() => setUploadNotice(null), 4500);
    return () => window.clearTimeout(timer);
  }, [uploadNotice]);

  // Drag & drop from the local machine. Tauri intercepts the OS drop and hands
  // over absolute paths; DOM drop events would only give opaque File objects.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    void import("@tauri-apps/api/webview").then(({ getCurrentWebview }) =>
      getCurrentWebview()
        .onDragDropEvent((event) => {
          if (cancelled) return;
          const payload = event.payload;
          if (payload.type === "enter") {
            if (payload.paths.length > 0) setDragging(true);
          } else if (payload.type === "over") {
            setDragging(true);
          } else if (payload.type === "leave") {
            setDragging(false);
          } else if (payload.type === "drop") {
            setDragging(false);
            void uploadFiles(payload.paths);
          }
        })
        .then((fn) => {
          if (cancelled) fn();
          else unlisten = fn;
        }),
    );
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [uploadFiles]);

  // -- interactions ----------------------------------------------------------

  const startDrag = (event: React.PointerEvent) => {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = width;
    const onMove = (move: PointerEvent) => {
      const next = startWidth - (move.clientX - startX);
      setWidth(Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, next)));
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === "Backspace") {
      event.preventDefault();
      goUp();
      return;
    }
    if (event.key === "Enter" && selectedEntry) {
      event.preventDefault();
      openEntry(selectedEntry);
    }
    if (event.key === "F2" && selectedEntry) {
      event.preventDefault();
      renameEntry(selectedEntry);
    }
    if (event.key === "Delete" && selectedEntry) {
      event.preventDefault();
      removeEntry(selectedEntry);
    }
  };

  const openEntryMenu = (event: React.MouseEvent, entry: RemoteFileEntry) => {
    event.preventDefault();
    setSelected(entry.path);
    setMenu(
      contextMenuStateAt(event, [
        { id: "open", label: "打开", onSelect: () => openEntry(entry) },
        { id: "sep1", separator: true },
        { id: "rename", label: "重命名", icon: Pencil, onSelect: () => renameEntry(entry) },
        { id: "copy-entry", label: "创建副本", icon: Copy, onSelect: () => copyEntry(entry) },
        {
          id: "copy-path",
          label: "复制路径",
          icon: ClipboardCopy,
          onSelect: () => void navigator.clipboard.writeText(entry.path),
        },
        { id: "sep2", separator: true },
        { id: "delete", label: "删除", icon: Trash2, danger: true, onSelect: () => removeEntry(entry) },
      ]),
    );
  };

  const openBackgroundMenu = (event: React.MouseEvent) => {
    event.preventDefault();
    setMenu(
      contextMenuStateAt(event, [
        { id: "mkdir", label: "新建文件夹", icon: FolderPlus, onSelect: createFolder },
        { id: "touch", label: "新建文件", icon: FilePlus2, onSelect: createFile },
        { id: "sep", separator: true },
        { id: "refresh", label: "刷新", icon: RefreshCw, onSelect: refresh },
      ]),
    );
  };

  // Breadcrumb segments for the current path.
  const crumbs: { label: string; path: string }[] = [];
  if (cwd) {
    crumbs.push({ label: "/", path: "/" });
    let accumulated = "";
    for (const segment of cwd.split("/").filter(Boolean)) {
      accumulated += `/${segment}`;
      crumbs.push({ label: segment, path: accumulated });
    }
  }

  return (
    <aside
      className="relative flex h-full min-h-0 shrink-0 flex-col border-l border-line bg-surface-1"
      style={{ width }}
      aria-label="远程文件"
    >
      {/* Drag handle */}
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="拖动调整宽度"
        className="absolute inset-y-0 left-0 z-10 w-1 cursor-col-resize hover:bg-accent/40"
        onPointerDown={startDrag}
      />

      <div className="flex h-8 shrink-0 items-center gap-0.5 border-b border-line px-1.5">
        <PanelButton label="后退" icon={ArrowLeft} disabled={nav.index <= 0} onClick={goBack} />
        <PanelButton
          label="前进"
          icon={ArrowRight}
          disabled={nav.index >= nav.stack.length - 1}
          onClick={goForward}
        />
        <PanelButton label="上一级" icon={ArrowUp} disabled={!cwd || cwd === "/"} onClick={goUp} />
        <PanelButton label="刷新" icon={RefreshCw} disabled={!cwd} onClick={refresh} />
        <PanelButton label="新建文件夹" icon={FolderPlus} disabled={!cwd} onClick={createFolder} />
        <PanelButton label="新建文件" icon={FilePlus2} disabled={!cwd} onClick={createFile} />
        <PanelButton label="折叠面板" icon={Pause} onClick={onClose} />
      </div>

      <div className="flex h-7 shrink-0 items-center gap-1 border-b border-line px-2 text-11">
        <div className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto">
          {cwd ? (
            crumbs.map((crumb, index) => (
              <span key={crumb.path} className="flex shrink-0 items-center gap-0.5">
                {index > 0 && <span className="text-fg-subtle">/</span>}
                <button
                  type="button"
                  className={cn(
                    "truncate rounded px-1 hover:bg-surface-hover hover:text-fg",
                    index === crumbs.length - 1 ? "font-semibold text-fg" : "text-fg-muted",
                  )}
                  onClick={() => navigate(crumb.path)}
                >
                  {crumb.label}
                </button>
              </span>
            ))
          ) : (
            <span className="text-fg-subtle">未连接</span>
          )}
        </div>

        {/* Selected-row actions live in this row (not as an inserted strip) so
            clicking a file never shifts the list below. */}
        {selectedEntry && (
          <div className="flex shrink-0 items-center gap-0.5">
            <span className="max-w-[120px] truncate text-fg-subtle" title={selectedEntry.path}>
              {selectedEntry.name}
            </span>
            <PanelButton label="打开" icon={CornerDownLeft} onClick={() => openEntry(selectedEntry)} />
            <PanelButton label="重命名" icon={Pencil} onClick={() => renameEntry(selectedEntry)} />
            <PanelButton label="创建副本" icon={Copy} onClick={() => copyEntry(selectedEntry)} />
            <PanelButton
              label="删除"
              icon={Trash2}
              onClick={() => removeEntry(selectedEntry)}
              className="hover:text-danger"
            />
          </div>
        )}
      </div>

      <div
        tabIndex={0}
        className={cn(
          "min-h-0 flex-1 overflow-y-auto outline-none",
          dragging && "ring-2 ring-inset ring-accent/60 bg-accent/5",
        )}
        onKeyDown={onKeyDown}
        onContextMenu={openBackgroundMenu}
        onClick={(event) => {
          // Clicking empty space clears the selection (rows stop propagation).
          if (event.target === event.currentTarget) setSelected(null);
        }}
      >
        {dragging && (
          <div className="pointer-events-none absolute inset-2 z-20 flex items-center justify-center rounded-[12px] border-2 border-dashed border-accent bg-accent/10 backdrop-blur-sm">
            <div className="flex flex-col items-center gap-2 rounded-[10px] bg-surface-1/90 px-5 py-4 text-11 text-accent shadow-lg">
              <Upload size={20} />
              <span className="font-medium">松开以上传到当前目录</span>
              <span className="text-fg-subtle">支持多个文件</span>
            </div>
          </div>
        )}

        {uploads && (
          <div className="flex items-center gap-2 border-b border-line bg-accent/10 px-3 py-2 text-11 text-fg">
            <Loader2 size={12} className="animate-spin" />
            <span className="min-w-0 flex-1">正在上传 {uploads.total} 个文件…</span>
            <span className="text-fg-subtle">请勿关闭面板</span>
          </div>
        )}

        {uploadNotice && (
          <div className="flex items-center justify-between border-b border-line bg-success/10 px-3 py-2 text-11 text-success">
            <span>{uploadNotice}</span>
            <button type="button" className="text-success/70 hover:text-success" onClick={() => setUploadNotice(null)}>
              关闭
            </button>
          </div>
        )}

        {notice && (
          <div className="border-b border-line bg-surface-2/70 px-3 py-2 text-11 text-fg-muted">{notice}</div>
        )}

        {status.state === "loading" && (
          <div className="flex items-center gap-2 px-3 py-3 text-11 text-fg-subtle">
            <Loader2 size={13} className="animate-spin" />
            正在读取…
          </div>
        )}

        {status.state === "empty" && (
          <p className="px-3 py-3 text-11 text-fg-subtle">此目录为空。可拖入本地文件上传。</p>
        )}

        {status.state === "error" && (
          <div className="flex flex-col gap-1.5 px-3 py-3">
            <p className="text-11 leading-relaxed text-danger">{status.message}</p>
            {cwd && (
              <button
                type="button"
                className="self-start rounded px-1.5 py-0.5 text-11 text-fg-muted hover:bg-surface-hover hover:text-fg"
                onClick={refresh}
              >
                重试
              </button>
            )}
          </div>
        )}

        {status.state === "disconnected" && (
          <div className="flex items-center gap-2 px-3 py-3 text-11 text-fg-subtle">
            <Pause size={13} />
            连接已断开，文件浏览不可用。
          </div>
        )}

        {status.state === "ready" && (
          <div className="divide-y divide-line/50">
            {entries.map((entry) => {
              const isSelected = entry.path === selected;
              return (
                <button
                  key={entry.path}
                  type="button"
                  data-kind={entry.kind}
                  className={cn(
                    "group flex w-full items-center gap-2 px-3 py-1.5 text-left",
                    isSelected ? "bg-accent/15" : "hover:bg-surface-hover/70",
                  )}
                  onClick={() => setSelected(entry.path)}
                  onDoubleClick={() => openEntry(entry)}
                  onContextMenu={(event) => openEntryMenu(event, entry)}
                >
                  <EntryIcon entry={entry} />
                  <span className="min-w-0 flex-1">
                    <span
                      className={cn(
                        "block truncate text-12",
                        entry.kind === "directory" ? "text-fg" : "text-fg-muted",
                      )}
                      title={entry.path}
                    >
                      {entry.name}
                      {entry.kind === "symlink" && <span className="ml-1 text-fg-subtle">→</span>}
                    </span>
                    <span className="block truncate text-10 text-fg-subtle">
                      {entry.kind === "directory" ? "文件夹" : formatSize(entry.size)} ·{" "}
                      {formatTime(entry.modified_at)}
                    </span>
                  </span>
                  {entry.kind === "directory" && (
                    <CornerDownLeft
                      size={11}
                      className="shrink-0 text-fg-subtle opacity-0 group-hover:opacity-100"
                    />
                  )}
                </button>
              );
            })}
          </div>
        )}
      </div>

      <div className="flex h-6 shrink-0 items-center justify-between border-t border-line px-2 text-10 text-fg-subtle">
        <span className="truncate">{cwd ?? "—"}</span>
        <span className="shrink-0">SFTP</span>
      </div>

      {menu && <ContextMenu state={menu} onClose={() => setMenu(null)} />}

      {deleteTarget && (
        <Modal
          open
          width={360}
          title={`删除${deleteTarget.kind === "directory" ? "文件夹" : "文件"}`}
          description={`确定删除“${deleteTarget.name}”？此操作不可撤销。`}
          onClose={() => setDeleteTarget(null)}
          footer={
            <>
              <Button variant="ghost" size="sm" onClick={() => setDeleteTarget(null)}>
                取消
              </Button>
              <Button variant="danger" size="sm" onClick={confirmRemove}>
                确认删除
              </Button>
            </>
          }
        >
          <p className="text-12 text-fg-muted">
            {deleteTarget.kind === "directory" ? "文件夹内的全部内容也会被删除。" : "文件内容将被永久删除。"}
          </p>
        </Modal>
      )}

      {nameDialog && (
        <NamePromptModal
          dialog={nameDialog}
          onClose={() => setNameDialog(null)}
          onSaved={() => {
            setNameDialog(null);
            refresh();
          }}
        />
      )}

      {editor && (
        <Suspense
          fallback={
            <div className="fixed inset-0 z-[140] flex items-center justify-center bg-black/50">
              <Loader2 size={18} className="animate-spin text-fg-subtle" />
            </div>
          }
        >
          <FileEditorModal
            sessionId={sessionId}
            path={editor.path}
            name={editor.name}
            language={editor.language}
            onClose={() => setEditor(null)}
            onSaved={() => {
              if (cwd) void load(cwd);
            }}
          />
        </Suspense>
      )}
    </aside>
  );
}

/** Rejects empty names and anything containing a path separator. */
function validateName(name: string): string | null {
  const trimmed = name.trim();
  if (!trimmed) return "名称不能为空";
  if (trimmed.includes("/")) return "名称不能包含 /";
  if (trimmed === "." || trimmed === "..") return "名称不能是 . 或 ..";
  return null;
}

/**
 * Modal wrapper for NameDialog. `onConfirm` runs on submit; `onSaved` fires
 * only after a successful action (so the panel can refresh), `onClose` on any
 * dismissal.
 */
function NamePromptModal({
  dialog,
  onClose,
  onSaved,
}: {
  dialog: NameDialog;
  onClose: () => void;
  onSaved: () => void;
}) {
  const submit = useSubmit();
  const [value, setValue] = useState(dialog.initial);
  const trimmed = value.trim();
  const validationError = trimmed ? dialog.validate(trimmed) : null;

  const confirm = () =>
    submit.run(async () => {
      await dialog.onConfirm(trimmed);
      onSaved();
    });

  return (
    <Modal
      open
      width={380}
      title={dialog.title}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" size="sm" disabled={submit.pending} onClick={onClose}>
            取消
          </Button>
          <Button
            variant="primary"
            size="sm"
            disabled={submit.pending || !trimmed || Boolean(validationError)}
            onClick={() => void confirm()}
          >
            {submit.pending ? "处理中…" : dialog.submitLabel}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-2.5">
        <Field label={dialog.label}>
          <input
            autoFocus
            className={fieldClass}
            value={value}
            spellCheck={false}
            onChange={(event) => setValue(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !validationError) void confirm();
            }}
          />
        </Field>
        {validationError && <ErrorText>{validationError}</ErrorText>}
        <ErrorText>{submit.error}</ErrorText>
      </div>
    </Modal>
  );
}

function PanelButton({
  label,
  icon: Icon,
  disabled,
  className,
  onClick,
}: {
  label: string;
  icon: React.ElementType;
  disabled?: boolean;
  className?: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "flex h-6 w-6 items-center justify-center rounded-[5px] text-fg-muted hover:bg-surface-hover hover:text-fg",
        disabled && "pointer-events-none opacity-40",
        className,
      )}
    >
      <Icon size={13} strokeWidth={1.75} />
    </button>
  );
}

function EntryIcon({ entry }: { entry: RemoteFileEntry }) {
  if (entry.kind === "directory") {
    return <FolderGlyph />;
  }
  const kind = fileKind(entry.name);
  const Icon = kind.icon;
  return (
    <span title={kind.label} className="shrink-0">
      <Icon size={14} strokeWidth={1.75} className={kind.color} />
    </span>
  );
}

function FolderGlyph() {
  // Colored like the editor icons but distinctly folder-shaped.
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="h-[14px] w-[14px] shrink-0 text-sky-400"
      aria-hidden
    >
      <path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" />
    </svg>
  );
}
