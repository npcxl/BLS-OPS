/**
 * 表单类弹窗 —— 新建 / 编辑的统一外壳。
 *
 * 把四件容易做错、且每个弹窗都会各写一遍的事收在一处：
 * 1. **提交中**：按钮转圈、两个按钮都禁用，Enter 不再触发第二次提交。
 *    调用方必须在 `onSubmit` 里**同步**把 `submitting` 置 true —— 这是防
 *    重复提交的唯一依据（同步置位后，第二个点击到来时按钮已禁用）；
 * 2. **字段校验**：错误贴在字段下方（由调用方用 `<Field error={…}>` 传），
 *    提交失败的整体错误显示在表单底部，不重复弹全局提示；
 * 3. **关闭保护**：有未保存修改时，Esc / × / 取消 先问一句「放弃修改？」，
 *    而不是直接把输入丢掉；
 * 4. **Enter 语义**：单行输入里按 Enter = 提交；多行文本 / 下拉 / 按钮里
 *    Enter 保持原义（换行、选择、点击），绝不误触。
 */
import { useEffect, useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { Loader2 } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { ErrorText, Modal, type ModalSize } from "@/components/ui/modal";
import { toAppError } from "@/lib/app-error";

export interface FormDialogProps {
  open: boolean;
  title: string;
  description?: React.ReactNode;
  size?: ModalSize;
  width?: number;
  submitLabel?: string;
  cancelLabel?: string;
  /** 提交中：按钮转圈并禁用，Esc / 点遮罩都不生效。 */
  submitting?: boolean;
  submitDisabled?: boolean;
  /** 有未保存修改：关闭前确认。 */
  dirty?: boolean;
  /** 覆盖「放弃修改」确认框的文案。 */
  discardTitle?: string;
  discardDescription?: string;
  /** 提交失败的错误对象：显示在表单底部（含阶段与详情）。 */
  error?: unknown;
  onSubmit: () => void;
  onCancel: () => void;
  /** 底栏左侧的附加内容（提示文字等）。 */
  footerExtra?: React.ReactNode;
  children: React.ReactNode;
}

export function FormDialog({
  open,
  title,
  description,
  size = "md",
  width,
  submitLabel,
  cancelLabel,
  submitting = false,
  submitDisabled = false,
  dirty = false,
  discardTitle,
  discardDescription,
  error,
  onSubmit,
  onCancel,
  footerExtra,
  children,
}: FormDialogProps) {
  const { t } = useTranslation();
  const formId = useId();
  const [confirmDiscard, setConfirmDiscard] = useState(false);

  // 关闭弹窗时顺手关掉"放弃修改"的二次确认，避免它跟着下一次打开一起出现。
  useEffect(() => {
    if (!open) setConfirmDiscard(false);
  }, [open]);

  /**
   * 提交闸门。
   *
   * 防重复提交靠的是 `submitting`（调用方在 `onSubmit` 里**同步**置 true）：
   * 第二个点击事件到来前 React 已经把状态刷回界面，按钮已禁用。这里不能再
   * 加"永久闩锁"——一次校验失败（父组件压根没发请求）会让表单再也提交不了。
   * 加了时间窗也一样：用户改完字段马上回车会被无理由吞掉。
   */
  const submit = () => {
    if (submitting || submitDisabled) return;
    onSubmit();
  };

  /** 关闭入口：执行中直接吞掉；有脏数据先确认。 */
  const requestClose = () => {
    if (submitting) return;
    if (dirty) {
      setConfirmDiscard(true);
      return;
    }
    onCancel();
  };

  const errorInfo = error === undefined || error === null ? null : toAppError(error);

  const onKeyDown = (event: React.KeyboardEvent<HTMLFormElement>) => {
    if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
    const target = event.target as HTMLElement | null;
    if (!target) return;
    // 多行文本 / 下拉 / 按钮 / 富文本：Enter 是控件自己的事。
    if (target.closest("textarea, select, button, [contenteditable='true'], [role='combobox']")) return;
    if (!target.closest("input")) return;
    event.preventDefault();
    submit();
  };

  return (
    <>
      <Modal
        open={open}
        title={title}
        description={description}
        size={size}
        width={width}
        onClose={submitting ? undefined : requestClose}
        busy={submitting}
        footer={
          <>
            {footerExtra && <div className="mr-auto min-w-0 text-11 text-fg-subtle">{footerExtra}</div>}
            <Button variant="ghost" size="sm" disabled={submitting} onClick={requestClose}>
              {cancelLabel ?? t("Cancel")}
            </Button>
            <Button
              variant="primary"
              size="sm"
              disabled={submitting || submitDisabled}
              aria-busy={submitting || undefined}
              onClick={submit}
            >
              {submitting && <Loader2 size={12} className="animate-spin" />}
              {submitting ? t("Saving") : (submitLabel ?? t("Save"))}
            </Button>
          </>
        }
      >
        <form
          id={formId}
          className="flex flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
          onKeyDown={onKeyDown}
        >
          {children}
          {errorInfo && (
            <ErrorText detail={errorInfo.detail ?? errorInfo.hint ?? undefined}>
              {errorInfo.outcomeUnknown && (
                <span className="mr-1 font-semibold">{t("Outcome unknown")}:</span>
              )}
              {errorInfo.message}
            </ErrorText>
          )}
        </form>
      </Modal>

      <ConfirmDialog
        open={confirmDiscard}
        risk="danger"
        title={discardTitle ?? t("Discard unsaved changes?")}
        description={
          discardDescription ??
          t("Your input has not been saved. Closing now discards it.")
        }
        confirmLabel={t("Discard and close")}
        onConfirm={() => {
          setConfirmDiscard(false);
          onCancel();
        }}
        onCancel={() => setConfirmDiscard(false)}
      />
    </>
  );
}
