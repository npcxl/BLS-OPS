import {
  Suspense,
  lazy,
  memo,
  useCallback,
  useEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { useTranslation } from "react-i18next";
import { listen } from "@tauri-apps/api/event";
import {
  ArrowUpDown,
  ChevronLeft,
  ClipboardCopy,
  CornerDownLeft,
  Copy,
  Download,
  Eye,
  FilePlus2,
  FolderPlus,
  Loader2,
  MoreHorizontal,
  Pause,
  Server as ServerIcon,
  Pencil,
  RefreshCw,
  Trash2,
  Upload,
} from "@/components/icons";
import { ContextMenu, useContextMenu, type ContextMenuItem } from "@/components/ui/context-menu";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { VscodeLogoIcon } from "@/components/ui/vscode-logo-icon";
import { useInspectionMode } from "@/stores/inspection-store";
import { opsApi, toErrorMessage, type RemoteFileEntry } from "@/api/ops-api";
import type { EditorSyncEventPayload } from "@/api/types/editor-sync";
import { editorSyncEvent } from "@/lib/events";
import { useDomainStore } from "@/stores/domain-store";
import { useSessionStore } from "@/stores/session-store";
import { fileKind, isEditableKind } from "@/lib/file-kind";
import { copyText } from "@/lib/clipboard";
import { cn } from "@/lib/cn";
import type { PreviewTarget } from "@/workbench/views/preview/FilePreviewModal";
import { useDirSizeStore } from "@/stores/dir-size-store";
import { FileRow } from "./FileRow";
import { NamePromptModal } from "./NamePromptModal";
import { PanelButton } from "./PanelButton";
import { TrashDialog } from "./TrashDialog";
import { TransferCenterDialog } from "./TransferCenterDialog";
import {
  AUTO_DIR_SIZE_LIMIT,
  hasUsableSize,
  useAutoDismiss,
  useDirSizeQueue,
  useDirSizeWatchdog,
  useTransientNotice,
} from "./use-dir-size-queue";
import {
  isEditableTarget,
  parentOf,
  validateName,
  type EditorTarget,
  type FilePanelFollow,
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
   * Terminal follow state: bumped on every `cd` typed in the paired terminal,
   * carrying the **absolute path the terminal resolved** for it.
   */
  follow: FilePanelFollow;
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
function RemoteFilePanelImpl({
  sessionId,
  connected,
  follow,
  initialPath,
  reveal,
  onClose,
}: RemoteFilePanelProps) {
  const { t } = useTranslation();
  const [width, setWidth] = useState(DEFAULT_WIDTH);
  /** Canonical navigation history: back/forward + current location. */
  const [nav, setNav] = useState<{ stack: string[]; index: number }>({ stack: [], index: -1 });
  const [entries, setEntries] = useState<RemoteFileEntry[]>([]);
  const [status, setStatus] = useState<PanelStatus>({ state: "idle" });
  const [selected, setSelected] = useState<string | null>(null);
  const menu = useContextMenu();
  const [nameDialog, setNameDialog] = useState<NameDialog | null>(null);
  /**
   * 就地重命名状态：只记路径与进入编辑时的文件名，输入框长在那一行里
   * （像资源管理器那样），不再弹 Modal。
   */
  const [renaming, setRenaming] = useState<{ path: string; name: string } | null>(null);
  const [editor, setEditor] = useState<EditorTarget | null>(null);
  const [preview, setPreview] = useState<PreviewTarget | null>(null);
  // Non-blocking notice (used for unsupported types) — auto-dismisses after 4s.
  const [notice, setNotice] = useTransientNotice();
  /** 提示的语气：操作失败要红，别把错误混在灰色说明里。 */
  const [noticeTone, setNoticeTone] = useState<"info" | "danger">("info");
  const showNotice = useCallback(
    (message: string, tone: "info" | "danger" = "info") => {
      setNoticeTone(tone);
      setNotice(message);
    },
    [setNotice],
  );
  const [dragging, setDraggingState] = useState(false);
  const [uploadNotice, setUploadNotice] = useState<string | null>(null);
  const [transferOpen, setTransferOpen] = useState(false);
  /** 巡检模式（只读）：所有写入口都要过它。 */
  const inspection = useInspectionMode();

  /**
   * 巡检模式的统一闸门：写操作先过这里，并说清为什么没执行。
   * 只挡客户端入口 —— 自由终端里照样能 `rm`，所以 UI 文案不承诺"安全"。
   */
  const blockedByInspection = useCallback((): boolean => {
    if (!inspection) return false;
    showNotice(t("Inspection mode: changes are disabled"), "danger");
    return true;
  }, [inspection, showNotice, t]);

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
   * 地址栏：`null` = 不在编辑（显示当前目录）。聚焦后变成可编辑输入框，
   * 回车跳转、Esc 放弃 —— 和 Windows 资源管理器的地址栏同一个用法。
   */
  const [pathDraft, setPathDraft] = useState<string | null>(null);
  const pathInputRef = useRef<HTMLInputElement>(null);
  /** 工具栏「⋯」的菜单（与行右键菜单各自独立，全局仍只允许一个可见）。 */
  const toolMenu = useContextMenu();

  /**
   * 目录加载的请求序号。
   *
   * 快速切换目录时会同时有多个 `sftpListDir` 在飞。没有序号时，**先发后到**
   * 的旧响应会把用户最后选择的目录覆盖掉（页面"跳回"旧目录）。
   * 只允许最新一次请求更新列表、路径与错误。
   */
  const loadSeqRef = useRef(0);

  const load = useCallback(
    async (path: string, options?: { silent?: boolean }) => {
      // 静默刷新：删文件 / 上传 / 重命名之后只换列表内容，不切 loading 页、
      // 不清选中项 —— 否则整块列表现消失再出现，就是"闪一下"。
      const silent = options?.silent ?? false;
      const seq = ++loadSeqRef.current;
      if (!silent) {
        setStatus({ state: "loading" });
        setSelected(null);
      }
      try {
        const result = await opsApi.sftpListDir(sessionId, path);
        // 过期响应：直接丢弃，什么状态都不写。
        if (seq !== loadSeqRef.current) return;
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
        if (seq !== loadSeqRef.current) return;
        if (silent) {
          // 刷新失败时保留已有列表：把列表换成错误页等于把用户正在看的东西
          // 抹掉，比报错本身更糟。
          showNotice(toErrorMessage(cause), "danger");
        } else {
          setStatus({ state: "error", message: toErrorMessage(cause) });
        }
      }
    },
    [sessionId, showNotice],
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

  // Follow the terminal's directory: the terminal pushes a **confirmed
  // absolute path** whenever the working directory really changed (the shell
  // reported a new cwd via OSC 7, or a `cd` exited 0) — all we do here is
  // jump. Nonce 0 is the initial state, not a change — reacting to it would
  // reload the initial listing a second time.
  const followNonce = follow.nonce;
  const followPath = follow.path;
  useEffect(() => {
    if (followNonce === 0 || !followPath) return;
    void load(followPath);
    // 每个 nonce 只响应一次，`load` 有意不入依赖。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [followNonce, followPath]);

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
      // 换目录时退出就地重命名：回到原目录不能又停在编辑框里。
      setRenaming(null);
      setNav((current) => ({
        stack: [...current.stack.slice(0, current.index + 1), path],
        index: current.index + 1,
      }));
      void load(path);
    },
    [load],
  );

  /**
   * 左箭头 = 回上一级。历史上"后退 / 前进 / 上一级"是三个按钮，文件树里
   * 真正天天用的只有向上，合并成一个之后顶部才腾得下地址栏。
   */
  const goUp = () => {
    if (!cwd) return;
    navigate(parentOf(cwd));
  };

  const refresh = () => {
    if (cwd) void load(cwd);
  };

  /**
   * 地址栏回车：**先探测再跳**。不存在的路径只在顶部提示，绝不把当前列表
   * 换成错误页 —— 那样等于把用户正在看的内容抹掉。
   *
   * - 目录 → 直接进去
   * - 文件 → 进它所在目录并选中（输入 `/etc/nginx/nginx.conf` 能一步定位）
   * - 不存在 / 无权限 → 留在原目录，提示里带路径与原因
   */
  const commitPath = useCallback(
    async (draft: string) => {
      const raw = draft.trim();
      setPathDraft(null);
      if (!raw) return;
      // 相对路径按当前目录补全：地址栏里输入 `logs` 与在 shell 里 `cd logs` 同义。
      const target = raw.startsWith("/") ? raw : `${cwd ?? ""}/${raw}`;
      if (target === cwd) return;
      try {
        const entry = await opsApi.sftpStat(sessionId, target);
        if (entry.kind === "directory") {
          navigate(target);
          return;
        }
        // 文件：落到父目录并选中。已经在父目录里就不再重载（省一次闪）。
        const parent = parentOf(target);
        if (parent !== cwd) await load(parent);
        setSelected(target);
      } catch (cause) {
        showNotice(
          t("Cannot open {{path}} — {{reason}}", {
            path: target,
            reason: toErrorMessage(cause),
          }),
          "danger",
        );
      }
    },
    [cwd, load, navigate, sessionId, showNotice, t],
  );

  const openEntry = useCallback(
    (entry: RemoteFileEntry) => {
      if (entry.kind === "directory") {
        navigate(entry.path);
        return;
      }
      // Text/code files open straight in the editor — editing is the useful
      // action there. Everything else goes to the preview, which renders what
      // it can and explains what it cannot.
      if (isEditableKind(entry)) {
        setEditor({ path: entry.path, name: entry.name, language: fileKind(entry).language });
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
          // 静默刷新：操作成功后列表原地更新，不闪。
          if (cwd) return load(cwd, { silent: true });
          return undefined;
        })
        .catch((cause) => showNotice(toErrorMessage(cause), "danger"));
    },
    [cwd, load, showNotice],
  );

  /** 操作后原地刷新列表（不切 loading、不清选中）。 */
  const refreshSilently = useCallback(() => {
    if (cwd) void load(cwd, { silent: true });
  }, [cwd, load]);

  const [deleteTarget, setDeleteTarget] = useState<RemoteFileEntry | null>(null);
  /** 永久删除（跳过回收站）：必须由用户显式选择，绝不作为删除的回退。 */
  const [purgeTarget, setPurgeTarget] = useState<RemoteFileEntry | null>(null);
  const [trashOpen, setTrashOpen] = useState(false);

  const removeEntry = (entry: RemoteFileEntry) => {
    if (blockedByInspection()) return;
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
      const destination = await save({ title: t("Download {{name}}", { name: entry.name }), defaultPath: entry.name });
      if (!destination) return;
      // 任务化：立刻返回，进度在传输中心看；同名默认重命名，不静默覆盖本地文件。
      await opsApi.transferDownload(sessionId, entry.path, destination, "rename");
      setNotice(t("Download queued: {{name}}", { name: entry.name }));
    } catch (cause) {
      showNotice(toErrorMessage(cause), "danger");
    }
  };

  /**
   * Open a remote folder in the user's VSCode via Remote-SSH. The backend
   * registers (or reuses) a marked Host in ~/.ssh/config and spawns `code`;
   * VSCode then talks to the server itself, so the folder is live. Only
   * saved servers qualify (a stable alias needs a stable server), and
   * ProxyJump chains are refused server-side — hidden here.
   */
  const savedServerId = useSessionStore((state) => state.sessions[sessionId]?.serverId);
  const usesJumpHost = useDomainStore((state) =>
    savedServerId ? state.servers.find((server) => server.id === savedServerId)?.proxy_jump_id != null : false,
  );
  /** 面板顶部固定的身份条：文件名再像，也不能搞错自己在哪台机器上。 */
  const server = useDomainStore((state) =>
    savedServerId ? state.servers.find((item) => item.id === savedServerId) ?? null : null,
  );
  const canOpenInVscode = Boolean(savedServerId) && !usesJumpHost;

  const openInVscode = async (path: string) => {
    if (!savedServerId) return;
    try {
      await opsApi.vscodeOpenRemoteFolder(savedServerId, path);
    } catch (cause) {
      setNotice(toErrorMessage(cause));
    }
  };

  /**
   * 本地编辑器同步（editor_sync）：远程文件副本下载到本地工作区，用本机
   * VSCode 打开，之后每次保存自动 SFTP 回传。与文件夹的 Remote-SSH 模式
   * 互补——这里走的是本面板自己的 SSH 连接，quick target 也能用。
   * 探测本机是否装了 VSCode（挂载时一次）；没装就不显示入口。
   */
  const [vscodeEditor, setVscodeEditor] = useState(false);
  useEffect(() => {
    let cancelled = false;
    void opsApi
      .editorListAvailable()
      .then((editors) => {
        if (!cancelled) {
          setVscodeEditor(editors.some((editor) => editor.id === "vscode" && editor.available));
        }
      })
      .catch(() => {
        /* 探测失败：视为未安装，不显示入口 */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const openInVscodeEditor = async (entry: RemoteFileEntry) => {
    try {
      // 同一文件重复右键时不建第二个会话（第二份本地副本会互相覆盖）。
      const sessions = await opsApi.editorSyncList(sessionId);
      if (
        sessions.some(
          (sync) =>
            sync.remotePath === entry.path && (sync.status === "starting" || sync.status === "active"),
        )
      ) {
        setNotice(t("Already open in VSCode"));
        return;
      }
      await opsApi.editorSyncOpen(sessionId, entry.path, "vscode");
      setNotice(
        t("Opened {{name}} in VSCode — saving syncs back to the server", { name: entry.name }),
      );
    } catch (cause) {
      setNotice(toErrorMessage(cause));
    }
  };

  // 保存回传失败必须可见（status=error 持续到下一次保存成功）。
  useEffect(() => {
    if (!connected) return;
    let disposed = false;
    let unlisten: (() => void) | null = null;
    void listen<EditorSyncEventPayload>(editorSyncEvent, (event) => {
      const { session } = event.payload;
      if (session.sessionId !== sessionId || session.status !== "error") return;
      setNotice(
        t("Save sync failed: {{message}}", { message: session.message ?? "" }),
      );
    }).then((fn) => {
      if (disposed) fn();
      else unlisten = fn;
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [connected, sessionId, t]);

  const confirmRemove = () => {
    if (!deleteTarget || blockedByInspection()) return;
    const target = deleteTarget;
    setDeleteTarget(null);
    // 删除 = 移入服务器回收区。移不过去（跨文件系统 / 无权限）时如实报错，
    // **不会**偷偷改成永久删除 —— 那正是"以为能恢复、其实已经没了"的来源。
    runAndRefresh(() => opsApi.trashMove(sessionId, target.path));
  };

  const confirmPurge = () => {
    if (!purgeTarget || blockedByInspection()) return;
    const target = purgeTarget;
    setPurgeTarget(null);
    runAndRefresh(() => opsApi.sftpRemove(sessionId, target.path));
  };

  /** 进入就地重命名：选中该行，名字输入框会出现在行内。 */
  const renameEntry = (entry: RemoteFileEntry) => {
    if (blockedByInspection()) return;
    setSelected(entry.path);
    setRenaming({ path: entry.path, name: entry.name });
  };

  const cancelRename = useCallback(() => setRenaming(null), []);

  /**
   * 提交就地重命名。返回 `false` 表示名字不合法 —— 行内输入框会留在编辑态，
   * 用户可以直接改，而不是把刚打的字丢掉。
   */
  const submitRename = useCallback(
    (entry: RemoteFileEntry, name: string): boolean => {
      const trimmed = name.trim();
      if (trimmed === entry.name) {
        // 没改名：当成取消，不发无意义的 SFTP 请求。
        setRenaming(null);
        return true;
      }
      // `validateName` 返回的已经是翻译好的文案，这里不再包一层 t()。
      const error = validateName(trimmed);
      if (error) {
        setNotice(error);
        return false;
      }
      setRenaming(null);
      // 改名后把选中落到新名字上：刷新是静默的，选中项不能丢。
      const parent = parentOf(entry.path);
      setSelected(parent === "/" ? `/${trimmed}` : `${parent}/${trimmed}`);
      runAndRefresh(() => opsApi.sftpRename(sessionId, entry.path, trimmed));
      return true;
    },
    [runAndRefresh, sessionId, setNotice],
  );

  const copyEntry = (entry: RemoteFileEntry) => {
    if (blockedByInspection()) return;
    const dot = entry.name.lastIndexOf(".");
    // 建议副本名是数据（会创建的文件名），扩展名只是纯数据拼接；" - 副本"
    // 这段建议文案本身走插值 key。
    const stem = dot > 0 ? entry.name.slice(0, dot) : entry.name;
    const extension = dot > 0 ? entry.name.slice(dot) : "";
    const suggested = `${t("{{name}} - Copy", { name: stem })}${extension}`;
    setNameDialog({
      title: "Create a copy",
      label: "Copy name",
      initial: suggested,
      submitLabel: "Create a copy",
      validate: validateName,
      onConfirm: (name) => opsApi.sftpCopy(sessionId, entry.path, name),
    });
  };

  const createFolder = () => {
    if (!cwd || blockedByInspection()) return;
    setNameDialog({
      title: "New folder",
      label: "Folder name",
      initial: t("New folder"),
      submitLabel: "Create",
      validate: validateName,
      onConfirm: (name) => opsApi.sftpMkdir(sessionId, `${cwd === "/" ? "" : cwd}/${name}`),
    });
  };

  const createFile = () => {
    if (!cwd || blockedByInspection()) return;
    setNameDialog({
      title: "New file",
      label: "File name",
      initial: t("New file.txt"),
      submitLabel: "Create",
      validate: validateName,
      onConfirm: (name) => opsApi.sftpTouch(sessionId, `${cwd === "/" ? "" : cwd}/${name}`),
    });
  };

  const uploadFiles = useCallback(
    async (paths: string[]) => {
      if (!cwd || paths.length === 0) return;
      if (blockedByInspection()) return;
      setUploadNotice(null);
      try {
        // 任务化：入队后立刻返回，面板不再干等整个传输。
        // 同名默认重命名（不静默覆盖服务器上的文件）。
        const tasks = await opsApi.transferUpload(sessionId, paths, cwd, "rename");
        const skipped = tasks.filter((task) => task.state === "skipped").length;
        const queued = tasks.length - skipped;
        setUploadNotice(
          skipped > 0
            ? t("{{count}} queued, {{skipped}} skipped (already exist)", { count: queued, skipped })
            : t("{{count}} files queued for upload", { count: queued }),
        );
        setTransferOpen(true);
      } catch (cause) {
        showNotice(toErrorMessage(cause), "danger");
      }
    },
    [cwd, sessionId, t, showNotice, blockedByInspection],
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

  const { computeDirSize, dropQueued, releaseStale, requireDirSize, listenerReady } =
    useDirSizeQueue(sessionId, handleDirSizeError);

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
  /**
   * 当前目录里**已算出结果**的文件夹数量。
   *
   * 订阅它，是为了让自动统计变成"滚动窗口"而不是"只算前 12 个"：
   * 每完成一个，这个数就变，下面的 effect 重跑并补上下一个。
   * 50 个文件夹也会陆续算完，只是同时占用的任务数始终有上限。
   */
  const completedInView = useDirSizeStore((state) => {
    let count = 0;
    for (const entry of entries) {
      if (entry.kind !== "directory") continue;
      if (state.get(sessionId, entry.path)?.complete) count += 1;
    }
    return count;
  });

  useEffect(() => {
    if (!connected || !listenerReady) return;
    const current = new Set<string>();
    for (const entry of entries) {
      if (entry.kind === "directory") current.add(entry.path);
    }
    // **需求登记独立于是否启动任务**：已有缓存的目录也要登记，
    // 否则另一个面板离开目录时会把我们还需要的结果当成"没人要"取消掉。
    for (const path of current) requireDirSize(path);

    // 待发送：旧目录的项直接丢；在途/已完成：减需求，没人需要才真的取消。
    dropQueued((path) => current.has(path));
    releaseStale((path) => current.has(path));

    // 补到上限。只有**有数字的结果**才跳过；cancelled / timed_out / failed
    // 会重新入队（内部有退避，不会空转）。
    let scheduled = 0;
    for (const entry of entries) {
      if (entry.kind !== "directory") continue;
      if (scheduled >= AUTO_DIR_SIZE_LIMIT) break;
      const cached = useDirSizeStore.getState().get(sessionId, entry.path);
      if (hasUsableSize(cached)) continue;
      // 排队中 / 计算中：已经占着名额，不重复提交。
      if (cached && !cached.complete) {
        scheduled += 1;
        continue;
      }
      // 没有状态，或"结束了但没结果"：入队。退避中的不占名额。
      if (computeDirSize(entry.path)) scheduled += 1;
    }
  }, [
    connected,
    listenerReady,
    entries,
    sessionId,
    computeDirSize,
    dropQueued,
    releaseStale,
    completedInView,
  ]);

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
        title: t("Upload to {{path}}", { path: cwd }),
      });
      if (!chosen) return; // cancelled
      const paths = Array.isArray(chosen) ? chosen : [chosen];
      if (paths.length === 0) return;
      await uploadFiles(paths);
    } catch (cause) {
      showNotice(toErrorMessage(cause), "danger");
    } finally {
      setPicking(false);
    }
  }, [cwd, picking, uploadFiles, t, showNotice]);

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
    // 焦点在编辑框 / 代码编辑器里：按键归它们。不放行的话 Backspace 删不了字，
    // 还会把面板退回上一级 —— 看起来就是"编辑时按退格在回退"。
    if (isEditableTarget(event.target)) return;
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

  // 菜单 label 在右键回调（事件期）里用当前语言即时求值，无需存 key。
  const entryMenu = menu.onContextMenu(() => {
    const entry = contextTargetRef.current;
    if (!entry) return [];
    const isDir = entry.kind === "directory";
    const items: import("@/components/ui/context-menu").ContextMenuItem[] = [
      { id: "open", label: t("Open"), icon: CornerDownLeft, onSelect: () => openEntry(entry) },
    ];
    if (!isDir) {
      items.push(
        {
          id: "preview",
          label: t("Preview"),
          icon: Eye,
          onSelect: () => setPreview({ path: entry.path, name: entry.name, size: entry.size }),
        },
        // 本机装了 VSCode 才显示（单文件编辑同步模式）。
        ...(vscodeEditor
          ? [
              {
                id: "vscode-file",
                label: t("Open in VSCode"),
                icon: VscodeLogoIcon,
                onSelect: () => void openInVscodeEditor(entry),
              },
            ]
          : []),
        {
          id: "download",
          label: t("Download to local…"),
          icon: Download,
          onSelect: () => void downloadEntry(entry),
        },
      );
    } else if (canOpenInVscode) {
      // Folders only: Remote-SSH opens a workspace root. Quick targets and
      // ProxyJump servers have no stably registrable host, so no item at all.
      items.push({
        id: "vscode",
        label: t("Open in VSCode"),
        icon: VscodeLogoIcon,
        onSelect: () => void openInVscode(entry.path),
      });
    }
    items.push({ id: "sep1", separator: true });
    return [
      ...items,
      {
        id: "rename",
        label: t("Rename"),
        icon: Pencil,
        hint: "F2",
        disabled: inspection,
        onSelect: () => renameEntry(entry),
      },
      {
        id: "duplicate",
        label: t("Create a copy"),
        icon: Copy,
        disabled: inspection,
        onSelect: () => copyEntry(entry),
      },
      {
        id: "copy-path",
        label: t("Copy full path"),
        icon: ClipboardCopy,
        onSelect: () => void copyText(entry.path),
      },
      {
        id: "copy-name",
        label: t("Copy file name"),
        icon: ClipboardCopy,
        onSelect: () => void copyText(entry.name),
      },
      { id: "sep2", separator: true },
      {
        id: "delete",
        label: t("Move to recycle bin"),
        icon: Trash2,
        hint: "Delete",
        disabled: inspection,
        onSelect: () => removeEntry(entry),
      },
      {
        id: "purge",
        label: t("Delete permanently…"),
        icon: Trash2,
        danger: true,
        disabled: inspection,
        onSelect: () => setPurgeTarget(entry),
      },
    ];
  });

  const backgroundMenu = menu.onContextMenu(() => {
    // No row is the subject of a background menu.
    contextTargetRef.current = null;
    return [
      {
        id: "upload",
        label: t("Upload files…"),
        icon: Upload,
        disabled: !cwd || picking,
        onSelect: () => void pickFilesToUpload(),
      },
      { id: "sep1", separator: true },
      { id: "mkdir", label: t("New folder"), icon: FolderPlus, disabled: !cwd, onSelect: createFolder },
      { id: "touch", label: t("New file"), icon: FilePlus2, disabled: !cwd, onSelect: createFile },
      { id: "sep2", separator: true },
      { id: "refresh", label: t("Refresh"), icon: RefreshCw, disabled: !cwd, onSelect: refresh },
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

  /**
   * 工具栏「⋯」菜单：上传 / 新建 / 刷新 / 折叠都收在这里，顶上只留地址栏。
   * 菜单项在渲染期构造，label 直接取当前语言。
   */
  const toolItems: ContextMenuItem[] = [
    {
      id: "upload",
      label: t("Upload files…"),
      icon: Upload,
      disabled: !cwd || picking || inspection,
      onSelect: () => void pickFilesToUpload(),
    },
    {
      id: "mkdir",
      label: t("New folder"),
      icon: FolderPlus,
      disabled: !cwd || inspection,
      onSelect: createFolder,
    },
    {
      id: "touch",
      label: t("New file"),
      icon: FilePlus2,
      disabled: !cwd || inspection,
      onSelect: createFile,
    },
    { id: "sep-tools", separator: true },
    { id: "refresh", label: t("Refresh"), icon: RefreshCw, disabled: !cwd, onSelect: refresh },
    {
      id: "transfers",
      label: t("Transfers"),
      icon: ArrowUpDown,
      onSelect: () => setTransferOpen(true),
    },
    { id: "trash", label: t("Recycle bin"), icon: Trash2, onSelect: () => setTrashOpen(true) },
    { id: "collapse", label: t("Collapse panel"), icon: Pause, onSelect: onClose },
  ];

  return (
    <aside
      ref={panelRef}
      className="relative flex h-full min-h-0 shrink-0 flex-col border-l border-line bg-surface-1"
      style={{ width }}
      aria-label={t("Remote files")}
    >
      {/* Drag handle */}
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label={t("Drag to resize")}
        className="absolute inset-y-0 left-0 z-10 w-1 cursor-col-resize hover:bg-accent/40"
        onPointerDown={startDrag}
      />

      {/* 身份条：服务器与环境始终可见 —— 路径再像，也不能搞错在哪台机器上。 */}
      {server && (
        <div className="flex h-7 shrink-0 items-center gap-1.5 border-b border-line bg-surface-2/40 px-2 text-10">
          <ServerIcon size={11} className="shrink-0 text-fg-subtle" />
          <span
            className="min-w-0 truncate text-fg-muted"
            title={`${server.username}@${server.host}:${server.port}`}
          >
            {server.name}
          </span>
          <span className="ml-auto min-w-0 truncate font-mono text-fg-subtle" title={server.host}>
            {server.host}
          </span>
          {inspection && (
            <span className="shrink-0 rounded bg-warning/15 px-1.5 py-0.5 text-warning">
              {t("Read-only")}
            </span>
          )}
        </div>
      )}

      <div className="flex h-9 shrink-0 items-center gap-1 border-b border-line px-1.5">
        {/* 上一级与"返回"合并为一个：文件树里最常用的后退就是回父目录。 */}
        <PanelButton
          label="Go up"
          icon={ChevronLeft}
          disabled={!cwd || cwd === "/"}
          onClick={goUp}
        />
        <input
          ref={pathInputRef}
          value={pathDraft ?? cwd ?? ""}
          aria-label={t("Path")}
          spellCheck={false}
          placeholder={t("Disconnected")}
          onChange={(event) => setPathDraft(event.target.value)}
          onFocus={() => {
            setPathDraft(cwd ?? "");
            // 像地址栏那样整体选中：直接输入就替换整条路径。
            requestAnimationFrame(() => pathInputRef.current?.select());
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              const target = event.currentTarget;
              void commitPath(target.value);
              target.blur();
            } else if (event.key === "Escape") {
              event.preventDefault();
              setPathDraft(null);
              event.currentTarget.blur();
            }
          }}
          onBlur={() => setPathDraft(null)}
          className="h-[24px] min-w-0 flex-1 rounded-[5px] border border-transparent bg-transparent px-1.5 font-mono text-11 text-fg outline-none hover:border-line focus:border-accent focus:bg-surface-1"
        />
        <button
          type="button"
          aria-label={t("More actions")}
          title={t("More actions")}
          disabled={!cwd}
          onClick={(event) => {
            const rect = event.currentTarget.getBoundingClientRect();
            // 菜单右对齐到按钮，并保证不跑出窗口左边。
            toolMenu.openAt(Math.max(8, rect.right - 184), rect.bottom + 4, toolItems);
          }}
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded-[5px] text-fg-muted hover:bg-surface-hover hover:text-fg disabled:pointer-events-none disabled:opacity-40"
        >
          <MoreHorizontal size={14} strokeWidth={1.75} />
        </button>
      </div>

      {/* 选中项的操作条：只在选中时出现，不挤占地址栏。 */}
      {selectedEntry && (
        <div className="flex h-7 shrink-0 items-center gap-1 border-b border-line px-2 text-11">
          <span className="min-w-0 flex-1 truncate text-fg-subtle" title={selectedEntry.path}>
            {selectedEntry.name}
          </span>
          <div className="flex shrink-0 items-center gap-0.5">
            <PanelButton label="Open" icon={CornerDownLeft} onClick={() => openEntry(selectedEntry)} />
            {selectedEntry.kind !== "directory" && (
              <>
                <PanelButton
                  label="Preview"
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
                  label="Download to local"
                  icon={Download}
                  onClick={() => void downloadEntry(selectedEntry)}
                />
              </>
            )}
            <PanelButton
              label="Rename"
              icon={Pencil}
              disabled={inspection}
              onClick={() => renameEntry(selectedEntry)}
            />
            <PanelButton
              label="Create a copy"
              icon={Copy}
              disabled={inspection}
              onClick={() => copyEntry(selectedEntry)}
            />
            <PanelButton
              label="Move to recycle bin"
              icon={Trash2}
              disabled={inspection}
              onClick={() => removeEntry(selectedEntry)}
              className="hover:text-danger"
            />
          </div>
        </div>
      )}

      {/* 提示固定在列表上方：列表滚到哪儿都看得见（地址栏输错路径要靠它）。 */}
      {notice && (
        <div
          className={cn(
            "shrink-0 border-b border-line px-3 py-2 text-11",
            noticeTone === "danger"
              ? "bg-danger/10 text-danger"
              : "bg-surface-2/70 text-fg-muted",
          )}
        >
          {notice}
        </div>
      )}

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

        {uploadNotice && (
          <div className="flex items-center justify-between border-b border-line bg-success/10 px-3 py-2 text-11 text-success">
            <span>{uploadNotice}</span>
            <button type="button" className="text-success/70 hover:text-success" onClick={() => setUploadNotice(null)}>
              {t("Close")}
            </button>
          </div>
        )}

        {status.state === "loading" && (
          <div className="flex items-center gap-2 px-3 py-3 text-11 text-fg-subtle">
            <Loader2 size={13} className="animate-spin" />
            {t("Loading")}
          </div>
        )}

        {status.state === "empty" && (
          <p className="px-3 py-3 text-11 text-fg-subtle">{t("This folder is empty. Drop local files here to upload.")}</p>
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
                {t("Retry")}
              </button>
            )}
          </div>
        )}

        {status.state === "disconnected" && (
          <div className="flex items-center gap-2 px-3 py-3 text-11 text-fg-subtle">
            <Pause size={13} />
            {t("Connection lost. File browsing is unavailable.")}
          </div>
        )}

        {status.state === "ready" && (
          <div>
            {entries.map((entry) => (
              <FileRow
                key={entry.path}
                sessionId={sessionId}
                entry={entry}
                selected={entry.path === selected}
                renaming={renaming?.path === entry.path}
                renameInitial={renaming?.path === entry.path ? renaming.name : ""}
                onRenameSubmit={submitRename}
                onRenameCancel={cancelRename}
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
              <span className="font-medium">{t("Drop to upload here")}</span>
              <span className="truncate text-fg-subtle">{cwd ?? ""}</span>
              <span className="text-fg-subtle">{t("Files and folders supported")}</span>
            </div>
          </div>
        </div>
      )}

      {/* <div className="flex h-6 shrink-0 items-center justify-between border-t border-line px-2 text-10 text-fg-subtle">
        <span className="truncate">{cwd ?? "—"}</span>
        <span className="shrink-0">SFTP</span>
      </div> */}

      {/* Names the row the menu applies to — set by the row's context handler
          and cleared by the background one. */}
      <ContextMenu {...menu.props} title={contextTargetRef.current?.name ?? undefined} />
      {/* 工具栏「⋯」：命令式打开，与行右键菜单共用一个全局可见槽位。 */}
      <ContextMenu {...toolMenu.props} />

      <ConfirmDialog
        open={deleteTarget !== null}
        title={t(deleteTarget?.kind === "directory" ? "Move folder to recycle bin" : "Move file to recycle bin")}
        description={
          deleteTarget?.kind === "directory"
            ? t(
                'Move folder "{{name}}" and everything inside to ~/.bls-ops-trash on the server. You can restore it from the recycle bin.',
                { name: deleteTarget?.name ?? "" },
              )
            : t(
                'Move file "{{name}}" to ~/.bls-ops-trash on the server. You can restore it from the recycle bin.',
                { name: deleteTarget?.name ?? "" },
              )
        }
        confirmLabel={t("Move to recycle bin")}
        onConfirm={confirmRemove}
        onCancel={() => setDeleteTarget(null)}
      />

      <ConfirmDialog
        open={purgeTarget !== null}
        danger
        title={t("Delete {{name}} permanently?", { name: purgeTarget?.name ?? "" })}
        description={t("This cannot be undone — no copy is kept in the recycle bin.")}
        confirmLabel={t("Delete permanently")}
        onConfirm={confirmPurge}
        onCancel={() => setPurgeTarget(null)}
      />

      <TrashDialog
        open={trashOpen}
        sessionId={sessionId}
        onClose={() => setTrashOpen(false)}
        onChanged={refreshSilently}
      />

      <TransferCenterDialog open={transferOpen} onClose={() => setTransferOpen(false)} />

      {nameDialog && (
        <NamePromptModal
          dialog={nameDialog}
          onClose={() => setNameDialog(null)}
          onSaved={() => {
            setNameDialog(null);
            // 新建 / 复制的文件直接出现在列表里，避免整块列表闪一次。
            refreshSilently();
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
              // 保存只改文件内容与 mtime，列表原地更新即可。
              if (cwd) void load(cwd, { silent: true });
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
                language: fileKind({ name: next.name, kind: "file" }).language,
              });
            }}
          />
        </Suspense>
      )}
    </aside>
  );
}

/**
 * 文件面板的整体渲染隔离。
 *
 * 它是 `TerminalView` 的子组件，而终端**每个按键**都会更新 draft 触发父组件
 * 重渲染。没有这层 memo，父组件每敲一个字，面板就要重跑一遍渲染函数
 * （包括对全部 `entries` 的遍历），这正是"同时开着文件面板时输入不跟手"的
 * 直接原因。
 *
 * 生效前提是 props 引用稳定 —— 调用方必须传 `useCallback` 包过的 `onClose`。
 * 面板内部从 zustand 读的数据变化时仍会正常重渲染（那是它自己的订阅）。
 */
export const RemoteFilePanel = memo(RemoteFilePanelImpl);
