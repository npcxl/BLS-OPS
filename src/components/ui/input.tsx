/**
 * 输入类控件的唯一实现：Input / Textarea / SearchField。
 *
 * # 为什么要收口
 *
 * 之前全仓有 150 多个裸 `<input>`，高度靠各页面自己写（`h-8` / `h-[30px]`
 * / `py-1.5`），结果是同一个工具栏里按钮 28px、输入框 30px、下拉 32px，
 * 三行字基线全不对齐。这里把**高度、边框、圆角、焦点、禁用**全部固定，
 * 业务页面只表达宽度和布局。
 *
 * # 尺寸档位（与 Button、Select 同一套）
 *
 * - `xs` 24 —— 网格内编辑、标签页内联输入
 * - `sm` 28 —— 工具栏、筛选行
 * - `md` 30 —— 表单字段（默认）
 * - `lg` 34 —— 弹窗主输入框
 *
 * 历史样式 `fieldClass` / `selectClass` 仍然导出（很多调用点在用），
 * 但它们现在由这里的同一份基类拼出来，不再各写一套。
 */
import {
  forwardRef,
  type InputHTMLAttributes,
  type ReactNode,
  type TextareaHTMLAttributes,
} from "react";
import { useTranslation } from "react-i18next";
import { Search, X } from "@/components/icons";
import { cn } from "@/lib/cn";

export type ControlSize = "xs" | "sm" | "md" | "lg";

/** 高度档位：Button / Select / Input 共用，改这里就是全应用改。 */
export const CONTROL_HEIGHT: Record<ControlSize, string> = {
  xs: "h-6",
  sm: "h-7",
  md: "h-[30px]",
  lg: "h-[34px]",
};

export const CONTROL_TEXT: Record<ControlSize, string> = {
  xs: "text-11",
  sm: "text-12",
  md: "text-12",
  lg: "text-13",
};

/** 所有输入类控件的共同外观（不含高度与字号）。 */
export const controlBase = cn(
  "w-full min-w-0 rounded-[8px] border bg-surface-1/70 text-fg outline-none",
  "placeholder:text-fg-subtle shadow-[var(--field-shadow)] transition-colors",
  "hover:border-line-strong focus:border-accent focus:ring-1 focus:ring-accent/20",
  "disabled:cursor-not-allowed disabled:opacity-60",
);

export interface InputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "size"> {
  size?: ControlSize;
  /** 字段级校验失败：红边 + `aria-invalid`，错误文案由 `Field` 渲染。 */
  invalid?: boolean;
  /** 左侧图标（如搜索、单位）。 */
  leading?: ReactNode;
  /** 右侧附加内容（单位、清除按钮）。 */
  trailing?: ReactNode;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { size = "md", invalid = false, leading, trailing, className, ...props },
  ref,
) {
  const field = (
    <input
      ref={ref}
      aria-invalid={invalid || undefined}
      className={cn(
        controlBase,
        CONTROL_HEIGHT[size],
        CONTROL_TEXT[size],
        leading ? "pl-7" : "px-2",
        trailing ? "pr-7" : null,
        invalid ? "border-danger/70 focus:border-danger focus:ring-danger/20" : "border-line",
        className,
      )}
      {...props}
    />
  );
  if (!leading && !trailing) return field;
  return (
    <div className="relative flex min-w-0 items-center">
      {leading && (
        <span className="pointer-events-none absolute left-2 flex items-center text-fg-subtle">
          {leading}
        </span>
      )}
      {field}
      {trailing && (
        <span className="absolute right-2 flex items-center text-fg-subtle">{trailing}</span>
      )}
    </div>
  );
});

export interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  size?: ControlSize;
  invalid?: boolean;
  /** 是否允许用户纵向拉伸（默认允许；弹窗里通常关掉以免撑破布局）。 */
  resizable?: boolean;
}

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea(
  { size = "md", invalid = false, resizable = true, className, ...props },
  ref,
) {
  return (
    <textarea
      ref={ref}
      aria-invalid={invalid || undefined}
      className={cn(
        controlBase,
        CONTROL_TEXT[size],
        "px-2 py-1.5 leading-relaxed",
        resizable ? "resize-y" : "resize-none",
        invalid ? "border-danger/70 focus:border-danger focus:ring-danger/20" : "border-line",
        className,
      )}
      {...props}
    />
  );
});

export interface CheckboxProps
  extends Omit<InputHTMLAttributes<HTMLInputElement>, "type" | "size"> {
  /** 与控件并排的说明文字；不传则只渲染方框（由外部 label 负责文案）。 */
  label?: ReactNode;
  size?: "sm" | "md";
}

/**
 * 复选框：**语义保持 `<input type="checkbox">`**（读屏器、表单、Shift 连选
 * 都依赖它），只统一尺寸、强调色、焦点环与禁用态。
 *
 * 与 `Switch` 的分工：多选/批量勾选 → Checkbox；即时开关 → Switch。
 * 两者不能因为外观相似互换，语义完全不同。
 */
export const Checkbox = forwardRef<HTMLInputElement, CheckboxProps>(function Checkbox(
  { label, size = "md", className, disabled, ...props },
  ref,
) {
  const box = (
    <input
      ref={ref}
      type="checkbox"
      disabled={disabled}
      className={cn(
        "shrink-0 cursor-default rounded-[3px] border-line accent-accent",
        "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent",
        "disabled:cursor-not-allowed disabled:opacity-50",
        size === "sm" ? "size-3" : "size-3.5",
        className,
      )}
      {...props}
    />
  );
  if (!label) return box;
  return (
    <label
      className={cn(
        "flex cursor-default items-center gap-1.5 text-12 text-fg",
        disabled && "cursor-not-allowed opacity-60",
      )}
    >
      {box}
      <span className="min-w-0">{label}</span>
    </label>
  );
});

export interface SearchFieldProps
  extends Omit<InputHTMLAttributes<HTMLInputElement>, "size" | "onChange" | "value"> {
  value: string;
  onChange: (value: string) => void;
  size?: ControlSize;
  /** 显示右侧清除按钮（有内容时）。 */
  clearable?: boolean;
  /** 外层宽度类（`w-64` / `flex-1`…），不传则撑满。 */
  containerClassName?: string;
}

/**
 * 搜索框：同一套外观 + 固定图标位置 + 清除按钮。
 *
 * 只用于"过滤列表"的场景。代码搜索、终端、数据网格内的编辑框保持各自实现
 * （它们有自己的按键语义和性能要求），但**外观仍应引用 `controlBase`**。
 */
export function SearchField({
  value,
  onChange,
  size = "sm",
  clearable = true,
  className,
  containerClassName,
  disabled,
  ...props
}: SearchFieldProps) {
  const { t } = useTranslation();
  return (
    <div className={cn("relative flex min-w-0 items-center", containerClassName)}>
      <Search
        size={size === "xs" ? 12 : 13}
        className="pointer-events-none absolute left-2 shrink-0 text-fg-subtle"
        aria-hidden="true"
      />
      <input
        {...props}
        type="search"
        disabled={disabled}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className={cn(
          controlBase,
          CONTROL_HEIGHT[size],
          CONTROL_TEXT[size],
          "border-line pl-7",
          clearable && value ? "pr-7" : "pr-2",
          "[&::-webkit-search-cancel-button]:hidden",
          className,
        )}
      />
      {clearable && value && !disabled && (
        <button
          type="button"
          aria-label={t("清除")}
          className="absolute right-1 flex items-center rounded-full p-0.5 text-fg-subtle hover:bg-surface-hover hover:text-fg"
          onClick={() => onChange("")}
        >
          <X size={11} />
        </button>
      )}
    </div>
  );
}

/**
 * 历史样式（兼容出口）：仍然由同一份基类拼出来。
 * 新代码请直接用 `<Input>` / `<Select>` / `<SearchField>`。
 */
export const fieldClass = cn(
  controlBase,
  CONTROL_HEIGHT.md,
  CONTROL_TEXT.md,
  "border-line px-2",
);

export const selectClass = cn(fieldClass, "ops-select cursor-default !pr-7");

export const selectClassSm = cn(selectClass, "!h-7 w-auto !pr-6 text-11");
