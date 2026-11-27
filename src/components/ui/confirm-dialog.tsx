import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Check, Loader2 } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { ErrorText, Modal, fieldClass } from "@/components/ui/modal";
import { stageLabel, toAppError } from "@/lib/app-error";
import { cn } from "@/lib/cn";

/**
 * 确认对话框的三级风险，对应三种不同的"心理成本"：
 *
 * - `normal`      普通二次确认（关闭未保存的草稿、覆盖一次导出文件）。
 * - `danger`      会丢数据但可重做（删除一行、停止服务）：默认焦点给「取消」。
 * - `irreversible` 不可撤销且影响面大（删除 Key、删除凭据）：额外的警示条 +
 *   后果清单；传了 `confirmPhrase` 时还要求输入对象名才能点确认。
 *
 * 视觉上只用**一条**警示条 + 一个红色按钮表示危险，不做整块大红底 ——
 * 大面积红色会让真正危险的信号变噪音。
 */
export type ConfirmRisk = "normal" | "danger" | "irreversible";

/** 连点保护窗口：双击间隔通常 < 300ms，取 400ms 足够且不挡用户重试。 */
const SUBMIT_GUARD_MS = 400;

/**
 * 确认卡宽度。
 *
 * 参考的 Material 3 确认框只有 320px，中文长句（"将用备份覆盖 /srv/... 并按
 * 当前权限重新核对版本"）会被拆成五六行；这里放到 520px —— 说明仍是一段，
 * 但不会把弹窗拉成竖条。窄窗口由 `max-w-[calc(100vw-32px)]` 兜住。
 */
const CONFIRM_WIDTH = 448;

interface ConfirmDialogProps {
  open: boolean;
  title: string;
  description: React.ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  /** 历史 API：等价于 `risk="danger"`。 */
  danger?: boolean;
  risk?: ConfirmRisk;
  /** 操作执行中：两个按钮都禁用，Esc / 点遮罩不生效，防止重复提交。 */
  pending?: boolean;
  /** 执行失败时留在弹窗里的错误（不再重复弹全局提示）。 */
  error?: unknown;
  /** 后果清单（"该数据库下 32 张表会一并删除"这类），一条一行。 */
  consequences?: string[];
  /**
   * 不可逆操作要求输入的确认词（通常是资源名）。填对之前确认按钮不可用。
   */
  confirmPhrase?: string;
  /** 附加选项（如"同时删除系统凭据管理器里的密钥"）。 */
  children?: React.ReactNode;
  onConfirm: () => void;
  onCancel: () => void;
}

/** Reusable confirmation dialog for destructive or consequential actions. */
export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel,
  cancelLabel,
  danger = false,
  risk,
  pending = false,
  error,
  consequences,
  confirmPhrase,
  children,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const { t } = useTranslation();
  const level: ConfirmRisk = risk ?? (danger ? "danger" : "normal");
  const destructive = level !== "normal";
  const confirmText = confirmLabel ?? t("Confirm");
  const cancelText = cancelLabel ?? t("Cancel");

  /** 输入确认词的本地状态：重新打开时清空，绝不复用上一次的输入。 */
  const [typed, setTyped] = useState("");
  useEffect(() => {
    if (!open) setTyped("");
  }, [open]);

  /**
   * 连点保护：一次确认只执行一次。
   *
   * 用时间窗而不是"永久闩锁"：双击在同一毫秒级内发生，必须吃掉第二次；但
   * 父组件的操作失败后弹窗还开着，用户改完条件要能再试一次 —— 永久闩锁会
   * 让确认按钮彻底失效。
   */
  const lastSubmitAt = useRef(0);
  const phraseOk = !confirmPhrase || typed.trim() === confirmPhrase;
  /** 错误统一走 AppError：结构化错误不再被 String() 成 [object Object]。 */
  const errorInfo = error === undefined || error === null ? null : toAppError(error);

  const submit = () => {
    if (pending || !phraseOk) return;
    const now = Date.now();
    if (now - lastSubmitAt.current < SUBMIT_GUARD_MS) return;
    lastSubmitAt.current = now;
    onConfirm();
  };

  /**
   * Enter = 确认，但**只在安全的地方**：
   * - 焦点在输入框里（且不是那个"输入对象名"的确认框）→ 不响应，
   *   用户在描述里打字按回车不该把库删了；
   * - 焦点在多行文本 / 下拉 / 按钮里 → 交给控件自己处理；
   * - 处理器挂在弹窗内容上，不挂 window：背景里的另一个弹窗收不到。
   */
  const onContentKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
    const target = event.target as HTMLElement | null;
    if (!target) return;
    if (target.closest("textarea, select, [contenteditable='true'], button")) return;
    const inPhraseInput = !!target.closest("[data-confirm-phrase]");
    if (target.closest("input") && !inPhraseInput) return;
    event.preventDefault();
    submit();
  };

  return (
    <Modal
      open={open}
      width={CONFIRM_WIDTH}
      bare
      className="max-w-[calc(100vw-32px)]"
      title={title}
      onClose={pending ? undefined : onCancel}
      busy={pending}
      closeOnBackdrop={!pending}
    >
      <div className="flex flex-col gap-3" onKeyDown={onContentKeyDown}>
        <div className="text-[13.5px] leading-[1.65] break-words text-fg-muted">
          {description}
          {level === "irreversible" && !confirmPhrase && (
            <span className="ml-1 text-fg-subtle">{t("This action cannot be undone.")}</span>
          )}
        </div>

        {level === "irreversible" && confirmPhrase && (
          <p className="text-12 leading-5 text-danger/90">{t("This action cannot be undone.")}</p>
        )}

        {consequences && consequences.length > 0 && (
          <ul className="flex flex-col gap-1 rounded-xl border border-line/55 bg-surface-2/55 px-3.5 py-2.5 text-12 leading-5 text-fg-muted">
            {consequences.map((item) => (
              <li key={item} className="flex items-start gap-2 break-words">
                <span
                  aria-hidden="true"
                  className={cn(
                    "mt-2 size-1 shrink-0 rounded-full",
                    level === "irreversible" ? "bg-danger/70" : "bg-fg-subtle/70",
                  )}
                />
                <span className="min-w-0 flex-1">{item}</span>
              </li>
            ))}
          </ul>
        )}

        {children}

        {confirmPhrase && (
          <label className="flex flex-col gap-1.5 rounded-xl border border-line/55 bg-surface-2/45 p-3">
            <div className="flex items-center justify-between gap-2 text-11 text-fg-muted">
              <span className="min-w-0 break-words">
                {t("Type {{phrase}} to confirm", { phrase: confirmPhrase })}
              </span>
              {phraseOk && (
                <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-success/12 px-1.5 py-0.5 text-10 font-medium text-success">
                  <Check size={10} strokeWidth={2.5} />
                </span>
              )}
            </div>
            <div className="flex items-center gap-1.5">
              <code className="select-text rounded-md border border-line/65 bg-surface-1 px-1.5 py-0.5 font-mono text-11 text-fg">
                {confirmPhrase}
              </code>
            </div>
            <input
              className={cn(
                fieldClass,
                "font-mono text-12 transition-colors",
                phraseOk && typed.length > 0 && "border-success/60 focus:border-success",
              )}
              data-confirm-phrase
              value={typed}
              placeholder={confirmPhrase}
              autoComplete="off"
              spellCheck={false}
              onChange={(event) => setTyped(event.target.value)}
            />
          </label>
        )}

        {error !== undefined && error !== null && errorInfo && (
          <ErrorText detail={errorInfo.detail ?? errorInfo.hint ?? undefined}>
            {errorInfo.stage && (
              <span className="mr-1 font-medium">{stageLabel(errorInfo.stage)}</span>
            )}
            {errorInfo.message}
          </ErrorText>
        )}

        {/* 按钮沿用项目统一 ghost 风格：静息无底色无描边，悬停才浮出底色。 */}
        <div className="mt-3 flex items-center justify-end gap-2">
          <Button
            variant="ghost"
            size="sm"
            disabled={pending}
            data-autofocus={destructive ? true : undefined}
            onClick={onCancel}
          >
            {cancelText}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            disabled={pending || !phraseOk}
            aria-busy={pending || undefined}
            data-autofocus={destructive ? undefined : true}
            onClick={submit}
            className={
              destructive
                ? "text-danger hover:bg-danger/12 hover:text-danger"
                : "text-accent hover:bg-accent/12 hover:text-accent"
            }
          >
            {pending && <Loader2 size={12} className="animate-spin" />}
            {pending ? t("Processing") : confirmText}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
