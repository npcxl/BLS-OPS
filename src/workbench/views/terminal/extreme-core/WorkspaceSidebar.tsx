import type { ExtremeAttachment } from "@/stores/extreme-store";
import { RemoteFilePanel } from "@/workbench/views/remote-file/RemoteFilePanel";
import { AttachmentTree } from "./AttachmentTree";

export interface WorkspaceSidebarProps {
  /** 已上传到服务器时显示服务器的临时目录；否则显示本机附件树。 */
  remoteRoot: string | null;
  sessionId: string | null;
  attachments: ExtremeAttachment[];
  /** 当前高亮的附件（本地或服务器文件）。 */
  previewId: string | null;
  onPreview: (id: string) => void;
  onRemove: (id: string) => void;
  onAddToChat: (id: string) => void;
  /** 退出远程目录浏览，回到本机附件树。 */
  onCloseRemote: () => void;
}

/**
 * 工作区左栏：本机附件树 ↔ 服务器临时目录。
 *
 * 两个来源共用同一套预览入口（`FilePreviewModal`）：远程面板自己带预览，
 * 本机附件树通过 `onPreview` 交给页面统一打开，所以"本地 / 远程"在用户眼里
 * 是同一个动作。
 */
export function WorkspaceSidebar({
  remoteRoot,
  sessionId,
  attachments,
  previewId,
  onPreview,
  onRemove,
  onAddToChat,
  onCloseRemote,
}: WorkspaceSidebarProps) {
  if (remoteRoot && sessionId) {
    return (
      <RemoteFilePanel
        sessionId={sessionId}
        connected
        /* 超能不跟随终端 `cd`：固定停在上传目录。 */
        follow={{ nonce: 0, path: remoteRoot }}
        initialPath={remoteRoot}
        onClose={onCloseRemote}
      />
    );
  }

  return (
    <AttachmentTree
      attachments={attachments}
      preview={previewId}
      onPreview={onPreview}
      onRemove={onRemove}
      onAddToChat={onAddToChat}
    />
  );
}
