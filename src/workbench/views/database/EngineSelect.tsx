/**
 * 数据库类型选择卡（连接表单顶部）。
 *
 * 一行展示品牌、产品与版本；引擎列表通过 portal 浮动显示，不挤动表单。
 * 与公共浮层栈协作，保留键盘选择、外部关闭和滚动边界处理。
 *
 * 清单与文案全部来自后端 `db_engines_catalog`（`engineChoices` 已按 `entry`
 * 策略过滤），这里不维护任何引擎白名单。
 */
import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { isTopOverlayLayer, OVERLAY_Z, useOverlayLayer } from "@/components/ui/overlay";
import { Check, ChevronDown, ChevronUp, Info } from "@/components/icons";
import { cn } from "@/lib/cn";
import type { DbEngine, EngineDescriptor } from "@/api/types/database";
import { DbEngineIcon } from "./DbEngineIcon";
import { engineChoices, engineDescriptor } from "./db-engines";
/**
 * 版本徽标：去掉与产品名重复的前缀（"MySQL 8.x" → "8.x"）。
 * 只剥「产品名 + 空格」这种形状，SQLite 的 `SQLite（rusqlite bundled）` 原样保留。
 */
function versionBadge(descriptor: EngineDescriptor): string {
  const raw = descriptor.verified[0]?.versions ?? "";
  const prefix = `${descriptor.product} `;
  return raw.startsWith(prefix) ? raw.slice(prefix.length) : raw;
}

export function EngineSelect({
  engine,
  originalEngine,
  open,
  onToggle,
  onSelect,
}: {
  engine: DbEngine;
  /** 编辑旧配置时这条连接原本的引擎：被移出一级入口的产品也要能看到并保留。 */
  originalEngine: string | null;
  open: boolean;
  onToggle: () => void;
  onSelect: (engine: DbEngine) => void;
}) {
  const { t } = useTranslation();
  const descriptor = engineDescriptor(engine);
  // 目录还没加载时 `descriptor` 为 null；此时只显示 id，不猜测任何默认值。
  const choices = engineChoices(engine, originalEngine);
  const ready = choices.filter((choice) => choice.implementation === "implemented").length;
  const badge = descriptor ? versionBadge(descriptor) : "";
  const implemented = descriptor?.implementation === "implemented";
  const buttonRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const listId = useId();
  const layer = useOverlayLayer(open, "engine-select");
  const [position, setPosition] = useState<CSSProperties | null>(null);
  const close = (restore = false) => {
    onToggle();
    if (restore) buttonRef.current?.focus();
  };
  useLayoutEffect(() => {
    if (!open) { setPosition(null); return; }
    const place = () => {
      const rect = buttonRef.current?.getBoundingClientRect();
      if (!rect) return;
      const below = window.innerHeight - rect.bottom - 14;
      const above = rect.top - 14;
      const up = below < 260 && above > below;
      const width = Math.min(340, window.innerWidth - 24);
      setPosition({ left: Math.max(12, Math.min(rect.left, window.innerWidth - width - 12)), width,
        maxHeight: Math.max(40, Math.min(380, up ? above : below)),
        ...(up ? { bottom: window.innerHeight - rect.top + 6 } : { top: rect.bottom + 6 }),
        zIndex: OVERLAY_Z.select + Math.min(layer.depth, 8) * 2 });
    };
    place();
    const scroll = (event: Event) => { if (!listRef.current?.contains(event.target as Node)) place(); };
    window.addEventListener("scroll", scroll, true);
    window.addEventListener("resize", place);
    return () => { window.removeEventListener("scroll", scroll, true); window.removeEventListener("resize", place); };
  }, [open, layer.depth]);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (listRef.current?.contains(event.target as Node) || buttonRef.current?.contains(event.target as Node)) return;
      close();
    };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  });
  useLayoutEffect(() => {
    if (!open || !position) return;
    listRef.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.focus();
  }, [open, position === null]);

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-baseline justify-between gap-3">
        <span className="flex shrink-0 items-center gap-1 text-11 font-medium text-fg-muted">
          {t("数据库类型")}
          <span className="text-danger" aria-hidden="true">
            *
          </span>
        </span>
        {descriptor && (
          <span
            className="flex min-w-0 items-center gap-1 text-11 leading-relaxed text-fg-subtle"
            title={t(descriptor.note)}
          >
            <Info size={11} className="shrink-0" />
            <span className="truncate">{t(descriptor.note)}</span>
          </span>
        )}
      </div>

      <div
        className={cn(
          "rounded-[10px] border bg-surface-2/50 transition-colors",
          open ? "border-accent/45" : "border-line",
        )}
      >
        <button
          ref={buttonRef}
          type="button"
          aria-expanded={open}
          aria-haspopup="listbox"
          aria-controls={open ? listId : undefined}
          onClick={onToggle}
          className="flex w-full items-center gap-2.5 rounded-[10px] px-2.5 py-2 text-left hover:bg-surface-hover/60"
        >
          <span className="grid size-8 shrink-0 place-items-center rounded-[8px] border border-line bg-surface-1">
            <DbEngineIcon engine={engine} connected={implemented} size={18} />
          </span>
          <span className="min-w-0 truncate text-13 font-medium text-fg">
            {descriptor?.product ?? engine}
          </span>
          {badge && (
            <span className="shrink-0 rounded-[4px] border border-line bg-surface-1 px-1.5 text-10 leading-[16px] text-fg-subtle">
              {badge}
            </span>
          )}
          {!implemented && (
            <span className="shrink-0 rounded-[4px] bg-warning/15 px-1.5 text-10 leading-[16px] text-warning">
              {t("尚未适配")}
            </span>
          )}
          <span className="ml-auto flex shrink-0 items-center gap-1 text-11 text-accent">
            {open ? t("收起引擎列表") : t("展开引擎列表")}
            {open ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
          </span>
        </button>

        {open && position && createPortal(
          <div ref={listRef} id={listId} role="listbox" aria-label={t("数据库类型")}
            className="db-engine-popover ops-scroll" style={position}
            onKeyDown={(event) => {
              if (!isTopOverlayLayer(layer.id)) return;
              if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(true); }
              else if (event.key === "Tab") close();
              else if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
                event.preventDefault();
                const nodes = Array.from(listRef.current?.querySelectorAll<HTMLButtonElement>('[role="option"]') ?? []);
                const index = nodes.indexOf(document.activeElement as HTMLButtonElement);
                const next = event.key === "Home" ? 0 : event.key === "End" ? nodes.length - 1
                  : (index + (event.key === "ArrowDown" ? 1 : -1) + nodes.length) % nodes.length;
                nodes[next]?.focus(); nodes[next]?.scrollIntoView({ block: "nearest" });
              }
            }}>
            <div className="min-w-0">
              <div className="flex items-center justify-between gap-2 border-b border-line px-2 py-1.5">
                <span className="text-11 font-medium text-fg-muted">{t("支持的驱动引擎")}</span>
                <span className="shrink-0 text-10 text-fg-subtle">
                  {t("已就绪 {{count}} 款", { count: ready })}
                </span>
              </div>
              <ul className="p-1">
                {choices.map((choice) => {
                  const selected = choice.id === engine;
                  const usable = choice.implementation === "implemented";
                  return (
                    <li key={choice.id}>
                      <button
                        type="button"
                        role="option"
                        aria-selected={selected}
                        tabIndex={selected ? 0 : -1}
                        onClick={() => { onSelect(choice.id); buttonRef.current?.focus(); }}
                        className={cn(
                          "flex w-full items-center gap-3 rounded-[10px] border border-transparent px-2.5 py-2.5 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/40",
                          selected ? "bg-accent/10" : "hover:bg-surface-hover",
                        )}
                      >
                        <DbEngineIcon
                          engine={choice.id}
                          connected={usable}
                          size={18}
                          className="shrink-0"
                        />
                        <span className="min-w-0 flex-1">
                          <span className="flex items-center gap-1.5">
                            <span className="truncate text-12 text-fg">{choice.product}</span>
                            {versionBadge(choice) && (
                              <span className="shrink-0 rounded-[3px] border border-line px-1 text-10 leading-4 text-fg-subtle">
                                {versionBadge(choice)}
                              </span>
                            )}
                          </span>
                          <span
                            className="block truncate text-11 leading-relaxed text-fg-subtle"
                            title={t(choice.note)}
                          >
                            {t(choice.note)}
                          </span>
                        </span>
                        {selected ? (
                          <Check size={12} className="shrink-0 text-accent" />
                        ) : usable ? (
                          <span className="shrink-0 text-11 text-fg-subtle">{t("选择")}</span>
                        ) : (
                          <span className="shrink-0 text-10 text-warning">{t("未适配")}</span>
                        )}
                      </button>
                    </li>
                  );
                })}
              </ul>
            </div>
          </div>, document.body
        )}
      </div>
    </div>
  );
}
