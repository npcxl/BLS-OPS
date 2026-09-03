import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { cn } from "@/lib/cn";
import { RISK_META, type CommandSearchHit } from "@/api/ops-api";
import {
  computeSuggestPosition,
  type SuggestAnchor,
} from "./terminal-suggest";

/**
 * 终端内联命令提示层 —— **原位补全**：面板出现在输入光标右下方（间隔 6px），
 * 右侧放不下向左展开、底部放不下翻到光标上方。
 *
 * 键盘交互由 `TerminalView` 的按键层处理（见 `terminal-suggest.ts` 的映射表）；
 * 这里只负责展示与鼠标点选（mousedown 抢在终端失焦之前完成补全）。
 *
 * 填入只把候选写进当前行，**不执行**：第一次 Enter 填入并关闭面板，
 * 第二次 Enter 才由 shell 正常执行。
 */
export function TerminalSuggest({
  hits,
  activeIndex,
  onHover,
  onApply,
  anchor,
}: {
  hits: CommandSearchHit[];
  activeIndex: number;
  onHover: (index: number) => void;
  onApply: (hit: CommandSearchHit) => void;
  /** 光标锚点（px，相对定位父元素 = 光标右下角）。null 时不渲染。 */
  anchor: SuggestAnchor | null;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  // anchor 变化（输入/输出/滚动/缩放/fit 后都会重算）→ 先测量面板再定位，
  // 翻转规则在纯函数 computeSuggestPosition 里。layout 阶段完成，不闪跳。
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
  }, [anchor, hits.length]);

  // 高亮项变化时滚动进可视区（提示较多时列表会滚动）。
  useEffect(() => {
    const node = listRef.current?.children[activeIndex] as HTMLElement | undefined;
    node?.scrollIntoView({ block: "nearest" });
  }, [activeIndex]);

  if (hits.length === 0 || !anchor) return null;

  return (
    <div
      ref={panelRef}
      className="pointer-events-auto absolute z-20 overflow-hidden rounded-[8px] border border-line bg-surface-1 shadow-[0_4px_16px_rgb(15_23_42/0.18)]"
      style={{
        left: pos?.left ?? anchor.x,
        top: pos?.top ?? anchor.y,
        // 首帧测量完成前隐藏，避免从 (0,0) 闪一下。
        visibility: pos ? "visible" : "hidden",
        maxWidth: "min(460px, calc(100% - 8px))",
      }}
    >
      <div ref={listRef} className="max-h-[180px] overflow-y-auto py-0.5">
        {hits.map((hit, index) => (
          <button
            key={hit.id}
            type="button"
            // mousedown 而非 click：抢在终端失焦之前完成补全。
            onMouseDown={(event) => {
              event.preventDefault();
              onApply(hit);
            }}
            onMouseEnter={() => onHover(index)}
            className={cn(
              "flex w-full items-center gap-2 px-2.5 py-1 text-left transition-colors",
              index === activeIndex ? "bg-accent/12" : "hover:bg-surface-hover",
            )}
          >
            <code className="shrink-0 font-mono text-11 text-fg">{hit.syntax}</code>
            <span className={cn("shrink-0 rounded px-1 py-0.5 text-9", RISK_META[hit.risk].tone)}>
              {RISK_META[hit.risk].label}
            </span>
            <span className="min-w-0 flex-1 truncate text-10 text-fg-subtle" title={hit.title}>
              {hit.title}
            </span>
          </button>
        ))}
      </div>
      <div className="border-t border-line bg-surface-2/60 px-2.5 py-0.5 text-9 text-fg-subtle">
        ↑↓ 选择 · → 或 Enter 填入 · ← 关闭 · 再按 Enter 执行
      </div>
    </div>
  );
}
