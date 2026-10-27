import { useEffect } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { X } from "lucide-react";
import { cn } from "@/lib/cn";
import { useExiting } from "@/hooks/use-exiting";

interface ModalProps {
  open: boolean;
  title: string;
  description?: string;
  width?: number;
  onClose?: () => void;
  footer?: React.ReactNode;
  children: React.ReactNode;
}

/** Centered dialog used for host-key confirmation and entity forms. */
export function Modal({ open, title, description, width = 360, onClose, footer, children }: ModalProps) {
  const { render, exiting } = useExiting(open, 150);
  const { t } = useTranslation();

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose?.();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, onClose]);

  if (!render) return null;

  return createPortal(
    <div
      className={cn(
        "fixed inset-0 z-[130] flex items-center justify-center bg-black/24 px-4",
        exiting ? "opacity-0 transition-opacity duration-150" : "overlay-scrim",
      )}
      onMouseDown={onClose}
      // 浮层内的右键不能穿透到触发它的列表 / 卡片：React 的合成事件沿
      // **组件树**冒泡，portal 到 body 也照样能传到外层 `onContextMenu`，
      // 用户就会在弹窗里右键弹出下面卡片的菜单。
      onContextMenu={(event) => event.stopPropagation()}
    >
      <div
        className={cn(
          "glass-panel-strong max-h-[85vh] overflow-hidden rounded-[18px]",
          exiting
            ? "opacity-0 translate-y-2 scale-[0.985] transition-[opacity,transform] duration-150 ease-out"
            : "overlay-enter",
        )}
        style={{ width }}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="flex items-start gap-2 border-b border-line px-4 py-3">
          <div className="min-w-0 flex-1">
            <h2 className="text-13 font-semibold text-fg">{title}</h2>
            {description && <p className="mt-0.5 text-11 leading-relaxed text-fg-muted">{description}</p>}
          </div>
          {onClose && (
            <button
              type="button"
              aria-label={t("Close")}
              className="rounded-[5px] p-1 text-fg-subtle hover:bg-surface-hover hover:text-fg"
              onClick={onClose}
            >
              <X size={14} />
            </button>
          )}
        </div>

        <div className="max-h-[60vh] overflow-y-auto px-4 py-3">{children}</div>

        {footer && <div className="flex justify-end gap-2 border-t border-line px-4 py-3">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}

export const fieldClass =
  "h-[30px] w-full rounded-[8px] border border-line bg-surface-1/70 px-2 text-12 text-fg outline-none placeholder:text-fg-subtle shadow-[var(--field-shadow)] transition-colors hover:border-line-strong focus:border-accent disabled:opacity-60";

/**
 * 下拉框：与输入框同一套表面，但箭头换成自绘的（见 globals.css 的
 * `.ops-select`）。右侧留 26px 给箭头，文字不会压上去；`!` 是因为
 * `fieldClass` 已经带了 `px-2`，必须显式覆盖右侧内边距。
 */
export const selectClass = cn(fieldClass, "ops-select cursor-default !pr-7");

/** 工具栏 / 行内的紧凑下拉：与 selectClass 同一套外观，24px 高。 */
export const selectClassSm = cn(selectClass, "h-[24px] w-auto !pr-6 text-11");

export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-11 font-medium text-fg-muted">{label}</span>
      {children}
      {hint && <span className="text-11 leading-relaxed text-fg-subtle">{hint}</span>}
    </label>
  );
}

export function ErrorText({ children }: { children: React.ReactNode }) {
  if (!children) return null;
  return (
    <p className="rounded-[8px] border border-danger/30 bg-danger/10 px-2 py-1.5 text-11 leading-relaxed text-danger">
      {children}
    </p>
  );
}
