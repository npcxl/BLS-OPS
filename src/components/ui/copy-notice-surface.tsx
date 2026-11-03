import type { ReactNode } from "react";
import { CheckCircle2, XCircle } from "@/components/icons";
import { cn } from "@/lib/cn";

/**
 * 复制提示的**唯一样式**：左上角图标 + 文案的实心胶囊。
 *
 * 结果面板里的 `CopyNotice` 和全局提示里的菜单动作都复用它 —— 同一个应用里
 * 不能出现两种"已复制"。
 *
 * 这里是**单层**实心胶囊：不再套 `LiquidGlass`。玻璃层在 85% 不透明填充下
 * 本来就看不见，只会多出一圈外层光晕和一次整屏 blur 合成。
 */
export function CopyNoticeSurface({ ok, children }: { ok: boolean; children: ReactNode }) {
  return (
    <div
      data-testid="copy-notice"
      className="overlay-enter inline-flex max-w-full items-center gap-2 rounded-full border border-line/60 bg-surface-1/92 py-2 pl-2.5 pr-4 text-12 font-medium text-fg shadow-[0_4px_18px_rgb(0_0_0/0.08)]"
    >
      <span
        className={cn(
          "grid size-5 shrink-0 place-items-center rounded-full",
          ok ? "bg-success/10 text-success" : "bg-danger/10 text-danger",
        )}
      >
        {ok ? <CheckCircle2 size={13} /> : <XCircle size={13} />}
      </span>
      <span className="min-w-0 flex-1 break-words leading-snug">{children}</span>
    </div>
  );
}
