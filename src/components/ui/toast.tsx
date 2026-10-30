/**
 * 全局提示（toast / alert）。
 *
 * 两种形态，按"用户会不会漏看"来分：
 * - `error` / `warning` → 屏幕**顶部居中**的提醒条。错误默认常驻（点 × 才消失），
 *   长文本整段换行显示，带阶段标签、详情、重试与复制。错误缩在右下角一闪而过
 *   等于没提示 —— 用户那时往往正盯着左边的树或表单，根本不会往角落看。
 * - `info` / `success` → 右下角轻提示，几秒后自动消失。
 *
 * 任何地方 `pushToast("...", "error", { label: "auth", detail })` 即可，
 * 不需要往组件树里层层传 props。结构化错误用 `pushErrorToast(cause, …)`，
 * 它负责把 `{ stage, message, detail, retryable }` 摊平成可读的三层信息。
 */
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import LiquidGlass from "liquid-glass-react";
import type { AnimatedIconHandle } from "@/components/icons";
import {
  Check,
  CheckCircle2,
  ChevronDown,
  Copy,
  Info,
  Loader2,
  RotateCcw,
  X,
} from "@/components/icons";
// 直接取 itshover 原件而非 `@/components/icons` 里的别名：只有原件才恰好暴露
// `AnimatedIconHandle`，弹出时才能主动触发一次动画（别名被收敛成 ComponentType，
// ref 拿不到 startAnimation）。
import TriangleAlertIcon from "@/components/its-hover/triangle-alert-icon";
import { Button } from "@/components/ui/button";
import { OVERLAY_Z } from "@/components/ui/overlay";
import { cn } from "@/lib/cn";
import { copyText } from "@/lib/clipboard";
import { canRetry, formatErrorForCopy, stageLabel, toAppError } from "@/lib/app-error";

export type ToastTone = "info" | "success" | "warning" | "error";

export interface ToastAction {
  /** 按钮文案（已翻译）。 */
  label: string;
  onClick: () => void;
  /** 执行中：按钮转圈并禁用（后台任务重试用）。 */
  busy?: boolean;
}

export interface ToastOptions {
  /** 第一行的小标题，例如「订单库 · 连接失败」。 */
  title?: string;
  /** 小标签，例如错误阶段（auth / tcp / tls / ssh_tunnel）。 */
  label?: string;
  /** 第二行详情：后端原始报错、主机端口等，完整换行不截断。 */
  detail?: string;
  /** `false` 表示自动消失（默认 error 常驻，其余自动消失）。 */
  persist?: boolean;
  /** 结果未知：显式标注「结果未知」，禁止被当成失败或成功。 */
  outcomeUnknown?: boolean;
  /** 供「复制错误信息」使用的原文；不给则用 message + label + detail 拼。 */
  copyText?: string;
  /** 额外操作（重试等）。 */
  actions?: ToastAction[];
}

interface ToastItem {
  id: string;
  message: string;
  tone: ToastTone;
  title?: string;
  label?: string;
  detail?: string;
  persist: boolean;
  outcomeUnknown?: boolean;
  copyText?: string;
  actions?: ToastAction[];
}

/** 错误最多堆 3 条、轻提示 2 条：够看见，又不至于糊满屏幕。 */
const MAX_ALERTS = 3;
const MAX_NOTES = 2;
/** 错误默认常驻；临时性错误（扫描失败之类）显式 persist:false，给 8s。 */
const ERROR_TTL_MS = 8000;
const NOTE_TTL_MS = 3200;
/** 详情超过这个长度就折叠，避免一条提示占掉半个屏幕。 */
const DETAIL_COLLAPSE_AT = 160;

let items: ToastItem[] = [];
const listeners = new Set<(next: ToastItem[]) => void>();

const emit = () => {
  const next = [...items];
  for (const listener of listeners) listener(next);
};

export function dismissToast(id: string): void {
  items = items.filter((item) => item.id !== id);
  emit();
}

/**
 * 一次清空所有提示。
 *
 * 用途：切换工作区 / 断开全部会话时把上一轮的残留收掉 —— 也顺便让测试
 * 不必靠 `vi.resetModules()` 重载模块（共享 worker 里那招会让动态 import
 * 与已渲染的组件拿到两份模块状态）。
 */
export function clearToasts(): void {
  items = [];
  emit();
}

/** 同一条提示的指纹：标题 + 文案 + 详情都相同才算重复。 */
function fingerprint(item: Pick<ToastItem, "tone" | "message" | "title" | "detail">): string {
  return [item.tone, item.title ?? "", item.message, item.detail ?? ""].join("\u0000");
}

/**
 * 弹一条提示。
 *
 * 完全相同的一条已经在屏幕上时不再堆叠（用户连点几次「重试」失败时，
 * 屏幕上只留一条而不是一墙）。
 */
export function pushToast(
  message: string,
  tone: ToastTone = "info",
  options: ToastOptions = {},
): void {
  const persist = options.persist ?? tone === "error";
  const next: ToastItem = {
    id: crypto.randomUUID(),
    message,
    tone,
    title: options.title,
    label: options.label,
    detail: options.detail,
    persist,
    outcomeUnknown: options.outcomeUnknown,
    copyText: options.copyText,
    actions: options.actions,
  };

  const key = fingerprint(next);
  const duplicate = items.find((item) => fingerprint(item) === key);
  if (duplicate) {
    // 已存在：把它的计时器重置（用户刚又触发了一次，说明还需要看）。
    if (!persist) {
      window.setTimeout(() => dismissToast(duplicate.id), tone === "error" ? ERROR_TTL_MS : NOTE_TTL_MS);
    }
    return;
  }

  items = [...items, next];
  // 分池裁剪：错误不会被轻提示挤掉，反之亦然。
  const alerts = items.filter((entry) => entry.tone === "error" || entry.tone === "warning").slice(-MAX_ALERTS);
  const notes = items.filter((entry) => entry.tone !== "error" && entry.tone !== "warning").slice(-MAX_NOTES);
  items = [...alerts, ...notes];
  emit();
  if (!persist) {
    window.setTimeout(
      () => dismissToast(next.id),
      tone === "error" || tone === "warning" ? ERROR_TTL_MS : NOTE_TTL_MS,
    );
  }
}

/**
 * 把任意异常推成一条结构化错误提示。
 *
 * 这是"操作失败"的统一出口：标题说清是什么操作，摘要一行，详情收在可展开区，
 * 再附上重试与复制。结果未知的操作**不给重试按钮** —— 乱点重试等于重复执行。
 */
export function pushErrorToast(
  cause: unknown,
  options: {
    title?: string;
    /** 重试入口；结果未知时会被忽略。 */
    retry?: () => void;
    /** 覆盖默认文案（默认「重试」/「复制错误信息」）。 */
    retryLabel?: string;
    persist?: boolean;
    /** 复制内容的前缀，例如「订单库 · 查询」。 */
    context?: string;
  } = {},
): void {
  const error = toAppError(cause);
  const label = stageLabel(error.stage) ?? undefined;
  const actionable = canRetry(error, options.retry);

  pushToast(error.message, "error", {
    title: options.title,
    label,
    detail: error.detail ?? error.hint ?? undefined,
    persist: options.persist ?? true,
    outcomeUnknown: error.outcomeUnknown,
    copyText: formatErrorForCopy(error, options.context ?? options.title),
    actions:
      actionable && options.retry
        ? [{ label: options.retryLabel ?? "Retry", onClick: options.retry }]
        : undefined,
  });
}

export function ToastHost() {
  const [visible, setVisible] = useState<ToastItem[]>(items);

  useEffect(() => {
    const listener = (next: ToastItem[]) => setVisible(next);
    listeners.add(listener);
    listener(items);
    return () => {
      listeners.delete(listener);
    };
  }, []);

  if (visible.length === 0) return null;

  const alerts = visible.filter((item) => item.tone === "error" || item.tone === "warning");
  const notes = visible.filter((item) => item.tone !== "error" && item.tone !== "warning");

  return createPortal(
    <>
      {alerts.length > 0 && (
        <div
          className="glass-host pointer-events-none fixed left-1/2 top-3 flex w-[min(600px,calc(100vw-2rem))] -translate-x-1/2 flex-col items-center gap-2"
          style={{ zIndex: OVERLAY_Z.toast }}
        >
          {alerts.map((item) => (
            <AlertCard key={item.id} item={item} />
          ))}
        </div>
      )}
      {notes.length > 0 && (
        <div
          className="pointer-events-none fixed bottom-4 right-4 flex w-[320px] flex-col gap-1.5"
          style={{ zIndex: OVERLAY_Z.toast }}
        >
          {notes.map((item) => (
            <NoteCard key={item.id} item={item} />
          ))}
        </div>
      )}
    </>,
    document.body,
  );
}

/**
 * 顶部提醒条：错误 / 警告共用。
 *
 * 层级是刻意的：上下文（stage/标题）→ 结论（message，唯一加粗行）→ 原始详情
 * （内嵌浅底块）→ 操作（右对齐）。左侧图标只与「上下文 + 结论」这两行做垂直
 * 居中，详情和操作落到下面整行，避免图标被拉到卡片正中。
 */
function AlertCard({ item }: { item: ToastItem }) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const iconRef = useRef<AnimatedIconHandle>(null);
  const warning = item.tone === "warning";
  const longDetail = (item.detail?.length ?? 0) > DETAIL_COLLAPSE_AT;
  const showDetail = !!item.detail && (!longDetail || expanded);
  const hasContext = !!(item.label || item.title || item.outcomeUnknown);
  const hasFooter = longDetail || !!item.actions?.length || item.tone === "error";

  // 每弹出一条就动一下：组件随 toast 挂载，挂载即触发一次，之后仍由 hover 驱动。
  useEffect(() => {
    void iconRef.current?.startAnimation();
  }, []);

  return (
    <LiquidGlass
      className="pointer-events-auto mx-auto w-full max-w-full [&>.glass]:w-full [&>.glass>div]:w-full"
      cornerRadius={10}
      padding="0"
      elasticity={0.06}
      style={{ width: "100%" }}
    >
      <div
        role={warning ? "status" : "alert"}
        aria-live={warning ? "polite" : "assertive"}
        className="overlay-enter relative w-full overflow-hidden rounded-[10px] border border-line/70 bg-surface-1/78 py-2.5 pl-3 pr-2"
      >
        <div className="flex items-center gap-2.5">
          <TriangleAlertIcon
            ref={iconRef}
            size={16}
            className={cn("shrink-0", warning ? "text-warning" : "text-danger")}
          />
          <div className="min-w-0 flex-1">
            {hasContext && (
              <div className="mb-0.5 flex flex-wrap items-center gap-1.5">
                {item.label && (
                  <span
                    className={cn(
                      "shrink-0 rounded-[4px] px-1.5 py-px text-10 font-semibold tracking-wide uppercase",
                      warning ? "bg-warning/12 text-warning" : "bg-danger/12 text-danger",
                    )}
                  >
                    {item.label}
                  </span>
                )}
                {item.title && (
                  <span className="min-w-0 truncate text-11 text-fg-muted">{item.title}</span>
                )}
                {item.outcomeUnknown && (
                  <span className="shrink-0 rounded-[4px] bg-warning/12 px-1.5 py-px text-10 font-semibold text-warning">
                    {t("Outcome unknown")}
                  </span>
                )}
              </div>
            )}
            <p className="break-words text-13 font-semibold leading-snug text-fg">{item.message}</p>
          </div>
          <button
            type="button"
            aria-label="dismiss"
            className="flex h-5 w-5 shrink-0 items-center justify-center rounded-[5px] text-fg-subtle transition-colors hover:bg-surface-hover hover:text-fg"
            onClick={() => dismissToast(item.id)}
          >
            <X size={11} />
          </button>
        </div>
        {item.detail && showDetail && (
          <p className="ml-[26px] mt-1.5 max-h-28 overflow-y-auto break-words whitespace-pre-wrap rounded-[6px] border border-line/50 bg-surface-2/70 px-2 py-1.5 text-11 leading-relaxed text-fg-muted">
            {item.detail}
          </p>
        )}
        {hasFooter && (
          <div className="ml-[26px] mt-2 flex flex-wrap items-center gap-1.5">
            {longDetail && (
              <button
                type="button"
                className="inline-flex h-6 items-center gap-1 rounded-[6px] px-1.5 text-11 font-medium text-fg-muted transition-colors hover:bg-surface-hover hover:text-fg"
                onClick={() => setExpanded((value) => !value)}
                aria-expanded={expanded}
              >
                <ChevronDown size={11} className={cn("transition-transform", expanded && "rotate-180")} />
                {expanded ? t("Hide details") : t("Show details")}
              </button>
            )}
            {item.actions?.map((action) => (
              <ToastActionButton key={action.label} action={action} />
            ))}
            {item.tone === "error" && <CopyErrorButton item={item} />}
          </div>
        )}
      </div>
    </LiquidGlass>
  );
}

function ToastActionButton({ action }: { action: ToastAction }) {
  return (
    <Button variant="secondary" size="xs" disabled={action.busy} onClick={action.onClick}>
      {action.busy ? <Loader2 size={11} className="animate-spin" /> : <RotateCcw size={11} />}
      {action.label}
    </Button>
  );
}

/** 「复制错误信息」：成功/失败都要有反馈，不能点了像没点。 */
function CopyErrorButton({ item }: { item: ToastItem }) {
  const { t } = useTranslation();
  const [state, setState] = useState<"idle" | "done" | "failed">("idle");

  useEffect(() => {
    if (state === "idle") return;
    const timer = window.setTimeout(() => setState("idle"), 1600);
    return () => window.clearTimeout(timer);
  }, [state]);

  const copy = async () => {
    const text = item.copyText ?? [item.label, item.title, item.message, item.detail].filter(Boolean).join("\n");
    setState((await copyText(text)) ? "done" : "failed");
  };

  // 失败原因（剪贴板权限）放在 title 里，按钮本身只留短文案 ——
  // 一句十来个字的告警塞进按钮会把整条通知的排版撑歪。
  return (
    <Button
      variant="ghost"
      size="xs"
      className={cn("ml-auto", state === "failed" && "text-danger hover:bg-danger/12 hover:text-danger")}
      aria-label={t("Copy error details")}
      title={state === "failed" ? t("Copy failed. Please check clipboard permission") : undefined}
      onClick={() => void copy()}
    >
      {state === "done" ? <Check size={11} /> : <Copy size={12} />}
      {state === "done" ? t("Copied") : state === "failed" ? t("Copy failed") : t("Copy error details")}
    </Button>
  );
}

/** 右下角轻提示：信息 / 成功。 */
function NoteCard({ item }: { item: ToastItem }) {
  const success = item.tone === "success";
  return (
    <div
      className={cn(
        "pointer-events-auto flex items-start gap-1.5 rounded-[8px] border px-2.5 py-2 text-11 shadow-lg shadow-black/20",
        success ? "border-success/40 bg-success/12 text-success" : "border-line bg-surface-3 text-fg",
      )}
    >
      {success ? (
        <CheckCircle2 size={12} className="mt-0.5 shrink-0" />
      ) : (
        <Info size={12} className="mt-0.5 shrink-0 text-fg-subtle" />
      )}
      <span className="min-w-0 flex-1 break-words leading-snug">{item.message}</span>
      <button
        type="button"
        aria-label="dismiss"
        className="shrink-0 opacity-60 hover:opacity-100"
        onClick={() => dismissToast(item.id)}
      >
        <X size={10} />
      </button>
    </div>
  );
}
