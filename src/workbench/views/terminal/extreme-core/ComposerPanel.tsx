import { useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Attachment01Icon } from "@hugeicons/core-free-icons";
import { Lock, ShieldCheck } from "@/components/icons";
import { Select } from "@/components/ui/select";
import { Tooltip } from "@/components/ui/tooltip";
import type { ContextUsage } from "@/api/types/agent";
import type { ModelSetting } from "@/stores/extreme-store";
import PromptBar, {
  type PromptBarCommand,
  type PromptBarModel,
  type PromptBarSendDetail,
  type PromptBarSource,
} from "@/components/ui/prompt-bar";
import { PERMISSION_HINT, type PermissionMode } from "./permissions";
import { EC } from "./theme";
import { PICKED_KIND_LABEL, type ContextMode, type PickedContext } from "./chat-context";
import { ComposerMenu } from "./ComposerMenu";
import {
  contextOptions,
  effortTiers,
  effectiveProvider,
  formatTokens,
  highestEffort,
  matchBudget,
  modelKey,
  type EffortChoice,
  type ModelSelection,
  type ProviderChoice,
} from "./model-choice";

export interface ComposerPanelProps {
  /** 草稿：唯一来源是页面，这里只读写。 */
  draft: string;
  onDraftChange: (value: string) => void;
  /** 点击发送那一刻锁定模型 / 强度 / 预算，页面后续只认这份快照。 */
  onSend: (text: string, selection: ModelSelection) => void;
  /** 停止：整个聊天区**唯一**的停止入口（Prompt Bar 右下角那个键）。 */
  onCancel: () => void;
  /**
   * 现在有可停止的运行（Agent 循环 / 部署计划 / 状态待核对）。
   *
   * 发送键据此变成停止键；"能不能停"由页面统一判断，组件不再自己猜。
   */
  busy: boolean;
  /** ＋：打开右栏的「附件」标签。 */
  onOpenAttachments: () => void;
  /** 最近一轮请求的上下文用量（Rust 裁剪后的估算）。 */
  contextUsage?: ContextUsage | null;
  /** 本任务实际带入的附件名（用量面板里的材料构成）。 */
  attachmentNames?: string[];
  /** 本任务计划步骤数（用量面板里的材料构成）。 */
  planSteps?: number;
  /** 右栏勾选、本次发送要带的附件名（输入区只负责展示与移除）。 */
  selectedAttachments: string[];
  onRemoveAttachment: (name: string) => void;
  /** 正在讨论的附件（上下文）。 */
  focusLabel: string | null;
  onClearFocus: () => void;
  /** 当前权限模式：只读 / 完全权限。 */
  permission: PermissionMode;
  onPermissionChange: (next: PermissionMode) => void;
  /** 服务器是否已连接：未连接时发送禁用并说明原因，草稿仍可编辑。 */
  connected?: boolean;
  /** 上下文范围（按会话）：当前会话 / 仅本条 / 自选。 */
  contextMode: ContextMode;
  onContextModeChange: (mode: ContextMode) => void;
  /** 自选上下文里已勾选的材料。 */
  picked: PickedContext[];
  onRemovePicked: (id: string) => void;
  /** 已配置且启用的模型。 */
  providers: ProviderChoice[];
  /** 这条会话选中的模型；`null` = 默认提供方。 */
  providerId: string | null;
  onProviderChange: (id: string | null) => void;
  /** 按模型记住的上下文预算与思考强度。 */
  modelSettings: Record<string, ModelSetting>;
  onModelSettingChange: (key: string, patch: Partial<ModelSetting>) => void;
  /** 是否有运行在飞：此时选的是「下一条」用的模型。 */
  running: boolean;
  /** 正文最多几行（约聊天区三分之一），超出后在输入框内部滚动。 */
  maxRows: number;
}

/**
 * 「权限」入口：收起时只显示当前权限，点开才出现两项。
 *
 * 用统一 `Select`（Prompt Bar 同款）；`tone="warning"` 保留「完全权限」的
 * 警示色 —— 这是一个一旦误设就会直接改生产文件的开关。
 */
function PermissionSelect({
  permission,
  onChange,
}: {
  permission: PermissionMode;
  onChange: (next: PermissionMode) => void;
}) {
  const { t } = useTranslation();
  return (
    <Select
      variant="menu"
      className="shrink-0"
      menuMinWidth={340}
      tone={permission === "full" ? "warning" : "default"}
      ariaLabel={t("权限")}
      title={PERMISSION_HINT[permission]}
      value={permission}
      onChange={(value) => onChange(value as PermissionMode)}
      options={[
        {
          value: "readonly",
          label: t("只读"),
          hint: t("查询直接执行；写 / 改 / 删确认一次，sudo 禁用"),
          icon: <Lock size={11} />,
        },
        {
          value: "full",
          label: t("完全权限"),
          hint: t("写入 / 修改 / 删除直接执行，不再逐条确认"),
          icon: <ShieldCheck size={11} />,
        },
      ]}
    />
  );
}

/**
 * 「上下文」入口：范围（会话 / 仅本条 / 自选）与模型声明的上下文档位。
 *
 * 两个维度各用一个统一 `Select`；模型与思考强度仍然在 Prompt Bar 自己的
 * 菜单里（它们与输入框绑定，不在这里拆开）。
 */
function ContextSelects({
  contextMode,
  onContextModeChange,
  budget,
  budgets,
  onBudgetChange,
  running,
}: {
  contextMode: ContextMode;
  onContextModeChange: (mode: ContextMode) => void;
  budget: number | null;
  budgets: number[];
  onBudgetChange: (budget: number | null) => void;
  running: boolean;
}) {
  const { t } = useTranslation();
  const runningHint = running
    ? t("下一条消息生效；正在跑的任务沿用启动时的模型与设置。")
    : undefined;

  return (
    <>
      <Select
        variant="menu"
        className="shrink-0"
        ariaLabel={t("上下文范围")}
        title={runningHint ?? t("上下文范围")}
        value={contextMode}
        onChange={(value) => onContextModeChange(value as ContextMode)}
        options={[
          { value: "session", label: t("当前会话") },
          { value: "only", label: t("仅本条") },
          { value: "picked", label: t("自选") },
        ]}
      />
      {budgets.length > 0 ? (
        <Select
          variant="menu"
          className="shrink-0"
          ariaLabel={t("上下文长度")}
          title={runningHint ?? t("上下文长度")}
          value={budget === null ? "auto" : String(budget)}
          onChange={(value) => onBudgetChange(value === "auto" ? null : Number(value))}
          options={[
            { value: "auto", label: t("自动") },
            ...budgets.map((value) => ({ value: String(value), label: formatTokens(value) })),
          ]}
        />
      ) : (
        <span
          className="shrink-0 px-1 text-10 text-fg-subtle"
          title={t("该模型未登记上下文档位：请到设置里填上下文窗口")}
        >
          {t("自动（由模型决定）")}
        </span>
      )}
    </>
  );
}

/**
 * 超能的输入区：**官方 React Bits Prompt Bar 直接作为输入框**。
 *
 * 组件自己负责正文、@ 引用、/ 命令、模型、思考强度、附件与发送/停止；
 * 项目特有的「上下文范围 / 预算 / 权限」放在输入框下方一行。
 *
 * - 颜色全部由 token 传入（`--surface-1` / `--fg` / `--surface-2` / `--ai`），
 *   亮暗主题自动跟随，不用官方那套深色默认皮肤；
 * - 附件在右栏勾选，这里只显示与移除（受控）；
 * - 选中的模型 / 强度在**发送时**落到 store，`ask` 读最新值发请求。
 */
export function ComposerPanel({
  draft,
  onDraftChange,
  onSend,
  onCancel,
  busy,
  onOpenAttachments,
  contextUsage,
  attachmentNames = [],
  planSteps = 0,
  selectedAttachments,
  onRemoveAttachment,
  focusLabel,
  onClearFocus,
  permission,
  onPermissionChange,
  connected = true,
  contextMode,
  onContextModeChange,
  picked,
  onRemovePicked,
  providers,
  providerId,
  onProviderChange,
  modelSettings,
  onModelSettingChange,
  running,
  maxRows,
}: ComposerPanelProps) {
  const { t } = useTranslation();
  const usageAnchorRef = useRef<HTMLButtonElement | null>(null);
  const [usageOpen, setUsageOpen] = useState(false);
  const provider = effectiveProvider(providers, providerId);
  const setting = provider ? modelSettings[modelKey(provider.id, provider.model)] : undefined;

  const models = useMemo<PromptBarModel[]>(
    () => providers.map((item) => ({ key: item.id, name: item.model, tag: item.name })),
    [providers],
  );

  // 思考强度：模型支持的档位 + 「默认」（= 不传 reasoning_effort）。
  const effortChoices = useMemo(() => {
    const tiers = provider ? effortTiers(provider.efforts) : [];
    return [
      { value: "auto" as EffortChoice, label: t("默认") },
      ...tiers.map((tier) => ({
        value: tier.value as EffortChoice,
        label: tier.label === "MAX" ? "MAX" : t(tier.label),
      })),
    ];
  }, [provider, t]);
  /*
   * 「MAX」= 该模型实际支持的最高档。
   *
   * 换到只支持到 high 的模型时，之前存的 max 要收成 high（而不是掉回默认）：
   * 用户选的意图是"最高"，不是"某一路枚举值"。
   */
  const activeEffort: EffortChoice = (() => {
    const effort = setting?.effort ?? "auto";
    if (effort === "auto") return "auto";
    if (provider?.efforts.includes(effort)) return effort;
    if (effort === "max") return highestEffort(provider?.efforts ?? []) ?? "auto";
    return "auto";
  })();
  const defaultEffort = effortChoices.find((choice) => choice.value === activeEffort)?.label ?? "";

  const budgets = provider ? contextOptions(provider.budgets) : [];
  const budget = setting?.budget ? matchBudget(setting.budget, budgets) : null;
  const usage = contextUsage && contextUsage.budget > 0 ? contextUsage : null;
  /*
   * 指标口径：**这段任务对话有多长**，不是"这一轮发了多少"。
   *
   * `beforeTokens` 是裁剪前的大小（系统提示 + 整段历史 + 本轮工具结果），
   * 用户问"我的上下文用了多少"指的就是它；`afterTokens` 是超出预算后真正
   * 发出去的部分，只在被裁时作为补充说明。
   */
  const taskTokens = usage ? usage.report.beforeTokens : 0;
  const sentTokens = usage ? usage.report.afterTokens : 0;
  const trimmed = Boolean(usage && sentTokens < taskTokens);
  const usagePercent = usage ? (taskTokens / usage.budget) * 100 : 0;
  const usageSummary = usage
    ? trimmed
      ? t("任务对话 {{used}} / {{budget}} token（已占 {{percent}}%）；本轮实际发送 {{sent}}", {
          used: taskTokens.toLocaleString(),
          budget: usage.budget.toLocaleString(),
          percent: usagePercent.toFixed(1),
          sent: sentTokens.toLocaleString(),
        })
      : t("任务对话 {{used}} / {{budget}} token（已占 {{percent}}%）", {
          used: taskTokens.toLocaleString(),
          budget: usage.budget.toLocaleString(),
          percent: usagePercent.toFixed(1),
        })
    : t(running ? "正在计算上下文用量…" : "暂无上下文用量");

  const sources = useMemo<PromptBarSource[]>(
    () => [
      {
        key: "attachments",
        name: t("附件"),
        description: t("在右栏「附件」里勾选文件"),
        icon: Attachment01Icon,
        attach: true,
      },
    ],
    [t],
  );

  const commands = useMemo<PromptBarCommand[]>(
    () => [
      { key: "inspect", name: t("巡检这台服务器，给出结论"), description: t("CPU、内存、磁盘与关键服务") },
      { key: "logs", name: t("排查最近的错误日志"), description: t("定位报错并说明原因") },
      { key: "deploy", name: t("生成更新部署计划"), description: t("只生成计划，不执行") },
    ],
    [t],
  );

  /**
   * 发送：**只把当前受控值锁成快照**，不再把组件内部状态写回 store。
   *
   * 模型 / 强度 / 预算在菜单里选中时已经写进当前 workspace 的设置；点击发送
   * 后页面拿这份快照发请求，之后等终端输出、附件或切对话都不会改它。
   */
  const handleSend = (text: string, _detail: PromptBarSendDetail) => {
    // 未连接时不受理（按钮已禁用，这里是回车等路径的最后防线）。
    if (!connected) return;
    onSend(text, {
      providerId: provider?.id ?? providerId,
      model: provider?.model ?? "",
      effort: activeEffort,
      contextBudget: budget,
    });
  };

  return (
    <div className="extreme-core-composer-wrap shrink-0">
      {/* `data-extreme-composer`：编辑 / 引用后页面靠它把光标送回输入框末尾。 */}
      <div data-extreme-composer className="extreme-core-composer mx-auto w-full max-w-[880px]">
        {/* 材料在任何范围下都会发出去，所以在任何范围下都要显示（发送前能看到）。 */}
        {(focusLabel || picked.length > 0) && (
          <div className="flex flex-wrap items-center gap-1.5 px-1 pb-1.5">
            {focusLabel && (
              <span className="flex max-w-full items-center gap-1 rounded-full bg-surface-2 px-2 py-0.5 text-11 text-fg-muted">
                <span className="truncate" title={focusLabel}>
                  {t("正在讨论")}：{focusLabel}
                </span>
                <button
                  type="button"
                  aria-label={t("取消关注")}
                  onClick={onClearFocus}
                  className="shrink-0 px-0.5 text-fg-subtle hover:text-fg"
                >
                  ×
                </button>
              </span>
            )}
            {/* 材料：摆在输入框上方，逐个可移除（发送前就知道模型会收到什么）。 */}
            {picked.map((item) => (
                <span
                  key={item.id}
                  className="flex max-w-[220px] items-center gap-1 rounded-full px-2 py-0.5 text-11 text-fg-muted"
                  style={{ background: EC.surfaceRaised, border: `1px solid ${EC.border}` }}
                  title={item.detail}
                >
                  <span className="shrink-0 text-10 text-fg-subtle">{PICKED_KIND_LABEL[item.kind]}</span>
                  <span className="min-w-0 truncate">{item.label}</span>
                  <button
                    type="button"
                    aria-label={t("移除 {{name}}", { name: item.label })}
                    className="shrink-0 px-0.5 text-fg-subtle hover:text-fg"
                    onClick={() => onRemovePicked(item.id)}
                  >
                    ×
                  </button>
                </span>
              ))}
          </div>
        )}

        <PromptBar
          /*
           * 模型列表是异步加载的：第一次拿到后重建一次，让 `defaultModel` /
           * `defaultEffort`（初始值只在挂载时读）对准真实配置。草稿是受控的，不会丢。
           */
          key={models.length > 0 ? "prompt-bar-ready" : "prompt-bar-loading"}
          className="extreme-core-prompt-bar"
          value={draft}
          onChange={onDraftChange}
          attachments={selectedAttachments}
          onAttachmentsChange={(files) => {
            // 只同步「移除」：右栏勾选仍由页面负责。
            const removed = selectedAttachments.filter((name) => !files.includes(name));
            for (const name of removed) onRemoveAttachment(name);
          }}
          placeholder={t("描述要做什么，或把文件拖到这里")}
          sources={sources}
          commands={commands}
          onAttach={() => {
            onOpenAttachments();
            // 附件由右栏勾选后经 `attachments` 同步，这里不返回新文件。
            return undefined;
          }}
          models={models}
          defaultModel={providerId ?? provider?.id ?? ""}
          modelValue={providerId ?? provider?.id ?? ""}
          onModelChange={(model) => {
            if (model.key !== providerId) onProviderChange(model.key);
          }}
          efforts={effortChoices.map((choice) => choice.label)}
          defaultEffort={defaultEffort}
          effortValue={defaultEffort}
          onEffortChange={(label) => {
            const effort = effortChoices.find((choice) => choice.label === label)?.value;
            if (effort && provider) onModelSettingChange(modelKey(provider.id, provider.model), { effort });
          }}
          busy={busy}
          sendDisabled={!connected}
          sendDisabledReason={t("服务器未连接，重新连接后才能发送")}
          onSend={handleSend}
          onStop={onCancel}
          trailing={
            <Tooltip label={usageOpen ? t("本任务上下文与用量") : usageSummary} side="top">
              <button
                ref={usageAnchorRef}
                type="button"
                aria-label={t("上下文用量")}
                aria-expanded={usageOpen}
                aria-haspopup="menu"
                onClick={() => setUsageOpen((value) => !value)}
                className="grid size-7 shrink-0 place-items-center rounded-full text-fg-muted transition-colors hover:bg-surface-hover hover:text-fg focus-visible:outline-2 focus-visible:outline-accent"
                /* 超过预算 = 这段对话已经放不进模型窗口，本轮会裁剪最旧的部分。 */
                style={usage && usagePercent > 100 ? { color: "rgb(var(--warning))" } : undefined}
              >
                <span
                  aria-hidden="true"
                  className="grid size-3.5 place-items-center rounded-full"
                  style={{
                    background: `conic-gradient(currentColor ${Math.min(100, Math.max(0, usagePercent))}%, rgb(var(--line-strong)) 0)`,
                  }}
                >
                  <span className="size-2.5 rounded-full bg-surface-1" />
                </span>
              </button>
            </Tooltip>
          }
          background="rgb(var(--surface-1))"
          color="rgb(var(--fg))"
          menuBackground="rgb(var(--surface-2))"
          sparkColor="rgb(var(--ai))"
          width={880}
          radius={16}
          maxRows={Math.max(2, maxRows)}
        />

        <div className="flex min-w-0 items-center gap-1.5 px-1 pt-1.5">
          {/*
           * 能力未登记就明说：后端不认识这个模型名时，思考强度只剩「默认」、
           * 上下文只剩「自动」，不说清楚会被当成功能坏了。修的地方在设置页。
           */}
          {provider && !provider.capabilityKnown ? (
            <span
              className="rounded-full px-2 py-0.5 text-10"
              style={{ background: EC.surfaceRaised, color: "rgb(var(--warning))" }}
              title={t("该模型未登记能力：请到设置里填上下文窗口与思考强度档位")}
            >
              {t("能力未登记")}
            </span>
          ) : null}
          <ContextSelects
            contextMode={contextMode}
            onContextModeChange={onContextModeChange}
            budget={budget}
            budgets={budgets}
            onBudgetChange={(next) => {
              if (provider) onModelSettingChange(modelKey(provider.id, provider.model), { budget: next });
            }}
            running={running}
          />
          <ComposerMenu
            open={usageOpen}
            onClose={() => setUsageOpen(false)}
            anchor={usageAnchorRef.current}
            label={t("本任务上下文与用量")}
            opaque
          >
            <p className="px-2 pb-1 pt-1.5 text-11 text-fg-muted">{usageSummary}</p>
            {contextUsage && (
              <div className="space-y-2 px-2 py-1.5 text-11">
                <div>
                  <p className="text-10 font-medium tracking-wide text-fg-subtle uppercase">
                    {t("用户目标")}
                  </p>
                  <p className="mt-0.5 line-clamp-2 text-12 text-fg">
                    {contextUsage.goal || t("未记录")}
                  </p>
                </div>

                <div className="border-t border-line/60 pt-1.5">
                  <p className="text-10 font-medium tracking-wide text-fg-subtle uppercase">
                    {t("本次材料")}
                  </p>
                  <ul className="mt-1 space-y-0.5 text-fg-muted">
                    <li>{t("系统提示 {{tokens}}", { tokens: formatTokens(contextUsage.breakdown.system) })}</li>
                    <li>{t("会话历史 {{tokens}}", { tokens: formatTokens(contextUsage.breakdown.history) })}</li>
                    <li>{t("工具调用与结果 {{tokens}}", { tokens: formatTokens(contextUsage.breakdown.tools) })}</li>
                    <li>
                      {t("附件 {{n}} 个（内容已计入历史）", { n: attachmentNames.length })}
                      {attachmentNames.length > 0 && (
                        <span className="block truncate text-10 text-fg-subtle">
                          {attachmentNames.join("、")}
                        </span>
                      )}
                    </li>
                    <li>{t("计划步骤 {{n}} 步", { n: planSteps })}</li>
                    <li>{t("工具调用 {{n}} 次", { n: contextUsage.toolCalls })}</li>
                  </ul>
                </div>

                <div className="border-t border-line/60 pt-1.5">
                  <p className="text-10 font-medium tracking-wide text-fg-subtle uppercase">
                    {t("上下文裁剪")}
                  </p>
                  <p className="mt-1 text-fg-muted">
                    {t("L1 瘦身 {{slimmed}} 条 · L2 折叠 {{folded}} 单元 · L3 丢弃 {{dropped}} 单元", {
                      slimmed: contextUsage.report.slimmed,
                      folded: contextUsage.report.folded,
                      dropped: contextUsage.report.droppedUnits,
                    })}
                  </p>
                  <p className="mt-0.5 text-fg-subtle">
                    {t("任务对话 {{before}} → 本轮实际发送 {{after}}", {
                      before: formatTokens(contextUsage.report.beforeTokens),
                      after: formatTokens(contextUsage.report.afterTokens),
                    })}
                  </p>
                </div>

                <div className="border-t border-line/60 pt-1.5">
                  <p className="text-10 font-medium tracking-wide text-fg-subtle uppercase">
                    {t("本任务累计")}
                  </p>
                  <p className="mt-1 text-fg-muted">
                    {t("{{requests}} 次请求 · 输入 {{input}} · 输出 {{output}}", {
                      requests: contextUsage.cumulative.requests,
                      input: formatTokens(contextUsage.cumulative.inputTokens),
                      output: formatTokens(contextUsage.cumulative.outputTokens),
                    })}
                  </p>
                  <p className="mt-1 text-10 leading-4 text-fg-subtle">
                    {t("同一段历史会在多次请求里重复计入，所以累计与「当前上下文」不是一回事。")}
                  </p>
                </div>
              </div>
            )}
          </ComposerMenu>
          <PermissionSelect permission={permission} onChange={onPermissionChange} />
          {/*
           * 这里不再重复显示「正在停止…」：进度由上方状态行统一说明，
           * 停止键本身就在右下角（`busy`），同一个状态不必说两遍。
           */}
        </div>
      </div>
    </div>
  );
}
