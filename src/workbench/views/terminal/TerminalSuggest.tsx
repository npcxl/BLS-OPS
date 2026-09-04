import { useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  Box,
  Cpu,
  FileText,
  Folder,
  Layers,
  Network,
  Play,
  Settings,
  Terminal,
} from "lucide-react";
import { cn } from "@/lib/cn";
import { RISK_META } from "@/api/ops-api";
import { useTranslation } from "react-i18next";
import { computeSuggestPosition, type SuggestAnchor } from "./terminal-suggest";
import type { CompletionIcon, CompletionItem } from "./completion/types";

/**
 * 终端内联提示层 —— **原位补全**：面板出现在输入光标右下方（间隔 6px）。
 *
 * 渲染层只认 `CompletionItem`：来自知识库、远程目录、Docker 资源、服务、
 * 进程还是环境生成的命令，在这里长得都一样（图标 + 名称 + 说明 + 高亮）。
 * 想加一种补全，加一个 Provider 就够了，这个文件不用动。
 *
 * 键盘交互由 `TerminalView` 的按键层处理（见 `terminal-suggest.ts` 的映射表）；
 * 这里只负责展示与鼠标操作（mousedown 抢在终端失焦之前完成）。
 */

const ICONS: Record<CompletionIcon, typeof Folder> = {
  command: Terminal,
  directory: Folder,
  file: FileText,
  container: Box,
  image: Layers,
  network: Network,
  volume: Network,
  service: Settings,
  process: Cpu,
};

/**
 * 已输入部分高亮：把 label 切成"已输入 / 剩余"两段。
 *
 * 高亮长度由 Provider 给出（= 用户实际敲的那段前缀），大小写不敏感的回退
 * 匹配同样高亮 —— 用户看到的是"我敲的部分"，这正是要高亮的东西。
 */
function Highlighted({
  text,
  highlight,
}: {
  text: string;
  highlight?: { start: number; length: number };
}) {
  if (!highlight || highlight.length <= 0) return <>{text}</>;
  const start = Math.max(0, Math.min(highlight.start, text.length));
  const end = Math.max(start, Math.min(highlight.start + highlight.length, text.length));
  if (end <= start) return <>{text}</>;
  return (
    <>
      {text.slice(0, start)}
      <span className="font-medium text-accent">{text.slice(start, end)}</span>
      {text.slice(end)}
    </>
  );
}

export function TerminalSuggest({
  items,
  notice,
  activeIndex,
  onHover,
  onApply,
  onRun,
  anchor,
}: {
  items: CompletionItem[];
  /** 底部说明（环境状态 / "没有匹配的远程目录"…）。 */
  notice?: string | null;
  activeIndex: number;
  onHover: (index: number) => void;
  /** 填入候选（**不执行**）。 */
  onApply: (item: CompletionItem) => void;
  /** 补全后**立即执行**（可选 —— 未提供时只显示"填入"）。 */
  onRun?: (item: CompletionItem) => void;
  /** 光标锚点（px，相对定位父元素 = 光标右下角）。null 时不渲染。 */
  anchor: SuggestAnchor | null;
}) {
  const { t } = useTranslation();
  const panelRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  useLayoutEffect(() => {
    const el = panelRef.current;
    const parent = (el?.offsetParent ?? null) as HTMLElement | null;
    if (!el || !parent || !anchor) return;
    setPos(
      computeSuggestPosition(
        anchor,
        { width: el.offsetWidth, height: el.offsetHeight },
        { width: parent.clientWidth, height: parent.clientHeight },
      ),
    );
  }, [anchor, items.length, notice]);

  useEffect(() => {
    const node = listRef.current?.children[activeIndex] as HTMLElement | undefined;
    node?.scrollIntoView({ block: "nearest" });
  }, [activeIndex]);

  // 没有任何候选、也没有要说的话 → 不显示面板（避免闪一个空框）。
  if ((items.length === 0 && !notice) || !anchor) return null;

  return (
    <div
      ref={panelRef}
      className="pointer-events-auto absolute z-20 overflow-hidden rounded-[8px] border border-line bg-surface-1 shadow-[0_4px_16px_rgb(15_23_42/0.18)]"
      style={{
        left: pos?.left ?? anchor.x,
        top: pos?.top ?? anchor.y,
        visibility: pos ? "visible" : "hidden",
        maxWidth: "min(520px, calc(100% - 8px))",
      }}
    >
      {items.length > 0 && (
        <div ref={listRef} className="max-h-[180px] overflow-y-auto py-0.5">
          {items.map((item, index) => {
            const Icon = ICONS[item.icon];
            const risk = item.command?.risk;
            return (
              <button
                key={`${item.source}:${item.label}:${index}`}
                type="button"
                // mousedown 而非 click：抢在终端失焦之前完成补全。
                onMouseDown={(event) => {
                  event.preventDefault();
                  if (item.disabled) return;
                  onApply(item);
                }}
                onMouseEnter={() => onHover(index)}
                className={cn(
                  "flex w-full items-center gap-2 px-2.5 py-1 text-left transition-colors",
                  index === activeIndex ? "bg-accent/12" : "hover:bg-surface-hover",
                )}
              >
                <Icon size={12} className="shrink-0 text-fg-subtle" />
                <code className="shrink-0 font-mono text-11 text-fg">
                  <Highlighted text={item.label} highlight={item.highlight} />
                </code>
                {/* 只在需要警示时显示标签（只读是默认情况，不占位置）。 */}
                {risk && risk !== "read_only" && (
                  <span className={cn("shrink-0 rounded px-1 py-0.5 text-9", RISK_META[risk].tone)}>
                    {RISK_META[risk].label}
                  </span>
                )}
                <span
                  className="min-w-0 flex-1 truncate text-10 text-fg-subtle"
                  title={t(item.detail)}
                >
                  {t(item.detail)}
                </span>
                {onRun && (
                  <span
                    role="button"
                    tabIndex={-1}
                    aria-label={t("Run {{command}}", { command: item.label })}
                    title={t("Complete and run")}
                    onMouseDown={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      if (item.disabled) return;
                      onRun(item);
                    }}
                    className="shrink-0 rounded p-0.5 text-fg-subtle hover:bg-accent/15 hover:text-accent"
                  >
                    <Play size={11} />
                  </span>
                )}
              </button>
            );
          })}
        </div>
      )}
      <div className="border-t border-line bg-surface-2/60 px-2.5 py-0.5 text-9 text-fg-subtle">
        {notice ? (
          <span className="block truncate" title={t(notice)}>
            {t(notice)}
          </span>
        ) : onRun ? (
          t("↑↓ select · → or Enter to fill · ← to close · Enter again to run · ▶ / Ctrl+Enter to run directly")
        ) : (
          t("↑↓ select · → or Enter to fill · ← to close · Enter again to run")
        )}
      </div>
    </div>
  );
}
