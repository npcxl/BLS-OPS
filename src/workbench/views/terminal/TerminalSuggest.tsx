import { useEffect, useRef } from "react";
import { cn } from "@/lib/cn";
import { RISK_META, type CommandSearchHit } from "@/api/ops-api";

/**
 * 终端内联命令提示层（P4.2 接入终端）。
 *
 * 贴在终端底部、贴近正在输入的那一行。它**不劫持**普通方向键与 Tab ——
 * 那些属于远程 shell 的历史与补全；选择用 Alt+↑/↓，填入用 Alt+Enter 或
 * 鼠标点击，Enter 仍然是"交给 shell 执行"。
 *
 * 只读展示知识：这里不提供执行按钮，补全只把命令写进当前行，由用户自己
 * 回车 —— 保持"终端是终端"的心智模型。
 */
export function TerminalSuggest({
  hits,
  activeIndex,
  onHover,
  onApply,
}: {
  hits: CommandSearchHit[];
  activeIndex: number;
  onHover: (index: number) => void;
  onApply: (hit: CommandSearchHit) => void;
}) {
  const listRef = useRef<HTMLDivElement>(null);

  // 高亮项变化时滚动进可视区（提示较多时列表会滚动）。
  useEffect(() => {
    const node = listRef.current?.children[activeIndex] as HTMLElement | undefined;
    node?.scrollIntoView({ block: "nearest" });
  }, [activeIndex]);

  if (hits.length === 0) return null;

  return (
    <div className="pointer-events-auto absolute bottom-1.5 left-1.5 right-1.5 z-20 overflow-hidden rounded-[8px] border border-line bg-surface-1/97 shadow-[0_4px_16px_rgb(15_23_42/0.18)] backdrop-blur-sm">
      <div ref={listRef} className="max-h-[168px] overflow-y-auto py-0.5">
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
        Alt+↑↓ 选择 · Alt+Enter 或点击填入 · Ctrl+Space 关闭 · Enter 照常执行
      </div>
    </div>
  );
}
