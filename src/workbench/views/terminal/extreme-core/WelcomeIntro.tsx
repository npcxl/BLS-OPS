import { useState } from "react";
import { useTranslation } from "react-i18next";
import { FolderOpen } from "@/components/icons";
import { Button } from "@/components/ui/button";
import type { ExtremeAttachment } from "@/stores/extreme-store";
import { foldersToAttachments, pickWorkspaceFolders } from "./folder-import";
import { EC } from "./theme";

export interface WelcomeIntroProps {
  /** 已进入工作区、但还没有对话也没有计划。 */
  attachmentCount: number;
  /** 已上传到服务器临时目录的根路径（有值时不再提示上传）。 */
  remoteRoot: string | null;
  uploading: boolean;
  onUpload: () => void;
  onGeneratePlan: () => void;
  /**
   * 选了本机文件夹：把读到的附件塞进当前任务。
   *
   * 只是**可选**入口 —— 空着进来直接说话同样可以开始，AI 会在服务器上自己
   * 探测，不需要先准备文件。
   */
  onImportFolders: (folders: string[], attachments: ExtremeAttachment[]) => void;
}

/**
 * 欢迎态：首屏说明 + 「附件已就绪」的下一步。
 *
 * 有附件时直接告诉用户走到了哪一步并给出按钮 —— 只写一句"上传文件或描述
 * 任务"等于把判断留给用户。纯展示，动作全部回调。
 */
export function WelcomeIntro({
  attachmentCount,
  remoteRoot,
  uploading,
  onUpload,
  onGeneratePlan,
  onImportFolders,
}: WelcomeIntroProps) {
  const { t } = useTranslation();
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState(false);

  const chooseFolder = async () => {
    if (importing) return;
    setImporting(true);
    setError(false);
    try {
      const picked = await pickWorkspaceFolders();
      if (picked.length === 0) return;
      const attachments = await foldersToAttachments(picked, t);
      onImportFolders(picked.map((folder) => folder.folder), attachments);
    } catch {
      setError(true);
    } finally {
      setImporting(false);
    }
  };

  return (
    <div className="extreme-core-intro">
      <h1>{t("下一步，交给超能。")}</h1>
      <p>{t("上传项目文件，或描述你想在这台服务器上完成的任务。")}</p>
      {/* 文件夹是**可选**：空着进来直接说「看看这台机器」也能开始。 */}
      <div className="mt-3 flex flex-col items-center gap-1.5">
        <Button variant="ghost" size="sm" disabled={importing} onClick={() => void chooseFolder()}>
          <FolderOpen size={14} />
          {importing ? t("读取中…") : t("选择本机文件夹（可选）")}
        </Button>
        {error && (
          <p role="alert" className="text-11 text-danger">
            {t("无法读取所选文件夹")}
          </p>
        )}
      </div>
      {attachmentCount > 0 && (
        <div className="mt-3 flex flex-col items-center gap-2">
          <p className="text-11" style={{ color: EC.fgMuted }}>
            {remoteRoot
              ? t("{{n}} 个文件已上传到临时目录，可以直接生成部署计划。", { n: attachmentCount })
              : t("{{n}} 个文件已就绪，先上传到服务器或直接生成计划。", { n: attachmentCount })}
          </p>
          <div className="flex items-center gap-2">
            {!remoteRoot && (
              <Button variant="secondary" size="sm" disabled={uploading} onClick={onUpload}>
                {uploading ? t("上传中…") : t("上传到服务器")}
              </Button>
            )}
            <Button variant="primary" size="sm" onClick={onGeneratePlan}>
              {t("生成部署计划")}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
