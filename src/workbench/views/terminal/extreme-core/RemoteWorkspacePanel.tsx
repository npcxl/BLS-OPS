import { ExternalLink, FolderOpen, X } from "@/components/icons";
import { ExtremeIconButton } from "./ExtremeIconButton";
import { useTranslation } from "react-i18next";
import { openExternal } from "@/lib/open-external";
import { RemoteFilePanel } from "@/workbench/views/remote-file/RemoteFilePanel";
import type { RemoteFileEntry } from "@/api/ops-api";
import type { ExtremeAttachment } from "@/stores/extreme-store";

export type WorkspaceTarget =
  | { kind: "directory"; path: string; sessionId: string; serverId?: string | null; revealNonce?: number }
  | { kind: "website"; url: string };

export function RemoteWorkspacePanel({ sessionId, remoteRoot, target, follow, onReset, onClose, onAddRemoteToChat, onError, onPathChange, embedded = false }: {
  /** 嵌在「服务器命令面板」的文件标签里：不要自己的侧栏宽度与边框。 */
  embedded?: boolean;
  sessionId: string;
  remoteRoot: string | null;
  target: WorkspaceTarget | null;
  /**
   * 跟随 Agent 的当前目录（`task.cwd`）。
   *
   * `nonce` 变化时才跳转：同一个目录重复渲染不该把用户手动导航的位置顶掉。
   */
  follow?: { nonce: number; path: string } | null;
  onReset: () => void;
  onClose: () => void;
  /**
   * 附件只由输入区的文件夹组件管理；远程文件面板**不再**在下方重复列一份。
   * 这几个字段保留为可选，调用方不用立刻改签名。
   */
  attachments?: ExtremeAttachment[];
  preview?: string | null;
  onPreview?: (id: string) => void;
  onRemove?: (id: string) => void;
  onAddToChat?: (id: string) => void;
  /** 服务器文件右键「添加到对话」：按绝对路径挂成附件。 */
  onAddRemoteToChat: (entry: RemoteFileEntry) => void;
  onError: (cause: unknown) => void;
  /** 当前目录变化：上层按对话记住，切回来恢复。 */
  onPathChange?: (path: string) => void;
}) {
  const { t } = useTranslation();
  const website = target?.kind === "website" ? target.url : null;
  /*
   * `path` 是面板的**挂载位置**，只由"用户打开的目标 / 上传目录"决定。
   *
   * 它**不包含** Agent 的当前目录：那个每步都在变，放进 key 会让面板每执行
   * 一步就重挂一次（滚动位置、选中项全丢）。跟随只在任务结束时通过
   * `nonce` 触发一次（见 `RemoteFilePanel` 的 follow effect）。
   */
  const path =
    target?.kind === "directory" ? target.path : remoteRoot ?? undefined;
  /** 首次挂载用：没有目标目录时落在 Agent 当前目录，避免先闪一下 home。 */
  const initialPath = path ?? follow?.path;
  const ownerSession = target?.kind === "directory" ? target.sessionId : sessionId;

  return (
    <aside
      className={
        embedded
          ? "flex min-h-0 flex-1 flex-col overflow-hidden"
          : "extreme-core-remote-rail extreme-core-frosted flex w-[340px] shrink-0 flex-col overflow-hidden border-l border-line/70"
      }
      aria-label={t("远程工作区")}
    >
      {/*
       * 嵌入时顶部已经有服务器名和标签栏：这里不再重复「远程文件」标题、
       * 主机行与关闭按钮，正文直接从路径栏开始。
       */}
      {!embedded && (
        <div className="flex items-center gap-2 border-b border-line/70 px-3 py-2">
          <button type="button" className="flex min-w-0 flex-1 items-center gap-1.5 text-left text-12 font-medium" onClick={onReset}>
            <FolderOpen size={14} className="shrink-0" />
            <span className="truncate" title={website ?? path}>{website ? t("返回远程文件") : t("远程文件")}</span>
          </button>
          {website && (
            <ExtremeIconButton
              label={t("在浏览器打开")}
              icon={ExternalLink}
              onClick={() =>
                void openExternal(website, { browser: "chrome" }).then((ok) => {
                  if (!ok) onError(new Error(t("打开浏览器失败")));
                })
              }
            />
          )}
          <ExtremeIconButton
            label={t("收起远程工作区")}
            icon={X}
            iconSize={14}
            side="bottom"
            onClick={onClose}
          />
        </div>
      )}
      {website ? (
        <>
          <p className="truncate border-b border-line/70 px-3 py-1 text-11 text-fg-muted" title={website}>{website}</p>
          <iframe key={website} src={website} title={t("服务预览")} sandbox="allow-scripts allow-forms" referrerPolicy="no-referrer" className="min-h-0 w-full flex-1 border-0 bg-white" />
        </>
      ) : ownerSession !== sessionId ? (
        <p className="p-3 text-12 text-fg-muted">{t("请重新连接任务所属的服务器以浏览此目录。")}</p>
      ) : (
        <div className="extreme-core-remote-files flex min-h-0 flex-1 flex-col overflow-hidden">
          <RemoteFilePanel
            key={JSON.stringify([ownerSession, path ?? ""])}
            embedded={embedded}
            sessionId={ownerSession}
            connected
            /* 跟随 Agent 的 cwd：只在任务结束时 nonce 变一次。 */
            follow={follow ?? { nonce: 0, path: path ?? "/" }}
            initialPath={initialPath}
            reveal={target?.kind === "directory" && target.revealNonce
              ? { nonce: target.revealNonce, path: target.path }
              : undefined}
            onAddToChat={onAddRemoteToChat}
            onPathChange={onPathChange}
            onClose={onClose}
          />
        </div>
      )}
    </aside>
  );
}
