import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Copy } from "lucide-react";
import { cn } from "@/lib/cn";
import type { Terminal } from "@xterm/xterm";
import { CopyNotice, useCopyFeedback } from "@/components/ui/copy-feedback";
import {
  blockAtLine,
  blockRectPx,
  bufferLineAtY,
  isFailedBlock,
  type BlockGeometry,
  type CommandBlock,
} from "./terminal-command-blocks";

/**
 * 终端命令块悬浮层 —— 鼠标悬到"命令 + 输出"区域时整块高亮，并在块顶弹出
 * 两个一键复制按钮（复制命令 / 复制输出，报错块同样可用，另带退出码徽标）。
 *
 * # 交互约束（交互铁律）
 *
 * - 高亮层与按钮条都**不拦截终端文本选择**：整层 `pointer-events-none`，
 *   只有两个复制按钮 `pointer-events-auto`；
 * - 按钮条 `onMouseDown` 阻断冒泡：不在终端里开启选区、不抢 xterm 焦点；
 * - alternate screen（vim / less）下缓冲语义完全不同，整个悬浮层不渲染
 *   （由调用方挂载条件保证）。
 *
 * # 几何
 *
 * 命中检测完全由纯函数（`terminal-command-blocks.ts`）完成：鼠标位置 →
 * `.xterm-rows` 测量出的一行高 → 视口绝对行（`viewportY`）→ 命中块 →
 * 高亮矩形。每次 mousemove / 滚轮 / resize 都重新测量，字号缩放与窗口
 * 变化自动跟随。滚出回滚缓冲的块（marker line = -1）永不参与命中。
 */
export function TerminalCommandBlocks({
  blocks,
  terminalRef,
  containerRef,
}: {
  blocks: CommandBlock[];
  terminalRef: React.RefObject<Terminal | null>;
  containerRef: React.RefObject<HTMLDivElement | null>;
}) {
  const { t } = useTranslation();
  const { status, copy } = useCopyFeedback();
  const [hover, setHover] = useState<{ block: CommandBlock; top: number; height: number } | null>(
    null,
  );
  const lastMouseRef = useRef<{ x: number; y: number } | null>(null);

  /**
   * 定位基准：overlay 挂在 xterm 容器的父节点（relative wrapper）里，所以
   * 命中/高亮几何必须全部相对**同一个元素**。事件也挂在这个 wrapper 上 ——
   * 复制按钮条渲染在块顶上方（块矩形之外），如果只监听 xterm 容器，鼠标
   * 移向按钮会先触发 mouseleave 把按钮条干掉，永远点不到。
   */
  const hostRef = useRef<HTMLElement | null>(null);

  const measure = useCallback((): BlockGeometry | null => {
    const terminal = terminalRef.current;
    const container = containerRef.current;
    const host = hostRef.current ?? (containerRef.current?.parentElement as HTMLElement | null);
    hostRef.current = host;
    if (!terminal || !container || !host) return null;
    const rows = container.querySelector<HTMLElement>(".xterm-rows");
    if (!rows) return null;
    const rowsRect = rows.getBoundingClientRect();
    const hostRect = host.getBoundingClientRect();
    const cellHeightPx = rowsRect.height / terminal.rows;
    if (!(cellHeightPx > 0)) return null;
    return {
      viewportY: terminal.buffer.active.viewportY,
      cellHeightPx,
      rowsTopPx: rowsRect.top - hostRect.top,
      viewportHeightPx: rowsRect.height,
    };
  }, [containerRef, terminalRef]);

  /** 用最后一次鼠标位置重算 hover（滚轮 / resize 后调用）。 */
  const recompute = useCallback(() => {
    const last = lastMouseRef.current;
    const host = hostRef.current ?? (containerRef.current?.parentElement as HTMLElement | null);
    if (!last || !host) return;
    const geometry = measure();
    if (!geometry) {
      setHover(null);
      return;
    }
    const localY = last.y - host.getBoundingClientRect().top;
    const line = bufferLineAtY(localY, geometry);
    const block = line === null ? null : blockAtLine(blocks, line);
    if (!block) {
      setHover(null);
      return;
    }
    const rect = blockRectPx(block, geometry);
    if (!rect) {
      setHover(null);
      return;
    }
    setHover((current) =>
      current && current.block.id === block.id && current.top === rect.top && current.height === rect.height
        ? current
        : { block, ...rect },
    );
  }, [blocks, containerRef, measure]);

  useEffect(() => {
    const host = (containerRef.current?.parentElement as HTMLElement | null) ?? null;
    hostRef.current = host;
    if (!host) return;
    const onMouseMove = (event: MouseEvent) => {
      // 鼠标移到复制按钮条上（在块矩形之外）：保持当前 hover 不动，否则
      // 命中检测立刻清掉 hover，按钮条闪没 —— 永远点不到。
      const target = event.target;
      if (target instanceof Element && target.closest("[data-block-actions]")) {
        lastMouseRef.current = { x: event.clientX, y: event.clientY };
        return;
      }
      lastMouseRef.current = { x: event.clientX, y: event.clientY };
      recompute();
    };
    const onMouseLeave = () => {
      lastMouseRef.current = null;
      setHover(null);
    };
    // 滚轮滚动后行区整体位移，等一帧让 xterm 先滚完再重算。
    const onWheel = () => {
      window.requestAnimationFrame(recompute);
    };
    const onResize = () => recompute();
    host.addEventListener("mousemove", onMouseMove);
    host.addEventListener("mouseleave", onMouseLeave);
    host.addEventListener("wheel", onWheel, { passive: true });
    window.addEventListener("resize", onResize);
    return () => {
      host.removeEventListener("mousemove", onMouseMove);
      host.removeEventListener("mouseleave", onMouseLeave);
      host.removeEventListener("wheel", onWheel);
      window.removeEventListener("resize", onResize);
    };
  }, [containerRef, recompute]);

  // 块列表变化（新命令提交 / 块封口）可能改变命中结果，重算一次。
  useEffect(() => {
    recompute();
  }, [recompute]);

  if (hover === null) {
    return <CopyNotice status={status} />;
  }

  const { block, top, height } = hover;
  const failed = isFailedBlock(block);
  const hasOutput = (block.renderedText ?? "").trim().length > 0;
  return (
    <>
      {/* 高亮：命令回显行 + 输出区整体。纯背景色，无描边；失败块用红底区分。 */}
      <div
        data-testid="terminal-command-block-highlight"
        aria-hidden
        className={cn(
          "pointer-events-none absolute inset-x-2 z-10 rounded-[4px]",
          failed ? "bg-danger/10" : "bg-accent/10",
        )}
        style={{ top, height }}
      />
      {/* 按钮条：块顶右上角；贴顶时翻进块内 */}
      <div
        data-testid="terminal-command-block-actions"
        data-block-actions
        className="absolute z-30 flex items-center gap-1 rounded-[9px] border border-line bg-surface-1 px-1.5 py-1 shadow-lg"
        style={{ top: top < 28 ? top + 4 : top - 28, right: 12 }}
        onMouseDown={(event) => event.stopPropagation()}
      >
        {failed && (
          <span
            data-testid="terminal-command-block-exit"
            className="px-1 text-10 tabular-nums text-danger"
          >
            exit {block.exitCode}
          </span>
        )}
        <button
          type="button"
          data-testid="terminal-command-block-copy-command"
          onClick={() => void copy(block.command)}
          className="flex h-6 shrink-0 items-center gap-1 rounded-[6px] px-2 text-11 text-fg-muted transition-colors hover:bg-surface-hover hover:text-fg"
        >
          <Copy size={12} />
          {t("Copy command")}
        </button>
        {hasOutput && (
          <button
            type="button"
            data-testid="terminal-command-block-copy-output"
            onClick={() => void copy(block.renderedText ?? "")}
            className={cn(
              "flex h-6 shrink-0 items-center gap-1 rounded-[6px] px-2 text-11 text-fg-muted",
              "transition-colors hover:bg-surface-hover hover:text-fg",
            )}
          >
            <Copy size={12} />
            {t("Copy output")}
          </button>
        )}
      </div>
      <CopyNotice status={status} />
    </>
  );
}
