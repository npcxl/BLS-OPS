/**
 * 附件侧的一切：本次发送勾选、拖入读取、统一预览、右键「添加到对话」。
 *
 * 附件是**消息的上下文**而不是一段路径文本：勾选状态放在页面（切标签/拖窗口
 * 都不丢），发送时由快照带走；预览统一走 `FilePreviewModal`，本地与远端同一条路。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { opsApi, type RemoteFileEntry } from "@/api/ops-api";
import { useExtremeStore, type ExtremeAttachment, type TerminalPane, type WorkspacePane } from "@/stores/extreme-store";
import type { TFunction } from "i18next";
import { base64ToBytes } from "@/lib/preview/base64";
import { toAppError } from "@/lib/app-error";
import type { PreviewSource } from "@/workbench/views/preview/FilePreviewModal";
import {
  collectDroppedEntries,
  readAttachment,
  remoteAttachment,
  remoteAttachmentId,
} from "../attachments";
import { manualShellTail } from "../manual-shell";
import type { TaskArtifact } from "../task-view";
import { isAttachmentUploading, stageWorkspaceAttachment } from "../attachments/staging";
import { attachmentSource, dropAttachmentFile } from "../attachments/payload";
import { dropStaleCleanup } from "../attachments/cleanup";
import { effectivePermission, useExtremePermissionsStore } from "@/stores/extreme-permissions-store";

type Store = ReturnType<typeof useExtremeStore.getState>;

export interface AttachmentDeps {
  workspaceId: string | null;
  sessionId: string | null;
  t: TFunction;
  setAttachments: Store["setAttachments"];
  setNotice: Store["setNotice"];
  addPicked: Store["addPicked"];
  openPaneTab: (tab: WorkspacePane, terminal?: TerminalPane) => void;
}

export function useAttachments({
  workspaceId,
  sessionId,
  t,
  setAttachments,
  setNotice,
  addPicked,
  openPaneTab,
}: AttachmentDeps) {
  const attachments = useExtremeStore((state) => state.attachments);
  const serverId = useExtremeStore((state) => state.serverId);
  const defaultMode = useExtremePermissionsStore((state) => state.defaultMode);
  const byWorkspace = useExtremePermissionsStore((state) => state.byWorkspace);
  const permission = effectivePermission({ defaultMode, byWorkspace }, workspaceId);

  /*
   * 自动暂存：一份一份来（同一台服务器上的并发 SFTP 写入反而更慢），
   * 统一走 `stageWorkspaceAttachment`。只读模式不自动传 —— 但要给一次
   * 明确说明，不能让人以为文件已经上去了。
   */
  useEffect(() => {
    if (!workspaceId || !sessionId) return;
    if (permission === "readonly") {
      if (attachments.some((item) => item.state === "ready" && !item.remotePath && !item.remoteError)) {
        const message = t("只读模式：附件只在本机读取，不会暂存到服务器。调整权限后才能上传。");
        if (useExtremeStore.getState().notice !== message) setNotice(message);
      }
      return;
    }
    const next = attachments.find((item) => item.state === "ready" && !item.remotePath &&
      !item.remoteError && item.uploadState !== "uploading" && item.uploadState !== "cleaned" &&
      (attachmentSource(item) !== null));
    if (next && !attachments.some((item) => item.uploadState === "uploading")) {
      void stageWorkspaceAttachment({ workspaceId, serverId, sessionId, attachment: next });
    }
  }, [attachments, permission, serverId, sessionId, setNotice, t, workspaceId]);

  /**
   * 右栏「附件」里勾选「用于本次发送」的附件。
   *
   * 输入区不再自己列附件：它只显示数量，点 ＋ 打开右栏。勾选状态放在页面，
   * 切右栏标签、拖窗口宽度都不会丢。
   */
  const [selectedAttachmentIds, setSelectedAttachmentIds] = useState<string[]>([]);
  useEffect(() => {
    setSelectedAttachmentIds([]);
  }, [workspaceId]);

  /**
   * 本次发送要带上的附件 = **右栏勾选的那几个**（按勾选顺序，重复只算一次）。
   *
   * 以前这里还会剔除"已经发过的附件"：结果是同一个远程文件发过一次之后，
   * 右键「添加到对话」再也选不上、输入框也不显示 —— 用户要再问一遍同一个
   * 配置就得重新加一份。发过不等于不能再发，去重只做在**本次勾选**这一层。
   */
  const composerAttachments = useMemo(() => {
    if (selectedAttachmentIds.length === 0) return [];
    const byId = new Map(attachments.map((item) => [item.id, item]));
    const ordered: typeof attachments = [];
    const seen = new Set<string>();
    for (const id of selectedAttachmentIds) {
      if (seen.has(id)) continue;
      seen.add(id);
      const item = byId.get(id);
      if (item) ordered.push(item);
    }
    return ordered;
  }, [attachments, selectedAttachmentIds]);

  const [preview, setPreview] = useState<string | null>(null);
  /** 统一文件预览：本地附件 / 服务器文件共用一个浮层。 */
  const [filePreview, setFilePreview] = useState<PreviewSource | null>(null);

  /**
   * 「添加到对话」选中的那个文件。
   *
   * 对齐 Ant Design X 的做法：附件不是"插一段路径文本"，而是**这条消息的
   * 上下文**。选中后它排在最前、按更大额度发送全文，其余文件只给清单。
   * 发送完自动清空，下一条消息重新选。
   */
  const [focusId, setFocusId] = useState<string | null>(null);

  /** 读一个文件成工作区条目（文本读内容，二进制读 base64）。 */
  const readFile = useCallback(
    (file: File, path?: string) =>
      readAttachment(file, { id: `att-${crypto.randomUUID()}`, path, t }),
    [t],
  );

  const addFiles = useCallback(
    (files: FileList | File[] | { file: File; path: string }[]) => {
      // `files` 可能是 FileList、File[]，也可能是拖入文件夹展开后的
      // `{ file, path }`：统一成后者再读。
      const raw = Array.from(files as ArrayLike<File | { file: File; path: string }>);
      const list = raw.map((entry) =>
        /*
         * `webkitRelativePath` 是**目录选择**（`<input webkitdirectory>`）与
         * 部分拖拽场景下浏览器给出的相对路径；直接取 `name` 会把整个文件夹
         * 拍平成同名文件（截图里那 367 个 `index.html` 就是这么来的）。
         */
        entry instanceof File
          ? { file: entry, path: entry.webkitRelativePath || entry.name }
          : entry,
      );
      if (list.length === 0) return;
      if (permission === "readonly") {
        // 仍然允许读进本机上下文（只读分析是合法的），只是不会暂存到服务器。
        setNotice(t("只读模式：附件只在本机读取，不会暂存到服务器。"));
      }
      const workspaceAtRead = useExtremeStore.getState().ensureWorkspace();
      if (!workspaceAtRead) return;
      void Promise.all(list.map((entry) => readFile(entry.file, entry.path))).then((added) => {
        const current = useExtremeStore.getState();
        current.setAttachmentsIn(workspaceAtRead, (items) => [...items, ...added]);
        if (current.workspaceId === workspaceAtRead) {
          /*
           * 新加进来的文件默认勾选「用于本次发送」：用户拖进来就是想让模型
           * 看到，不该再多一步去右栏点勾。读失败的不勾（它没有内容可发）。
           */
          const ready = added.filter((item) => item.state === "ready").map((item) => item.id);
          if (ready.length > 0) {
            setSelectedAttachmentIds((ids) => [...new Set([...ids, ...ready])]);
          }
          // 拖进来的文件要看得见：直接展开右栏的附件标签。
          openPaneTab("attachments");
        }
      });
    },
    [openPaneTab, permission, readFile, setNotice, t],
  );

  /**
   * 递归展开拖入的**文件夹**。
   *
   * `dataTransfer.files` 只给文件，目录会被静默丢掉；`webkitGetAsEntry()`
   * 能拿到目录句柄，逐层读出文件并保留相对路径（部署要按原层级上传）。
   * `readEntries` 一次最多返回 100 条，必须循环读到空为止。
   */
  /** 递归展开拖入的文件夹（相对路径保留原层级）。 */
  const collectDropped = useCallback((transfer: DataTransfer) => collectDroppedEntries(transfer), []);

  /*
   * 附件树的三个回调**必须 `useCallback`**：`AttachmentTree` 是 `memo` 组件，
   * 内联箭头函数每次父渲染都是新引用，会让 memo 完全失效 —— 流式回答时每个
   * token 都重画整棵树，几百个节点就是那样卡起来的。
   *
   * 用函数式 setState，`onPreview` 就不依赖 `preview`，引用永远稳定。
   */
  /*
   * 附件树是 `memo` 的，`onPreview` 必须保持稳定引用；真正的预览函数在下面
   * 才定义（依赖 sessionId），用 ref 转发，避免把它的依赖塞进这里的 deps。
   */
  const openPreviewRef = useRef<((id: string) => void) | null>(null);

  const handlePreview = useCallback((id: string) => {
    setPreview((current) => (current === id ? null : id));
    openPreviewRef.current?.(id);
  }, []);

  /**
   * 移除附件：只从工作区移除，**不碰服务器上的任何文件**。
   *
   * 正在上传的那一份先拦住：后台上传还在写它自己的暂存目录，这时移除会让
   * "写完了却没有归属"。等结束后再删，或者先点重试/取消。
   */
  const removeAttachment = useCallback(
    (id: string) => {
      const state = useExtremeStore.getState();
      const item = state.attachments.find((entry) => entry.id === id);
      if (!item) return;
      if (workspaceId && isAttachmentUploading(workspaceId, id)) {
        setNotice(t("「{{name}}」正在上传：等上传结束后再删除。", { name: item.name }));
        return;
      }
      // 只从工作区移除，服务器上的文件不动（那只能由清理动作改）。
      setAttachments((current) => current.filter((entry) => entry.id !== id));
      setPreview((current) => (current === id ? null : current));
      /*
       * 已经排队的那条消息还引用这份附件：**保留本机句柄**，否则派发时
       * 会变成"内容没了 → 发不出去"。队列本身只在内存里，句柄跟着它一起
       * 活到派发结束即可。
       */
      const queued = useExtremeStore
        .getState()
        .queuedSends.some((send) => send.attachments.some((item) => item.id === id));
      if (!queued) {
        dropAttachmentFile(id);
        if (workspaceId) dropStaleCleanup(workspaceId, id);
      }
    },
    [setAttachments, setNotice, t, workspaceId],
  );

  const handleRemoveAttachment = useCallback(
    (id: string) => removeAttachment(id),
    [removeAttachment],
  );

  /**
   * 「添加到对话」= **选定这条消息要重点看的文件**（不是插一段文字）。
   *
   * Ant Design X 里附件属于消息本身：`Sender` 的 header 挂 `Attachments`，
   * 提交时连同附件一起发。这里照做 —— 选中的文件进入 header 的"正在讨论"，
   * 发送时按更大额度给全文，发完清空。
   */
  /*
   * 移除一个附件：列表由我们自己维护（文件夹那份由 `onRemoveFolder` 一次删完）。
   */
  const handleAttachmentRemove = useCallback(
    (file: { uid: string }) => {
      const before = useExtremeStore.getState().attachments.length;
      removeAttachment(file.uid);
      // 被"上传中"拦住时列表没变：不能顺手清掉焦点。
      if (useExtremeStore.getState().attachments.length === before) return false;
      setFocusId((current) => (current === file.uid ? null : current));
      // 返回 false：列表由我们自己维护，不让 antd 内部改动。
      return false;
    },
    [removeAttachment],
  );

  /**
   * 统一预览入口：本地附件读内存字节，已上传的附件 / 任务产物走 SFTP。
   *
   * 两条来源最后都进同一个 `FilePreviewModal`，所以"太大 / 格式不支持 /
   * 连接断开 / 临时文件已清理"这些原因也由它统一显示。
   */
  const openAttachmentPreview = useCallback(
    (id: string) => {
      const item = useExtremeStore.getState().attachments.find((entry) => entry.id === id);
      if (!item) return;
      if (item.remotePath && sessionId) {
        setFilePreview({ kind: "remote", sessionId, path: item.remotePath });
        return;
      }
      if (item.data) {
        setFilePreview({
          kind: "local",
          name: item.name,
          size: item.size,
          bytes: base64ToBytes(item.data),
        });
        return;
      }
      if (typeof item.text === "string") {
        setFilePreview({
          kind: "local",
          name: item.name,
          size: item.size,
          bytes: new TextEncoder().encode(item.text),
        });
        return;
      }
      /*
       * 大二进制不在 store 里留 base64：预览按块/整份读本机句柄。句柄没了
       * （重启 / 已清理）就明确说"重新选择文件"，不拿历史副本冒充。
       */
      const source = attachmentSource(item);
      if (source) {
        void (async () => {
          try {
            const bytes = await source.read(0, source.total);
            setFilePreview({ kind: "local", name: item.name, size: item.size, bytes });
          } catch (cause) {
            setNotice(toAppError(cause).message);
          }
        })();
        return;
      }
      setNotice(
        item.uploadState === "cleaned"
          ? t("这份暂存副本已清理：重新上传或重新选择文件后才能预览。")
          : item.error ?? t("这个附件没有可预览的内容（读取失败或已被清理）。"),
      );
    },
    [sessionId, setNotice, t],
  );

  openPreviewRef.current = openAttachmentPreview;

  /** 任务产物：用它所属任务的会话 + 绝对路径打开，切了服务器也不串。 */
  const openArtifact = useCallback((artifact: TaskArtifact, artifactSession: string) => {
    setFilePreview({ kind: "remote", sessionId: artifactSession, path: artifact.path });
  }, []);

  const handleAttachmentPreview = useCallback(
    (file: { uid: string }) => {
      setPreview(file.uid);
      openAttachmentPreview(file.uid);
    },
    [openAttachmentPreview],
  );

  const handleAddToChat = useCallback((id: string) => {
    setFocusId((current) => (current === id ? null : id));
    requestAnimationFrame(() => {
      document.querySelector<HTMLTextAreaElement>(".extreme-core textarea")?.focus();
    });
  }, []);

  /**
   * 右栏「加入本次对话」：把真实终端的最近输出**显式**加进这次发送的材料。
   *
   * 自动附带只在「当前会话」范围里发生；「仅本条 / 自选」要看输出就自己加
   * —— 加完在输入框上方能看到这条材料，发送前就知道模型会收到什么。
   */
  const addTerminalOutput = useCallback(async () => {
    if (!workspaceId) return;
    const tail = (await manualShellTail(workspaceId, 120)).trim();
    if (!tail) {
      setNotice(t("右侧真实终端还没有输出可以加入。"));
      return;
    }
    addPicked([
      {
        kind: "output",
        // 同一条对话重复加入时按 id 去重：只留最新那份。
        id: `terminal:${workspaceId}`,
        label: t("真实终端最近 {{n}} 行", { n: tail.split("\n").length }),
        detail: tail,
      },
    ]);
    setNotice(t("已加入本次对话：{{n}} 行终端输出。", { n: tail.split("\n").length }));
  }, [addPicked, setNotice, t, workspaceId]);

  /**
   * 右键「添加到对话」：把**服务器上的文件**挂成附件，并选中本次发送。
   *
   * * **会话 + 远程路径**是身份：同一个文件反复右键 = 反复选中，不再新建一份，
   *   也不会因为"发过一次"就再也选不上；
   * * 附件带绝对路径 + `uploadState: "uploaded"`，模型能按路径直接读写，
   *   部署也能就地复制，不必先上传一次；
   * * 正文就地读进上下文（`sftpReadBinary`，有上限）；读不到（二进制 /
   *   没权限 / 中途切了服务器）**保留路径**，状态按实际结果标出来 ——
   *   工具仍然能凭路径读，用户也能看到到底读没读到。
   */
  const handleAddRemoteToChat = useCallback(
    async (entry: RemoteFileEntry) => {
      if (!sessionId) return;
      const id = remoteAttachmentId(sessionId, entry.path);
      const ownerId = useExtremeStore.getState().workspaceId ?? "";
      const existing = useExtremeStore.getState().attachments.find((item) => item.id === id);
      if (!existing) {
        setAttachments((list) =>
          list.some((item) => item.id === id) ? list : [...list, remoteAttachment(entry, sessionId)],
        );
      }
      // 选中本次发送：只在**勾选列表**里去重（发过的文件允许再选一次）。
      setSelectedAttachmentIds((ids) => (ids.includes(id) ? ids : [...ids, id]));
      setNotice(null);
      if (entry.kind === "directory") return;
      // 已经读到正文（文本 / 二进制）就不再重读；上次没读到的，这次再试。
      if (existing?.binary || typeof existing?.text === "string") return;
      /**
       * 回写**发起时那条对话**：读文件要等网络，中途切到别的服务器时镜像
       * 已经换人 —— 直接写镜像会把 A 的文件塞进 B。
       */
      const patch = (change: (item: ExtremeAttachment) => ExtremeAttachment) =>
        useExtremeStore.getState().setAttachmentsIn(ownerId, (list) =>
          list.map((item) => (item.id === id ? change(item) : item)),
        );
      try {
        const file = await opsApi.sftpReadBinary(sessionId, entry.path, 256 * 1024);
        const textLike =
          file.mime.startsWith("text/") ||
          /(json|xml|yaml|javascript|typescript|sql|x-sh|x-python|csv)/i.test(file.mime);
        if (!textLike) {
          // 二进制：只报元信息，路径仍然可用。
          patch((item) => ({
            ...item,
            state: "ready",
            binary: true,
            error: undefined,
            size: file.size,
          }));
          return;
        }
        const text = new TextDecoder("utf-8").decode(Uint8Array.from(base64ToBytes(file.data)));
        patch((item) => ({
          ...item,
          state: "ready",
          binary: false,
          error: undefined,
          text: file.truncated ? `${text}\n…（已截断）` : text,
          size: file.size,
        }));
      } catch (cause) {
        // 读不到正文：路径照样有效，标成"读取失败（按路径使用）"。
        patch((item) => ({ ...item, state: "ready", error: toAppError(cause).message }));
      }
    },
    [sessionId, setAttachments, setNotice],
  );

  return {
    attachments,
    selectedAttachmentIds,
    setSelectedAttachmentIds,
    composerAttachments,
    preview,
    setPreview,
    filePreview,
    setFilePreview,
    focusId,
    setFocusId,
    addFiles,
    collectDropped,
    handlePreview,
    handleRemoveAttachment,
    handleAttachmentRemove,
    openArtifact,
    handleAttachmentPreview,
    handleAddToChat,
    addTerminalOutput,
    handleAddRemoteToChat,
  };
}
