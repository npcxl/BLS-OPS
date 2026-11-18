import { useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Attachment01Icon } from "@hugeicons/core-free-icons";
import { ChevronDown, Lock, ShieldCheck } from "@/components/icons";
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
import { ComposerMenu, MenuChoice, MenuGroupTitle, MenuSegments } from "./ComposerMenu";
import {
  contextOptions,
  effortTiers,
  effectiveProvider,
  formatTokens,
  modelKey,
  type EffortChoice,
  type ProviderChoice,
} from "./model-choice";

export interface ComposerPanelProps {
  /** 草稿：唯一来源是页面，这里只读写。 */
  draft: string;
  onDraftChange: (value: string) => void;
  onSend: (text: string) => void;
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
 * 以前是一个"点一下就切换"的按钮：切到完全权限没有任何确认，误触代价太大。
 */
function PermissionMenu({
  permission,
  onChange,
}: {
  permission: PermissionMode;
  onChange: (next: PermissionMode) => void;
}) {
  const { t } = useTranslation();
  const anchorRef = useRef<HTMLButtonElement | null>(null);
  const [open, setOpen] = useState(false);
  const full = permission === "full";

  return (
    <>
      <button
        ref={anchorRef}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={t("权限")}
        title={PERMISSION_HINT[permission]}
        onClick={() => setOpen((value) => !value)}
        className="flex shrink-0 items-center gap-1 rounded-full px-1.5 py-0.5 text-10 transition-colors hover:bg-surface-hover"
        style={{
          // 颜色取 token：之前写死的是深色主题的黄字 / 深棕底，浅色下像块脏污。
          color: full ? "rgb(var(--warning))" : "rgb(var(--fg-subtle))",
          border: `1px solid ${full ? "rgb(var(--warning) / .35)" : "transparent"}`,
          background: full ? "rgb(var(--warning) / .12)" : "transparent",
        }}
      >
        {full ? <ShieldCheck size={11} /> : <Lock size={11} />}
        <span>{full ? t("完全权限") : t("只读")}</span>
        <ChevronDown size={10} aria-hidden="true" />
      </button>

      <ComposerMenu
        open={open}
        onClose={() => setOpen(false)}
        anchor={anchorRef.current}
        label={t("权限")}
      >
        <MenuChoice
          label={t("只读")}
          hint={t("查询直接执行；写 / 改 / 删确认一次，sudo 禁用")}
          selected={!full}
          onClick={() => {
            onChange("readonly");
            setOpen(false);
          }}
        />
        <MenuChoice
          label={t("完全权限")}
          hint={t("写入 / 修改 / 删除直接执行，不再逐条确认")}
          selected={full}
          onClick={() => {
            onChange("full");
            setOpen(false);
          }}
        />
      </ComposerMenu>
    </>
  );
}

/**
 * 「上下文」入口：范围（会话 / 仅本条 / 自选）与模型声明的上下文档位。
 *
 * 模型与思考强度已经交给 Prompt Bar 自己的菜单，这里只留项目特有的两项。
 */
function ContextMenu({
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
  const anchorRef = useRef<HTMLButtonElement | null>(null);
  const [open, setOpen] = useState(false);
  const modeLabel = {
    session: t("当前会话"),
    only: t("仅本条"),
    picked: t("自选"),
  }[contextMode];

  return (
    <>
      <button
        ref={anchorRef}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={t("上下文")}
        onClick={() => setOpen((value) => !value)}
        className="flex min-w-0 shrink items-center gap-1 rounded-md px-1.5 py-1 text-10 text-fg-muted transition-colors hover:bg-surface-hover hover:text-fg"
      >
        <span className="truncate">{modeLabel}</span>
        <span className="shrink-0 text-fg-subtle" aria-hidden="true">
          ·
        </span>
        <span className="shrink-0">{budget ? formatTokens(budget) : t("自动")}</span>
        <ChevronDown size={11} className="shrink-0" aria-hidden="true" />
      </button>

      <ComposerMenu
        open={open}
        onClose={() => setOpen(false)}
        anchor={anchorRef.current}
        label={t("上下文")}
        opaque
      >
        <MenuGroupTitle>{t("上下文范围")}</MenuGroupTitle>
        <MenuSegments
          label={t("上下文范围")}
          options={[
            { value: "session" as ContextMode, label: t("当前会话") },
            { value: "only" as ContextMode, label: t("仅本条") },
            { value: "picked" as ContextMode, label: t("自选") },
          ]}
          value={contextMode}
          onChange={onContextModeChange}
        />

        <MenuGroupTitle>{t("上下文长度")}</MenuGroupTitle>
        {budgets.length > 0 ? (
          <MenuSegments
            label={t("上下文长度")}
            options={[
              { value: 0, label: t("自动") },
              ...budgets.map((value) => ({ value, label: formatTokens(value) })),
            ]}
            value={budget ?? 0}
            onChange={(value) => onBudgetChange(value === 0 ? null : value)}
          />
        ) : (
          <p className="px-2 py-1 text-11 text-fg-muted">{t("自动（由模型决定）")}</p>
        )}

        {running && (
          <p className="mt-2 px-2 pb-1 text-10 leading-relaxed text-fg-subtle">
            {t("下一条消息生效；正在跑的任务沿用启动时的模型与设置。")}
          </p>
        )}
      </ComposerMenu>
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
  const activeEffort: EffortChoice =
    setting?.effort && (setting.effort === "auto" || provider?.efforts.includes(setting.effort))
      ? setting.effort
      : "auto";
  const defaultEffort = effortChoices.find((choice) => choice.value === activeEffort)?.label ?? "";

  const budgets = provider ? contextOptions(provider.budgets) : [];
  const budget = setting?.budget && budgets.includes(setting.budget) ? setting.budget : null;
  const usage = contextUsage && contextUsage.budget > 0 ? contextUsage : null;
  const usagePercent = usage ? (usage.used / usage.budget) * 100 : 0;
  const usageSummary = usage
    ? t("约 {{percent}}% · {{used}} / {{budget}} token", {
        percent: usagePercent.toFixed(1),
        used: usage.used.toLocaleString(),
        budget: usage.budget.toLocaleString(),
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
   * 发送：先落选中的模型与强度，再交给页面发起。
   *
   * `ask` 从 store 读最新值（不是渲染闭包），所以同一次发送就能用上这里的选择。
   */
  const handleSend = (text: string, detail: PromptBarSendDetail) => {
    // 未连接时不受理（按钮已禁用，这里是回车等路径的最后防线）。
    if (!connected) return;
    const model = detail.model;
    if (model && model.key !== providerId) onProviderChange(model.key);
    if (model && detail.effort) {
      const effort = effortChoices.find((choice) => choice.label === detail.effort)?.value;
      if (effort) onModelSettingChange(modelKey(model.key, model.name), { effort });
    }
    onSend(text);
  };

  return (
    <div className="extreme-core-composer-wrap shrink-0">
      {/* `data-extreme-composer`：编辑 / 引用后页面靠它把光标送回输入框末尾。 */}
      <div data-extreme-composer className="extreme-core-composer mx-auto w-full max-w-[880px]">
        {(focusLabel || (contextMode === "picked" && picked.length > 0)) && (
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
            {/* 自选上下文：勾选的材料摆在输入框上方，逐个可移除。 */}
            {contextMode === "picked" &&
              picked.map((item) => (
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
          onModelChange={(model) => {
            if (model.key !== providerId) onProviderChange(model.key);
          }}
          efforts={effortChoices.map((choice) => choice.label)}
          defaultEffort={defaultEffort}
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
          <ContextMenu
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
                    {t("本轮裁剪")}
                  </p>
                  <p className="mt-1 text-fg-muted">
                    {t("L1 瘦身 {{slimmed}} 条 · L2 折叠 {{folded}} 单元 · L3 丢弃 {{dropped}} 单元", {
                      slimmed: contextUsage.report.slimmed,
                      folded: contextUsage.report.folded,
                      dropped: contextUsage.report.droppedUnits,
                    })}
                  </p>
                  <p className="mt-0.5 text-fg-subtle">
                    {t("本轮 {{before}} → {{after}}", {
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
          <PermissionMenu permission={permission} onChange={onPermissionChange} />
          {/*
           * 这里不再重复显示「正在停止…」：进度由上方状态行统一说明，
           * 停止键本身就在右下角（`busy`），同一个状态不必说两遍。
           */}
        </div>
      </div>
    </div>
  );
}
