import { Sparkles } from "lucide-react";
import { NO_AI_CAPABILITIES } from "./ai-contract";
import { isAiModuleEnabled } from "./feature-flag";

/**
 * 智能助手模块的**占位页**。
 *
 * 本轮（P4）明确不开发 AI：不接模型、不写 Prompt、不做聊天界面、不让 AI
 * 自动执行命令。菜单入口保留，点进来看到的必须是"未实现"，而不是一个空壳
 * 界面 —— 这是本项目的硬约定。
 */
export function AiPlaceholder() {
  const enabled = isAiModuleEnabled();
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-3">
        <div className="flex h-11 w-11 items-center justify-center rounded-[12px] border border-line bg-surface-2 text-fg-subtle">
          <Sparkles size={20} strokeWidth={1.75} />
        </div>
        <div>
          <div className="text-15 font-semibold text-fg">智能助手</div>
          <div className="text-12 text-fg-subtle">AI 辅助运维（未实现）</div>
        </div>
      </div>

      <div className="rounded-[10px] border border-line bg-surface-1 px-3 py-2.5 text-12 leading-relaxed text-fg-muted">
        本模块尚未实现。P4 阶段只保留菜单入口、feature flag 与接口类型占位；
        不接模型、不写 Prompt、不做聊天界面，也不会自动执行任何命令。
      </div>

      <div className="overflow-hidden rounded-[10px] border border-line bg-surface-1">
        <div className="border-b border-line px-3 py-1.5 text-11 text-fg-subtle">
          能力开关（当前全部关闭）
        </div>
        {Object.entries(NO_AI_CAPABILITIES).map(([key, value]) => (
          <div key={key} className="flex h-9 items-center justify-between px-3 text-12">
            <span className="text-fg-muted">{key}</span>
            <span className="text-11 text-fg-subtle">{value ? "开" : "关"}</span>
          </div>
        ))}
        <div className="flex h-9 items-center justify-between border-t border-line px-3 text-12">
          <span className="text-fg-muted">AI_MODULE_ENABLED</span>
          <span className="text-11 text-fg-subtle">{enabled ? "开" : "关"}</span>
        </div>
      </div>
    </div>
  );
}
