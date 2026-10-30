import { useCallback, useEffect, useId, useRef } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { X } from "@/components/icons";
import { cn } from "@/lib/cn";
import { useExiting } from "@/hooks/use-exiting";
import {
  isTopOverlayLayer,
  OverlayDepthContext,
  useOverlayLayer,
} from "@/components/ui/overlay";

/**
 * 模态框尺寸档位（统一视觉，别再各写各的 width）。
 *
 * - `sm` 360：确认 / 破坏性操作
 * - `md` 480：单列表单、小面板
 * - `lg` 640：连接、导入导出这类多字段表单
 * - `xl` 860：编辑器、详情
 * - `full` 96vw / 1100：超大表格
 *
 * `width` 仍可覆盖（历史调用点用的是具体像素）。
 */
export type ModalSize = "sm" | "md" | "lg" | "xl" | "full";

const SIZE_WIDTH: Record<ModalSize, number | string> = {
  sm: 360,
  md: 480,
  lg: 640,
  xl: 860,
  full: "min(1100px, 96vw)",
};

const FOCUSABLE =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** 打开时优先聚焦的输入控件（表单弹窗不该从右上角的 × 开始）。 */
const FIELD_SELECTOR =
  'input:not([disabled]):not([type="hidden"]), textarea:not([disabled]), select:not([disabled])';

interface ModalProps {
  open: boolean;
  title: React.ReactNode;
  description?: React.ReactNode;
  /** 历史 API：具体像素宽度，优先于 `size`。 */
  width?: number;
  size?: ModalSize;
  /**
   * 关闭入口。`undefined` = 不可关闭（保存中 / 执行中），此时 Esc 与点遮罩
   * 都不会生效，但会被**吞掉**，不会穿透去关掉下层的弹窗。
   */
  onClose?: () => void;
  footer?: React.ReactNode;
  /** 执行中：禁止 Esc / 点遮罩关闭，并给读屏器 aria-busy。 */
  busy?: boolean;
  /** 是否允许点遮罩关闭（默认允许；表单类建议关掉以免误触丢输入）。 */
  closeOnBackdrop?: boolean;
  children: React.ReactNode;
}

/**
 * 居中模态框 —— 全项目唯一的对话框实现。
 *
 * 交互契约（与成熟桌面客户端对齐）：
 * - Esc **只关最上层**（靠 OverlayManager 的打开栈判断），且内部控件已处理过
 *   的 Esc（如编辑器里的查找框）不会被抢走；
 * - 打开时记住原来的焦点，关闭后还回去；Tab 在弹窗内循环，不跑到背后的列表；
 * - 点遮罩关闭，但点面板内部不会（右键菜单也不会穿透）；
 * - `role="dialog" aria-modal="true"`，标题与描述通过 id 关联。
 */
export function Modal({
  open,
  title,
  description,
  width,
  size = "md",
  onClose,
  footer,
  busy = false,
  closeOnBackdrop = true,
  children,
}: ModalProps) {
  const { render, exiting } = useExiting(open, 150);
  const { t } = useTranslation();
  const titleId = useId();
  const descriptionId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  /** 浮层身份与层级：内层弹窗自动 +1 层，Esc 只归最内层。 */
  const layer = useOverlayLayer(open, "modal");

  /** 关闭请求：busy 时吞掉，绝不误关。 */
  const requestClose = useCallback(() => {
    if (busy || !onClose) return;
    onClose();
  }, [busy, onClose]);

  /** 打开：记住并迁移焦点；关闭：归还焦点（浮层出栈由 useOverlayLayer 负责）。 */
  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;

    // 等面板真正挂载后再入焦点：优先 [data-autofocus]，其次第一个输入框
    // （表单弹窗直接开始填写），再次第一个可聚焦元素，最后聚焦面板本身
    // （读屏器会朗读标题）。焦点永远不会掉在背后的页面上。
    const frame = window.requestAnimationFrame(() => {
      const panel = panelRef.current;
      if (!panel) return;
      const preferred =
        panel.querySelector<HTMLElement>("[data-autofocus]") ??
        panel.querySelector<HTMLElement>(FIELD_SELECTOR) ??
        panel.querySelector<HTMLElement>(FOCUSABLE);
      (preferred ?? panel).focus({ preventScroll: true });
    });

    return () => {
      window.cancelAnimationFrame(frame);
      // 焦点还回去：只还原仍然挂在文档里的元素（触发它的按钮可能已卸载）。
      if (previous && previous.isConnected) previous.focus({ preventScroll: true });
    };
  }, [open]);

  /** Esc：只处理最上层；Tab：在面板内循环；两者都不抢内部已消费的事件。 */
  useEffect(() => {
    if (!open) return;
    const layerId = layer.id;

    const onKeyDown = (event: KeyboardEvent) => {
      if (!isTopOverlayLayer(layerId)) return;
      // 内部控件（编辑器查找框、下拉、右键菜单）已经处理过：让位。
      if (event.defaultPrevented) return;

      if (event.key === "Escape") {
        event.preventDefault();
        requestClose();
        return;
      }

      if (event.key !== "Tab") return;
      const panel = panelRef.current;
      if (!panel) return;
      const focusable = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
        (node) => !node.hasAttribute("hidden") && node.getAttribute("aria-hidden") !== "true",
      );
      if (focusable.length === 0) {
        event.preventDefault();
        panel.focus({ preventScroll: true });
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;
      if (event.shiftKey) {
        if (active === first || !panel.contains(active)) {
          event.preventDefault();
          last.focus();
        }
        return;
      }
      if (active === last || !panel.contains(active)) {
        event.preventDefault();
        first.focus();
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, requestClose]);

  if (!render) return null;

  return createPortal(
    <div
      className={cn(
        "fixed inset-0 flex items-center justify-center bg-black/24 px-4",
        exiting ? "opacity-0 transition-opacity duration-150" : "overlay-scrim",
      )}
      style={{ zIndex: layer.zIndex }}
      onMouseDown={(event) => {
        if (event.target !== event.currentTarget) return;
        if (!closeOnBackdrop) return;
        requestClose();
      }}
      // 浮层内的右键不能穿透到触发它的列表 / 卡片：React 的合成事件沿
      // **组件树**冒泡，portal 到 body 也照样能传到外层 `onContextMenu`，
      // 用户就会在弹窗里右键弹出下面卡片的菜单。
      onContextMenu={(event) => event.stopPropagation()}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descriptionId : undefined}
        aria-busy={busy || undefined}
        tabIndex={-1}
        className={cn(
          "glass-panel-strong flex max-h-[85vh] flex-col overflow-hidden rounded-[14px] outline-none",
          exiting
            ? "opacity-0 translate-y-2 scale-[0.985] transition-[opacity,transform] duration-150 ease-out"
            : "overlay-enter",
        )}
        style={{ width: width ?? SIZE_WIDTH[size] }}
      >
        <div className="flex items-start gap-2 border-b border-line px-4 py-3">
          <div className="min-w-0 flex-1">
            <h2 id={titleId} className="text-13 font-semibold text-fg">
              {title}
            </h2>
            {description && (
              <p id={descriptionId} className="mt-0.5 text-11 leading-relaxed text-fg-muted">
                {description}
              </p>
            )}
          </div>
          {onClose && (
            <button
              type="button"
              aria-label={t("Close")}
              aria-disabled={busy || undefined}
              className={cn(
                "shrink-0 rounded-[5px] p-1 text-fg-subtle hover:bg-surface-hover hover:text-fg",
                busy && "pointer-events-none opacity-40",
              )}
              onClick={requestClose}
            >
              <X size={14} />
            </button>
          )}
        </div>

        {/* 弹窗内部再开的浮层深度 +1：Esc 先给它，层级也压在上面。 */}
        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
          <OverlayDepthContext.Provider value={layer.childDepth}>
            {children}
          </OverlayDepthContext.Provider>
        </div>

        {footer && (
          <div className="flex shrink-0 items-center justify-end gap-2 border-t border-line px-4 py-3">
            {footer}
          </div>
        )}
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

/**
 * 表单字段：标签 + 控件 + 提示 + 字段级校验错误。
 *
 * 校验错误必须贴在字段下方（`error`），不要塞进页面顶部的错误条 ——
 * 用户改完一个字段再滚回顶部找原因的体验是灾难。
 */
export function Field({
  label,
  hint,
  error,
  required,
  htmlFor,
  children,
}: {
  label: string;
  hint?: string;
  error?: string | null;
  required?: boolean;
  htmlFor?: string;
  children: React.ReactNode;
}) {
  const invalid = !!error;
  return (
    <label htmlFor={htmlFor} className="flex flex-col gap-1">
      <span className="flex items-center gap-1 text-11 font-medium text-fg-muted">
        {label}
        {required && (
          <span className="text-danger" aria-hidden="true">
            *
          </span>
        )}
      </span>
      {children}
      {invalid && (
        <span role="alert" className="break-words text-11 leading-relaxed text-danger">
          {error}
        </span>
      )}
      {!invalid && hint && <span className="text-11 leading-relaxed text-fg-subtle">{hint}</span>}
    </label>
  );
}

/**
 * 就地错误块：表单里的一次性错误（不是字段校验）。
 *
 * 长错误（后端原文、SQL 报错）必须能换行且限高滚动，绝不能把弹窗撑出屏幕。
 */
export function ErrorText({
  children,
  detail,
  className,
}: {
  children?: React.ReactNode;
  detail?: React.ReactNode;
  className?: string;
}) {
  if (!children && !detail) return null;
  return (
    <div
      role="alert"
      className={cn(
        "max-h-40 overflow-y-auto rounded-[8px] border border-danger/30 bg-danger/10 px-2 py-1.5 text-11 leading-relaxed break-words text-danger",
        className,
      )}
    >
      {children}
      {detail && <p className="mt-1 break-words text-10 opacity-80">{detail}</p>}
    </div>
  );
}
