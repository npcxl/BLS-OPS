/**
 * 超能主内容区的管理页外壳。
 *
 * 页面在 `<main>` 里替换聊天区，但**不卸载聊天**：返回后草稿、滚动位置和
 * 右栏都保持原样。这里只负责一条页头和独立滚动区，样式沿用超能 token。
 */
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { ChevronLeft } from "@/components/icons";

export function ExtremePageShell({
  title,
  description,
  actions,
  onBack,
  children,
}: {
  title: string;
  description?: string;
  actions?: ReactNode;
  onBack: () => void;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  return (
    <section className="flex min-h-0 min-w-0 flex-1 flex-col bg-content text-fg" aria-label={title}>
      <div className="flex shrink-0 items-center gap-2 border-b border-line/60 px-4 py-2.5">
        <button
          type="button"
          aria-label={t("返回对话")}
          onClick={onBack}
          className="grid size-7 shrink-0 place-items-center rounded-[7px] text-fg-subtle transition-colors duration-[120ms] ease-out hover:bg-surface-hover hover:text-fg focus-visible:outline-2 focus-visible:outline-accent"
        >
          <ChevronLeft size={14} />
        </button>
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-13 font-medium leading-5 text-fg">{t(title)}</h1>
          {description && (
            <p className="truncate text-11 leading-4 text-fg-subtle">{t(description)}</p>
          )}
        </div>
        {actions}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
        <div className="mx-auto w-full max-w-3xl">{children}</div>
      </div>
    </section>
  );
}
