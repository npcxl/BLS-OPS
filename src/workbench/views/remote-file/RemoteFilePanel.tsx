import {
  Suspense,
  lazy,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
} from "react";
import {
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  ClipboardCopy,
  CornerDownLeft,
  Copy,
  Download,
  Eye,
  FilePlus2,
  FolderPlus,
  Loader2,
  Pause,
  Pencil,
  RefreshCw,
  Trash2,
  Upload,
} from "lucide-react";
import { ContextMenu, useContextMenu } from "@/components/ui/context-menu";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { opsApi, toErrorMessage, type RemoteFileEntry } from "@/api/ops-api";
import { fileKind, isEditableKind } from "@/lib/file-kind";
import { formatSize } from "@/lib/format";
import { cn } from "@/lib/cn";
import type { PreviewTarget } from "@/workbench/views/preview/FilePreviewModal";
import { useDirSizeStore } from "@/stores/dir-size-store";
import { FileRow } from "./FileRow";
import { NamePromptModal } from "./NamePromptModal";
import { PanelButton } from "./PanelButton";
import {
  useAutoDismiss,
  useDirSizeQueue,
  useDirSizeWatchdog,
  useTransientNotice,
} from "./use-dir-size-queue";
import {
  joinPath,
  parentOf,
  validateName,
  type EditorTarget,
  type NameDialog,
  type PanelStatus,
} from "./utils";

const DEFAULT_WIDTH = 320;
const MIN_WIDTH = 240;
const MAX_WIDTH = 560;

/**
 * The editor (and its CodeMirror dependency tree) is code-split: it loads the
 * first time a text file is actually opened, never on app start.
 */
const FileEditorModal = lazy(() => import("@/workbench/views/FileEditorModal"));

/**
 * The universal preview (and its parsers) is code-split too: opening a text
 * file must not pull in the PDF renderer, and vice versa.
 */
const FilePreviewModal = lazy(() => import("@/workbench/views/preview/FilePreviewModal"));

export interface RemoteFilePanelProps {
  /** Owning SSH session. Each session opens its own SFTP client. */
  sessionId: string;
  connected: boolean;
  /**
   * Terminal follow state: bumped on every `cd` typed in the paired terminal.
   * The panel resolves the raw argument against its own cwd.
   */
  follow: { nonce: number; arg: string };
  /**
   * 挂载时直接落地的路径（P3 项目发现的"查看项目文件"）。与 `reveal` 的区别：
   * 这是**首次打开**的位置，放在这里才不会和"打开 home 目录"的初始化逻辑
   * 抢着写导航栈（两者都是异步的，谁后完成谁生效）。
   */
  initialPath?: string;
  /**
   * 后续跳转请求：`path` 可以是目录也可以是文件。目录直接打开；文件则打开
   * 其所在目录并**选中**它，让"查看 docker-compose.yml / nginx.conf"这类
   * 入口一步到位。`nonce` 变化即触发（同一个路径可能被重复请求）。
   */
  reveal?: { nonce: number; path: string };
  onClose: () => void;
}

/**
 * Remote file panel backed by SFTP.
 *
 * Directory listing and navigation, drag & drop and picker uploads, delete /
 * rename / copy / new folder / new file, on-demand directory sizes (via the
 * `dirsize` module, because SFTP cannot report folder content sizes), and
 * double-click editing of text/code files (SQL, conf, JS, Java, …) with
 * syntax highlighting.
 */
export function RemoteFilePanel({
  sessionId,
  connected,
  follow,
  initialPath,
  reveal,
  onClose,
}: RemoteFilePanelProps) {
  const [width, setWidth] = useState(DEFAULT_WIDTH);
  /** Canonical navigation history: back/forward + current location. */
  const [nav, setNav] = useState<{ stack: string[]; index: number }>({ stack: [], index: -1 });
  const [home, setHome] = useState<string | null>(null);
  const [entries, setEntries] = useState<RemoteFileEntry[]>([]);
  const [status, setStatus] = useState<PanelStatus>({ state: "idle" });
  const [selected, setSelected] = useState<string | null>(null);
  const menu = useContextMenu();
  const [nameDialog, setNameDialog] = useState<NameDialog | null>(null);
  const [editor, setEditor] = useState<EditorTarget | null>(null);
  const [preview, setPreview] = useState<PreviewTarget | null>(null);
  // Non-blocking notice (used for unsupported types) — auto-dismisses after 4s.
  const [notice, setNotice] = useTransientNotice();
  const [dragging, setDraggingState] = useState(false);
  const [uploads, setUploads] = useState<{ total: number; done: number } | null>(null);
  const [uploadNotice, setUploadNotice] = useState<string | null>(null);

  /**
   * `over` fires on every mouse move while dragging. Writing the highlight
   * through a ref keeps that from turning into a setState — and a full
   * re-render of the file list — dozens of times per second.
   */
  const draggingRef = useRef(false);
  const setDragging = useCallback((next: boolean) => {
    if (draggingRef.current === next) return;
    draggingRef.current = next;
    setDraggingState(next);
  }, []);

  const cwd = nav.index >= 0 && nav.index < nav.stack.length ? nav.stack[nav.index] : null;
  const selectedEntry = entries.find((entry) => entry.path === selected) ?? null;

  /**
   * 当选中文件且文件名很长时，隐藏左侧路径面包屑，避免面包屑与文件名、操作
   * 按钮互相挤压。判定依据是文件名自身的渲染宽度（`scrollWidth`，不受 `max-w`
   * 截断影响），超过阈值即视为"很长"。面板宽度变化（拖动分隔条）时重新评估，
   * 用 `useLayoutEffect` 在绘制前定夺，避免先显示再跳变。
   */
  const [hideCrumbs, setHideCrumbs] = useState(false);
  const selectedNameRef = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    if (!selectedEntry) {
      setHideCrumbs(false);
      return;
    }
    const el = selectedNameRef.current;
    if (!el) return;
    setHideCrumbs(el.scrollWidth > 150);
  }, [selectedEntry, width]);

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

  /**
   * 跳到指定路径：目录直接打开；文件则打开它所在的目录并**选中**，
   * 让"查看 docker-compose.yml / nginx.conf"这类入口一步到位。
   * 路径不存在或无权限时退到父目录，把错误留给 `load` 如实呈现。
   */
  const revealInto = useCallback(
    async (target: string, cancelled: boolean) => {
      try {
        const entry = await opsApi.sftpStat(sessionId, target);
        if (cancelled) return;
        if (entry.kind === "directory") {
          await load(target);
          if (!cancelled) setSelected(null);
        } else {
          await load(parentOf(target));
          if (!cancelled) setSelected(target);
        }
      } catch {
        const parent = parentOf(target);
        if (parent !== target) await load(parent);
      }
    },
    [load, sessionId],
  );

  // Open SFTP and land in the home directory when the session comes up —
  // unless the caller asked for a specific starting point (`initialPath`), in
  // which case we go straight there. Doing this in one effect (rather than
  // racing a separate "jump" effect) is what keeps the two async listings from
  // overwriting each other's navigation stack.
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

        const target = initialPath?.trim();
        if (target) {
          await revealInto(target, cancelled);
          return;
        }

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
    // `initialPath` 只在挂载时生效（后续跳转走 `reveal`），故意不入依赖。
    // eslint-disable-next-line react-hooks/exhaustive-deps
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

  // Subsequent jump requests from another view (项目发现的"查看 Docker 配置"/
  // "查看 Nginx 配置")。挂载时的首次落地由 `initialPath` 负责。
  const revealNonce = reveal?.nonce ?? 0;
  const revealPath = reveal?.path;
  useEffect(() => {
    if (revealNonce === 0 || !revealPath || !connected) return;
    // 首次落地已由 `initialPath` 在挂载时完成，不重复加载同一路径。
    if (revealNonce === 1 && initialPath === revealPath) return;
    void revealInto(revealPath, false);
    // `revealInto`/`connected` 有意不入依赖：每个 nonce 只响应一次。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [revealNonce, revealPath]);

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
      // Text/code files open straight in the editor — editing is the useful
      // action there. Everything else goes to the preview, which renders what
      // it can and explains what it cannot.
      if (isEditableKind(entry.name)) {
        setEditor({ path: entry.path, name: entry.name, language: fileKind(entry.name).language });
        return;
      }
      setPreview({ path: entry.path, name: entry.name, size: entry.size });
    },
    [navigate],
  );

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

  /**
   * Saves a remote file to a local path picked in the native save dialog.
   * Streaming happens in the backend, so a multi-GB file never lands in the
   * WebView's memory.
   */
  const downloadEntry = async (entry: RemoteFileEntry) => {
    try {
      const { save } = await import("@tauri-apps/plugin-dialog");
      const destination = await save({ title: `下载 ${entry.name}`, defaultPath: entry.name });
      if (!destination) return;
      const written = await opsApi.sftpDownloadFile(sessionId, entry.path, destination);
      setNotice(`已下载“${entry.name}”（${formatSize(written)}）`);
    } catch (cause) {
      setStatus({ state: "error", message: toErrorMessage(cause) });
    }
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

  // The drag listener is registered once, so it calls through this ref rather
  // than closing over a directory that is about to change.
  const uploadRef = useRef(uploadFiles);
  uploadRef.current = uploadFiles;

  /** The panel element, used to hit-test OS drag events. */
  const panelRef = useRef<HTMLElement>(null);

  // Directory-size queue (max 2 concurrent) — logic lives in the hook.
  // 错误回调必须引用稳定：useDirSizeQueue 的监听器注册 effect 依赖它。
  const handleDirSizeError = useCallback((message: string) => {
    setStatus({ state: "error", message });
  }, []);

  const { computeDirSize, listenerReady } = useDirSizeQueue(sessionId, handleDirSizeError);

  /**
   * 每次列出目录就自动计算列表里每个子文件夹的大小，结果通过
   * `directory-size-update` 事件回填 store，行内直接渲染。
   *
   * - **必须等 `listenerReady`**：监听器未注册完成就启动计算，小目录的
   *   completed 事件会在事件到达前发出并丢失，行永远停在"排队中"。
   * - 后端按 (session, path) 缓存已完成结果：重复进入同一目录只会回放缓存，
   *   不会重复跑 `du`，这里跳过已完成的条目进一步省掉无谓 IPC。
   * - 真正的并发限制在 Rust 端（每会话 2 个），超出的任务报 `pending`，
   *   行内显示"排队中"。
   */
  useEffect(() => {
    if (!connected || !listenerReady) return;
    for (const entry of entries) {
      if (entry.kind !== "directory") continue;
      const cached = useDirSizeStore.getState().get(sessionId, entry.path);
      if (cached?.complete) continue;
      computeDirSize(entry.path);
    }
  }, [connected, listenerReady, entries, sessionId, computeDirSize]);

  // 低频兜底：事件是主通道；3 秒一次、单轮 ≤20 条的批量查询只捞丢失的事件。
  useDirSizeWatchdog({ connected, listenerReady, sessionId, entries });

  // Stale results for this session are cleared when the connection drops.
  useEffect(() => {
    if (!connected) useDirSizeStore.getState().forgetSession(sessionId);
  }, [connected, sessionId]);

  useAutoDismiss(uploadNotice, () => setUploadNotice(null), 4500);

  // Upload from a click: opens the OS file picker, because drag & drop is not
  // discoverable and does not work at all for keyboard-only users. The native
  // dialog returns absolute local paths — exactly what `sftp_upload` wants.
  const [picking, setPicking] = useState(false);
  const pickFilesToUpload = useCallback(async () => {
    if (!cwd || picking) return;
    setPicking(true);
    try {
      const { open: openDialog } = await import("@tauri-apps/plugin-dialog");
      const chosen = await openDialog({
        multiple: true,
        directory: false,
        title: `上传到 ${cwd}`,
      });
      if (!chosen) return; // cancelled
      const paths = Array.isArray(chosen) ? chosen : [chosen];
      if (paths.length === 0) return;
      await uploadFiles(paths);
    } catch (cause) {
      setStatus({ state: "error", message: toErrorMessage(cause) });
    } finally {
      setPicking(false);
    }
  }, [cwd, picking, uploadFiles]);

  // Drag & drop from the local machine. Tauri intercepts the OS drop and hands
  // over absolute paths; DOM drop events would only give opaque File objects.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;

    void (async () => {
      const [{ getCurrentWebview }, { getCurrentWindow }] = await Promise.all([
        import("@tauri-apps/api/webview"),
        import("@tauri-apps/api/window"),
      ]);
      if (cancelled) return;
      // `over` reports physical pixels; the panel is measured in CSS pixels.
      const scale = await getCurrentWindow().scaleFactor();
      if (cancelled) return;

      const el = panelRef.current;
      // The event goes to the whole webview, so hit-test it: dragging over the
      // terminal or another pane must not highlight this panel and must not
      // upload into its directory.
      const hit = (position: { x: number; y: number }) => {
        if (!el) return false;
        const rect = el.getBoundingClientRect();
        const x = position.x / scale;
        const y = position.y / scale;
        return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
      };

      const handler = await getCurrentWebview().onDragDropEvent((event) => {
        if (cancelled) return;
        const payload = event.payload;
        if (payload.type === "enter" || payload.type === "over") {
          setDragging(hit(payload.position));
        } else if (payload.type === "leave") {
          setDragging(false);
        } else if (payload.type === "drop") {
          setDragging(false);
          if (hit(payload.position)) void uploadRef.current(payload.paths);
        }
      });
      if (cancelled) handler();
      else unlisten = handler;
    })();

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [setDragging]);

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

  /**
   * The row currently being right-clicked. The menu factory is created once
   * per render but only reads this at click time, so it stays stable.
   */
  const contextTargetRef = useRef<RemoteFileEntry | null>(null);

  const entryMenu = menu.onContextMenu(() => {
    const entry = contextTargetRef.current;
    if (!entry) return [];
    const isDir = entry.kind === "directory";
    const items: import("@/components/ui/context-menu").ContextMenuItem[] = [
      { id: "open", label: "打开", icon: CornerDownLeft, onSelect: () => openEntry(entry) },
    ];
    if (!isDir) {
      items.push(
        {
          id: "preview",
          label: "预览",
          icon: Eye,
          onSelect: () => setPreview({ path: entry.path, name: entry.name, size: entry.size }),
        },
        {
          id: "download",
          label: "下载到本地…",
          icon: Download,
          onSelect: () => void downloadEntry(entry),
        },
      );
    }
    items.push({ id: "sep1", separator: true });
    return [
      ...items,
      { id: "rename", label: "重命名", icon: Pencil, hint: "F2", onSelect: () => renameEntry(entry) },
      { id: "duplicate", label: "创建副本", icon: Copy, onSelect: () => copyEntry(entry) },
      {
        id: "copy-path",
        label: "复制完整路径",
        icon: ClipboardCopy,
        onSelect: () => void navigator.clipboard.writeText(entry.path),
      },
      {
        id: "copy-name",
        label: "复制文件名",
        icon: ClipboardCopy,
        onSelect: () => void navigator.clipboard.writeText(entry.name),
      },
      { id: "sep2", separator: true },
      {
        id: "delete",
        label: "删除",
        icon: Trash2,
        hint: "Delete",
        danger: true,
        onSelect: () => removeEntry(entry),
      },
    ];
  });

  const backgroundMenu = menu.onContextMenu(() => {
    // No row is the subject of a background menu.
    contextTargetRef.current = null;
    return [
      {
        id: "upload",
        label: "上传文件…",
        icon: Upload,
        disabled: !cwd || picking,
        onSelect: () => void pickFilesToUpload(),
      },
      { id: "sep1", separator: true },
      { id: "mkdir", label: "新建文件夹", icon: FolderPlus, disabled: !cwd, onSelect: createFolder },
      { id: "touch", label: "新建文件", icon: FilePlus2, disabled: !cwd, onSelect: createFile },
      { id: "sep2", separator: true },
      { id: "refresh", label: "刷新", icon: RefreshCw, disabled: !cwd, onSelect: refresh },
    ];
  });

  // Kept in refs so the callbacks handed to memoised rows never change.
  const entryMenuRef = useRef(entryMenu);
  entryMenuRef.current = entryMenu;

  const handleRowContextMenu = useCallback((event: ReactMouseEvent, entry: RemoteFileEntry) => {
    setSelected(entry.path);
    contextTargetRef.current = entry;
    entryMenuRef.current(event);
  }, []);

  const handleRowSelect = useCallback((entry: RemoteFileEntry) => setSelected(entry.path), []);

  const openEntryRef = useRef(openEntry);
  openEntryRef.current = openEntry;
  const handleRowOpen = useCallback((entry: RemoteFileEntry) => openEntryRef.current(entry), []);

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
      ref={panelRef}
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
        <PanelButton
          label="上传文件到当前目录"
          icon={picking ? Loader2 : Upload}
          disabled={!cwd || picking}
          className={picking ? "animate-spin" : undefined}
          onClick={() => void pickFilesToUpload()}
        />
        <PanelButton label="折叠面板" icon={Pause} onClick={onClose} />
      </div>

      <div className="flex h-7 shrink-0 items-center gap-1 border-b border-line px-2 text-11">
        <div
          className={cn(
            "flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto",
            hideCrumbs && "hidden",
          )}
        >
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
          <div
            className={cn(
              "flex items-center gap-0.5",
              hideCrumbs ? "min-w-0 flex-1" : "shrink-0",
            )}
          >
            <span
              ref={selectedNameRef}
              className="min-w-0 flex-1 truncate text-fg-subtle"
              title={selectedEntry.path}
            >
              {selectedEntry.name}
            </span>
            <div className="flex shrink-0 items-center gap-0.5">
            <PanelButton label="打开" icon={CornerDownLeft} onClick={() => openEntry(selectedEntry)} />
            {selectedEntry.kind !== "directory" && (
              <>
                <PanelButton
                  label="预览"
                  icon={Eye}
                  onClick={() =>
                    setPreview({
                      path: selectedEntry.path,
                      name: selectedEntry.name,
                      size: selectedEntry.size,
                    })
                  }
                />
                <PanelButton
                  label="下载到本地"
                  icon={Download}
                  onClick={() => void downloadEntry(selectedEntry)}
                />
              </>
            )}
            <PanelButton label="重命名" icon={Pencil} onClick={() => renameEntry(selectedEntry)} />
            <PanelButton label="创建副本" icon={Copy} onClick={() => copyEntry(selectedEntry)} />
            <PanelButton
              label="删除"
              icon={Trash2}
              onClick={() => removeEntry(selectedEntry)}
              className="hover:text-danger"
            />
            </div>
          </div>
        )}
      </div>

      <div
        tabIndex={0}
        className="min-h-0 flex-1 overflow-y-auto outline-none"
        onKeyDown={onKeyDown}
        onContextMenu={backgroundMenu}
        onClick={(event) => {
          // Clicking empty space clears the selection (rows stop propagation).
          if (event.target === event.currentTarget) setSelected(null);
        }}
      >
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
            {entries.map((entry) => (
              <FileRow
                key={entry.path}
                sessionId={sessionId}
                entry={entry}
                selected={entry.path === selected}
                onSelect={handleRowSelect}
                onOpen={handleRowOpen}
                onContextMenu={handleRowContextMenu}
              />
            ))}
          </div>
        )}
      </div>

      {/* Drop overlay lives outside the scroll container: inside it the
          highlight would scroll away with the file list and sit off-screen. */}
      {dragging && (
        <div className="pointer-events-none absolute inset-0 z-30 flex items-center justify-center p-2">
          <div className="flex h-full w-full flex-col items-center justify-center gap-2 rounded-[12px] border-2 border-dashed border-accent bg-accent/10 backdrop-blur-[2px]">
            <div className="flex flex-col items-center gap-2 rounded-[10px] bg-surface-1/95 px-5 py-4 text-11 text-accent shadow-lg">
              <Upload size={20} />
              <span className="font-medium">松开以上传到当前目录</span>
              <span className="truncate text-fg-subtle">{cwd ?? ""}</span>
              <span className="text-fg-subtle">支持多个文件与文件夹</span>
            </div>
          </div>
        </div>
      )}

      <div className="flex h-6 shrink-0 items-center justify-between border-t border-line px-2 text-10 text-fg-subtle">
        <span className="truncate">{cwd ?? "—"}</span>
        <span className="shrink-0">SFTP</span>
      </div>

      {/* Names the row the menu applies to — set by the row's context handler
          and cleared by the background one. */}
      <ContextMenu {...menu.props} title={contextTargetRef.current?.name ?? undefined} />

      <ConfirmDialog
        open={deleteTarget !== null}
        title={`删除${deleteTarget?.kind === "directory" ? "文件夹" : "文件"}`}
        description={
          deleteTarget?.kind === "directory"
            ? `确定删除文件夹“${deleteTarget?.name ?? ""}”？文件夹内的全部内容也会一并删除，此操作不可撤销。`
            : `确定删除文件“${deleteTarget?.name ?? ""}”？此操作不可撤销。`
        }
        confirmLabel="删除"
        danger
        onConfirm={confirmRemove}
        onCancel={() => setDeleteTarget(null)}
      />

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

      {preview && (
        <Suspense
          fallback={
            <div className="fixed inset-0 z-[140] flex items-center justify-center bg-black/50">
              <Loader2 size={18} className="animate-spin text-fg-subtle" />
            </div>
          }
        >
          <FilePreviewModal
            sessionId={sessionId}
            target={preview}
            onClose={() => setPreview(null)}
            onEdit={(next) => {
              setPreview(null);
              setEditor({
                path: next.path,
                name: next.name,
                language: fileKind(next.name).language,
              });
            }}
          />
        </Suspense>
      )}
    </aside>
  );
}
