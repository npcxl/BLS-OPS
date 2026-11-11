import { Fragment, useId, type HTMLAttributes, type ReactNode, type Ref } from "react";
import { cn } from "@/lib/cn";

/**
 * Page skeleton primitives. Presentation only — connection, transaction, dirty
 * and task state stay with the page that owns them.
 *
 * Page types compose these primitives:
 *   1. Overview     PageSurface → PageHeader → PageScroll(width="overview")
 *   2. Management   PageSurface → PageToolbar → PageTabs? → PageScroll
 *   3. Workspace    PageSurface → PageToolbar? → PageWorkspace (panes scroll)
 *   4. Detail       PageSurface → PageHeader → PageTabs → PageScroll
 *   5. Settings     PageSurface → PageHeader → PageScroll(width="reading") with PageSection
 *   6. Overlay      Modal, or page-overlay-* for independent windows / previews
 *
 * Do not bind these to a specific SSH session or database store: pages adapt
 * their own state and pass plain nodes in.
 */

export type PageWidth = "full" | "overview" | "reading";

export function PageSurface({ className, children, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div {...props} className={cn("page-surface", className)}>
      {children}
    </div>
  );
}

export function PageHeader({
  title,
  description,
  context,
  actions,
  bordered = false,
  titleId,
  className,
}: {
  title: ReactNode;
  description?: ReactNode;
  /** Connection, server or object name — one fixed slot instead of repeating it. */
  context?: ReactNode;
  actions?: ReactNode;
  bordered?: boolean;
  titleId?: string;
  className?: string;
}) {
  return (
    <header className={cn("page-header", bordered && "page-header--bordered", className)}>
      <div className="page-heading">
        <h1 id={titleId} className="page-title">
          {title}
        </h1>
        {description && <p className="page-description">{description}</p>}
        {context && <div className="page-context">{context}</div>}
      </div>
      {actions && <div className="page-actions">{actions}</div>}
    </header>
  );
}

/**
 * The module's controls: filters and primary actions on one fixed-height row,
 * a secondary row for filter bars. The object name lives in the page header or
 * work tab, never repeated here.
 */
export function PageToolbar({
  variant = "primary",
  overflowVisible = false,
  className,
  children,
  ...props
}: HTMLAttributes<HTMLDivElement> & {
  variant?: "primary" | "secondary";
  /** Search suggestions anchored inside the bar need to escape its bounds. */
  overflowVisible?: boolean;
}) {
  return (
    <div
      {...props}
      className={cn(
        "page-toolbar",
        variant === "secondary" && "page-toolbar--secondary",
        overflowVisible && "page-toolbar--overflow",
        className,
      )}
    >
      {children}
    </div>
  );
}

export interface PageTab<T extends string> {
  id: T;
  label: ReactNode;
  /** Optional leading glyph; the label stays the accessible name. */
  icon?: ReactNode;
  count?: number;
  disabled?: boolean;
  /** Draw a divider before this tab to separate groups (e.g. basic vs advanced). */
  divider?: boolean;
}

/**
 * Object categories: switches between contents of the same object.
 * Not work tabs (those close/pin and live in `WorkspaceTabs`), not segmented
 * controls (those switch a display mode — use `variant="segmented"`).
 */
export function PageTabs<T extends string>({
  value,
  onChange,
  items,
  label,
  panelId,
  variant = "tabs",
  trailing,
  className,
}: {
  value: T;
  onChange: (value: T) => void;
  items: readonly PageTab<T>[];
  label: string;
  panelId: string;
  variant?: "tabs" | "segmented";
  /** Low-frequency page actions belong at the end of the category row. */
  trailing?: ReactNode;
  className?: string;
}) {
  const instance = useId();
  return (
    <div
      className={cn("page-tabs", variant === "segmented" && "page-tabs--segmented", className)}
      role="tablist"
      aria-label={label}
    >
      {items.map((item) => (
        <Fragment key={item.id}>
          {item.divider && <span aria-hidden="true" className="page-tabs__divider" />}
          <button
            id={`${instance}-${item.id}`}
            type="button"
            role="tab"
            aria-selected={value === item.id}
            aria-controls={panelId}
            disabled={item.disabled}
            tabIndex={value === item.id ? 0 : -1}
            onClick={() => onChange(item.id)}
            onKeyDown={(event) => {
              if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
              const enabled = items.filter((tab) => !tab.disabled);
              const current = enabled.findIndex((tab) => tab.id === item.id);
              const index =
                event.key === "Home"
                  ? 0
                  : event.key === "End"
                    ? enabled.length - 1
                    : (current + (event.key === "ArrowRight" ? 1 : -1) + enabled.length) % enabled.length;
              const next = enabled[index];
              if (!next) return;
              event.preventDefault();
              onChange(next.id);
              document.getElementById(`${instance}-${next.id}`)?.focus();
            }}
          >
            {item.icon}
            {item.label}
            {item.count !== undefined && <span className="page-tab-count">{item.count}</span>}
          </button>
        </Fragment>
      ))}
      {trailing && <div className="page-tabs__trailing">{trailing}</div>}
    </div>
  );
}

export interface SegmentedItem<T extends string> {
  id: T;
  label: ReactNode;
  disabled?: boolean;
}

/**
 * Mutually exclusive display modes (filters, row views, theme choice). It is
 * not a tab list: no panel is controlled and the state is a single value.
 */
export function SegmentedControl<T extends string>({
  value,
  onChange,
  items,
  label,
  className,
}: {
  value: T;
  onChange: (value: T) => void;
  items: readonly SegmentedItem<T>[];
  label: string;
  className?: string;
}) {
  return (
    <div className={cn("page-segmented", className)} role="group" aria-label={label}>
      {items.map((item) => (
        <button
          key={item.id}
          type="button"
          aria-pressed={value === item.id}
          disabled={item.disabled}
          onClick={() => onChange(item.id)}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}

/** Thin divider between toolbar groups. */
export function PageToolbarDivider() {
  return <span aria-hidden="true" className="page-toolbar-divider" />;
}

/**
 * The page's single scroll owner. `width` caps reading/overview pages; dense
 * workspaces pass `padded={false}` or use `PageWorkspace` instead.
 */
export function PageScroll({
  width = "full",
  padded = true,
  className,
  children,
  viewportRef,
  ...props
}: HTMLAttributes<HTMLDivElement> & {
  width?: PageWidth;
  padded?: boolean;
  viewportRef?: Ref<HTMLDivElement>;
}) {
  return (
    <div {...props} ref={viewportRef} className={cn("page-scroll ops-scroll", className)}>
      {padded ? (
        <div className={cn("page-content", width !== "full" && `page-content--${width}`)}>{children}</div>
      ) : (
        children
      )}
    </div>
  );
}

/** No scroll owner here: every pane inside owns its own scrolling. */
export function PageWorkspace({
  row = false,
  className,
  children,
  ...props
}: HTMLAttributes<HTMLDivElement> & { row?: boolean }) {
  return (
    <div {...props} className={cn("page-workspace", row && "page-workspace--row", className)}>
      {children}
    </div>
  );
}

/** A titled group inside a page: settings groups, overview sections, details. */
export function PageSection({
  title,
  description,
  actions,
  className,
  children,
}: {
  title?: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  return (
    <section className={cn("page-section", className)}>
      {(title || actions) && (
        <div className="page-section-header">
          <div className="page-section-heading">
            {title && <h2 className="page-section-title">{title}</h2>}
            {description && <p className="page-section-description">{description}</p>}
          </div>
          {actions && <div className="page-actions">{actions}</div>}
        </div>
      )}
      {children}
    </section>
  );
}

/**
 * Contextual feedback in one fixed slot. Errors stay where they matter, and the
 * retry action stays reachable even in a narrow workspace.
 */
export function PageNotice({
  children,
  action,
  tone = "neutral",
  icon,
  className,
  centered = false,
}: {
  children: ReactNode;
  action?: ReactNode;
  tone?: "neutral" | "info" | "warning" | "danger";
  icon?: ReactNode;
  className?: string;
  /** 图标 / 文案 / 动作整体居中（连接失败这类单句通知）。 */
  centered?: boolean;
}) {
  return (
    <div
      role={tone === "danger" ? "alert" : "status"}
      className={cn(
        "page-notice",
        tone !== "neutral" && `page-notice--${tone}`,
        centered && "page-notice--centered",
        className,
      )}
    >
      {icon}
      <div className="page-notice__message">{children}</div>
      {action && <div className="page-actions">{action}</div>}
    </div>
  );
}

export function PageStatusBar({ className, children, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div {...props} className={cn("page-statusbar", className)}>
      {children}
    </div>
  );
}

export function PageInspector({
  className,
  children,
  ...props
}: HTMLAttributes<HTMLElement>) {
  return (
    <aside {...props} className={cn("page-inspector", className)}>
      {children}
    </aside>
  );
}

export function PageInspectorHeader({ children, actions }: { children: ReactNode; actions?: ReactNode }) {
  return (
    <div className="page-inspector__header">
      <div className="min-w-0 flex-1 truncate">{children}</div>
      {actions && <div className="page-actions">{actions}</div>}
    </div>
  );
}
