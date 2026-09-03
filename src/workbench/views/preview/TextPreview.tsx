import { Suspense, lazy } from "react";

/**
 * Read-only text view.
 *
 * 代码/文本用只读 CodeMirror 渲染（懒加载，避免预览路径拖入大依赖）：
 * 行号、长文件视口渲染、以及与编辑器弹窗一致的 Ctrl+F 查找/替换面板
 * （只读文档自动隐藏替换行）。点"在编辑器打开"可获得可编辑版本。
 */
const CodeText = lazy(() => import("./CodeText"));

export function TextPreview({ text }: { text: string }) {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <Suspense
        fallback={
          <div className="flex flex-1 items-center justify-center text-12 text-fg-subtle">
            正在加载查看器…
          </div>
        }
      >
        <CodeText text={text} />
      </Suspense>
    </div>
  );
}
