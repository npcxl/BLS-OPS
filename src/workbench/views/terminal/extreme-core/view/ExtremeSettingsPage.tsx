/**
 * 超能模式 → 设置。
 *
 * 三层作用域：
 * 1. 超能模式默认值（新任务继承；已有会话可「跟随默认」）；
 * 2. 模型能力（供应商 / 窗口 / 预算 / 输出 / 思考档，仍在 AiProviderSettings）；
 * 3. 当前会话覆盖（模型、上下文、输出、思考档；输入框底栏也能改）。
 *
 * 只放**已经接到执行链路**的选项；模型/连接类仍走原有保存与测试流程。
 */
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/select";
import { cn } from "@/lib/cn";
import { opsApi } from "@/api/ops-api";
import {
  effectiveModelSetting,
  useExtremeStore,
  type ModelSetting,
} from "@/stores/extreme-store";
import {
  useExtremeSettingsStore,
  type MotionMode,
  type NewTaskPane,
  type PlanCardMode,
  type ReplyLanguage,
  type ToolDetailMode,
} from "@/stores/extreme-settings-store";
import type { ContextMode, OutputStyle } from "../chat-context";
import {
  contextOptions,
  effectiveProvider,
  effortTiers,
  formatTokens,
  modelKey,
  type ProviderChoice,
} from "../model-choice";
import { AiProviderSettings } from "@/workbench/settings-ai";
import { ExtremePageShell } from "./ExtremePageShell";

function Section({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <section className="rounded-xl border border-line/60 bg-surface-1/40">
      <header className="border-b border-line/50 px-4 py-2.5">
        <h2 className="text-12 font-medium text-fg">{title}</h2>
        {description && (
          <p className="mt-0.5 text-10 leading-4 text-fg-subtle">{description}</p>
        )}
      </header>
      <div className="space-y-3 px-4 py-3">{children}</div>
    </section>
  );
}

function Row({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-start gap-x-4 gap-y-1.5">
      <div className="min-w-[190px] flex-1">
        <p className="text-11 text-fg">{label}</p>
        {hint && <p className="mt-0.5 text-10 leading-4 text-fg-subtle">{hint}</p>}
      </div>
      <div className="w-[220px] shrink-0">{children}</div>
    </div>
  );
}

function Toggle({
  label,
  description,
  checked,
  disabled,
  onChange,
}: {
  label: string;
  description?: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <div className={cn("flex items-start gap-3", disabled && "opacity-50")}>
      <div className="min-w-0 flex-1">
        <p className="text-11 text-fg">{label}</p>
        {description && (
          <p className="mt-0.5 text-10 leading-4 text-fg-subtle">{description}</p>
        )}
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={cn(
          "relative mt-0.5 h-4 w-7 shrink-0 rounded-full transition-colors",
          checked ? "bg-accent/75" : "bg-surface-active",
        )}
      >
        <span
          className={cn(
            "absolute top-0.5 size-3 rounded-full bg-surface-1 transition-[left]",
            checked ? "left-3.5" : "left-0.5",
          )}
        />
      </button>
    </div>
  );
}

function SelectBox<T extends string | number>({
  value,
  options,
  onChange,
  disabled,
  testId,
}: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (next: T) => void;
  disabled?: boolean;
  testId?: string;
}) {
  return (
    <Select
      className="w-full"
      testId={testId}
      value={String(value)}
      disabled={disabled}
      options={options.map((item) => ({
        value: String(item.value),
        label: item.label,
      }))}
      onChange={(raw) => {
        const found = options.find((item) => String(item.value) === raw);
        if (found) onChange(found.value);
      }}
    />
  );
}

export function ExtremeSettingsPage({
  onBack,
  onManagePermissions,
  onManageMcp,
}: {
  onBack: () => void;
  onManagePermissions: () => void;
  onManageMcp: () => void;
}) {
  const { t } = useTranslation();
  const settings = useExtremeSettingsStore();
  const workspaceId = useExtremeStore((state) => state.workspaceId);
  const chatPrefs = useExtremeStore((state) => state.chatPrefs);
  const modelSettings = useExtremeStore((state) => state.modelSettings);
  const modelOverrides = useExtremeStore((state) => state.modelSettingsByWorkspace);
  const setProviderId = useExtremeStore((state) => state.setProviderId);
  const resetChatPreference = useExtremeStore((state) => state.resetChatPreference);
  const resetModelSetting = useExtremeStore((state) => state.resetModelSetting);
  const [providers, setProviders] = useState<ProviderChoice[]>([]);

  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const list = await opsApi.aiProviderList();
        if (!live || !Array.isArray(list)) return;
        setProviders(
          list
            .filter((item) => item.enabled)
            .map((item) => ({
              id: item.id,
              name: item.name,
              model: item.model,
              isDefault: item.is_default,
              updatedAt: item.updated_at,
              contextWindow: item.context_window ?? 0,
              budgets: item.context_budgets ?? [],
              efforts: (item.reasoning_efforts ?? []).filter(
                (effort): effort is ProviderChoice["efforts"][number] =>
                  effort === "low" ||
                  effort === "medium" ||
                  effort === "high" ||
                  effort === "max",
              ),
              capabilityKnown: item.capability_known ?? true,
            })),
        );
      } catch {
        // 没有模型：下面的默认项只剩「自动」。
      }
    })();
    return () => {
      live = false;
    };
  }, []);

  const defaultProvider = useMemo(
    () => effectiveProvider(providers, null),
    [providers],
  );
  const activeProvider = useMemo(
    () => effectiveProvider(providers, chatPrefs.providerId),
    [providers, chatPrefs.providerId],
  );
  const activeKey = activeProvider
    ? modelKey(activeProvider.id, activeProvider.model)
    : null;
  const activeSetting: ModelSetting | null = activeKey
    ? effectiveModelSetting(
        { workspaceId, modelSettings, modelSettingsByWorkspace: modelOverrides },
        activeKey,
      )
    : null;
  const hasModelOverride = Boolean(
    activeKey && workspaceId && modelOverrides[workspaceId]?.[activeKey],
  );

  const effortOptions = useMemo(
    () => [
      { value: "auto" as const, label: t("默认") },
      ...effortTiers((defaultProvider?.efforts ?? []).map(String)).map((tier) => ({
        value: tier.value,
        // 档位标签是中文常量（低 / 中 / 高）：这里必须过 t()，否则英文界面漏中文。
        label: tier.label === "MAX" ? "MAX" : t(tier.label),
      })),
    ],
    [defaultProvider, t],
  );
  const budgetOptions = useMemo(
    () => [
      { value: 0, label: t("自动") },
      ...contextOptions(defaultProvider?.budgets ?? []).map((value) => ({
        value,
        label: formatTokens(value),
      })),
    ],
    [defaultProvider, t],
  );

  // 模型能力变化后，旧默认档可能已不在菜单里：界面显示回退值，保存值由后端校验。
  const effortValue = effortOptions.some((item) => item.value === settings.defaultEffort)
    ? settings.defaultEffort
    : "auto";
  const budgetValue =
    settings.defaultBudget !== null &&
    budgetOptions.some((item) => item.value === settings.defaultBudget)
      ? settings.defaultBudget
      : 0;

  const updateDefaultContext = (context: ContextMode) => {
    settings.update({ defaultContext: context });
    // 没有显式自定义的会话跟着默认走；自定义的保持不变。
    useExtremeStore.getState().applyDefaultChatPrefs();
  };
  const updateDefaultOutput = (output: OutputStyle) => {
    settings.update({ defaultOutput: output });
    useExtremeStore.getState().applyDefaultChatPrefs();
  };

  return (
    <ExtremePageShell
      title="设置"
      description="模型、对话、执行、通知与界面偏好"
      onBack={onBack}
    >
      <div className="flex flex-col gap-3">
        <Section
          title={t("模型与供应商")}
          description={t("这里是超能模式的模型默认与能力来源；普通模式不再单独提供入口，但仍读取同一份配置。")}
        >
          <AiProviderSettings />
        </Section>

        <Section
          title={t("对话与上下文")}
          description={t("默认值用于新任务；当前会话可在输入框底栏覆盖，下面会显示实际生效值。")}
        >
          <Row
            label={t("默认上下文范围")}
            hint={t("当前会话带上本对话历史、工具结果与附件；仅本条不带历史；自选带勾选材料。启用时，全局记忆独立生效。")}
          >
            <SelectBox
              testId="default-context"
              value={settings.defaultContext}
              options={[
                { value: "session", label: t("当前会话") },
                { value: "only", label: t("仅本条") },
                { value: "picked", label: t("发送前自选") },
              ]}
              onChange={updateDefaultContext}
            />
          </Row>
          <Row
            label={t("默认回复详略")}
            hint={t("只影响回答的写法；命令、路径、日志与错误原文保持可复制。")}
          >
            <SelectBox
              testId="default-output"
              value={settings.defaultOutput}
              options={[
                { value: "auto", label: t("自动") },
                { value: "brief", label: t("简洁结论") },
                { value: "detailed", label: t("详细说明") },
                { value: "structured", label: t("结构化结果") },
              ]}
              onChange={updateDefaultOutput}
            />
          </Row>
          <Row
            label={t("默认回复语言")}
            hint={t("跟随输入使用界面语言；固定语言会覆盖界面语言，仅影响回答正文。")}
          >
            <SelectBox
              testId="default-language"
              value={settings.replyLanguage}
              options={[
                { value: "auto", label: t("跟随输入") },
                { value: "zh", label: t("中文") },
                { value: "en", label: t("英文") },
              ]}
              onChange={(value: ReplyLanguage) => settings.update({ replyLanguage: value })}
            />
          </Row>
          <Row
            label={t("默认思考强度")}
            hint={t("新任务继承；MAX 仍会触发强制计划。切换模型时按模型实际支持的档位校验。")}
          >
            <SelectBox
              testId="default-effort"
              value={effortValue}
              options={effortOptions}
              onChange={(value) => settings.update({ defaultEffort: value })}
            />
          </Row>
          <Row
            label={t("默认上下文预算")}
            hint={t("只影响本轮带入多少内容；模型窗口与最大输出仍由后端按模型能力校验。")}
          >
            <SelectBox
              testId="default-budget"
              value={budgetValue}
              options={budgetOptions}
              onChange={(value) => settings.update({ defaultBudget: value === 0 ? null : value })}
            />
          </Row>

          <div className="rounded-lg border border-line/50 px-3 py-2">
            <div className="flex items-center gap-2">
              <p className="text-11 text-fg">{t("当前会话覆盖")}</p>
              <span className="text-10 text-fg-subtle">
                {workspaceId ? t("输入框底栏与此处共用") : t("当前没有打开的对话")}
              </span>
            </div>
            <div className="mt-1.5 space-y-1">
              {[
                {
                  key: "model",
                  label: t("模型"),
                  value: activeProvider
                    ? `${activeProvider.name} · ${activeProvider.model}`
                    : t("跟随默认"),
                  custom: Boolean(chatPrefs.providerId),
                  reset: () => setProviderId(null),
                },
                {
                  key: "context",
                  label: t("上下文范围"),
                  value:
                    chatPrefs.contextCustom === false
                      ? t("跟随默认")
                      : chatPrefs.context === "session"
                        ? t("当前会话")
                        : chatPrefs.context === "only"
                          ? t("仅本条")
                          : t("发送前自选"),
                  custom: chatPrefs.contextCustom !== false,
                  reset: () => resetChatPreference("context"),
                },
                {
                  key: "output",
                  label: t("回复详略"),
                  value:
                    chatPrefs.outputCustom === false
                      ? t("跟随默认")
                      : chatPrefs.output === "brief"
                        ? t("简洁结论")
                        : chatPrefs.output === "detailed"
                          ? t("详细说明")
                          : chatPrefs.output === "structured"
                            ? t("结构化结果")
                            : t("自动"),
                  custom: chatPrefs.outputCustom !== false,
                  reset: () => resetChatPreference("output"),
                },
                {
                  key: "thinking",
                  label: t("思考 / 预算"),
                  value: activeSetting
                    ? `${activeSetting.effort === "auto" ? t("默认") : activeSetting.effort} · ${
                        activeSetting.budget ? formatTokens(activeSetting.budget) : t("自动")
                      }`
                    : t("未配置"),
                  custom: hasModelOverride,
                  reset: () => activeKey && resetModelSetting(activeKey),
                },
              ].map((item) => (
                <div key={item.key} className="flex items-center gap-2 text-11">
                  <span className="w-20 shrink-0 text-fg-subtle">{item.label}</span>
                  <span className="min-w-0 flex-1 truncate text-fg">{item.value}</span>
                  <span className="shrink-0 text-9 text-fg-subtle">
                    {item.custom ? t("自定义") : t("跟随默认")}
                  </span>
                  {item.custom && (
                    <button
                      type="button"
                      className="shrink-0 text-10 text-accent hover:underline"
                      onClick={item.reset}
                      disabled={!workspaceId}
                    >
                      {t("恢复默认")}
                    </button>
                  )}
                </div>
              ))}
            </div>
            <p className="mt-1.5 text-10 leading-4 text-fg-subtle">
              {t("点击输入框的上下文用量可查看历史、附件、工具结果与裁剪情况；当前上下文和任务累计分别统计。")}
            </p>
          </div>
        </Section>

        <Section
          title={t("执行与计划")}
          description={t("计划卡显隐与工具详情默认展开只影响界面；权限与审批仍在「权限」页。")}
        >
          <Row
            label={t("计划卡")}
            hint={t("「生成后展开」只在第一份计划出现时展开一次；手动收起后进度更新不再抢焦点。")}
          >
            <SelectBox
              testId="plan-card-mode"
              value={settings.planCard}
              options={[
                { value: "expand", label: t("生成后展开") },
                { value: "collapsed", label: t("默认收起") },
              ]}
              onChange={(value: PlanCardMode) => settings.update({ planCard: value })}
            />
          </Row>
          <Row
            label={t("工具详情")}
            hint={t("普通命令行的默认展开状态；当前对话里手动展开优先，失败原因和待确认操作始终可见。")}
          >
            <SelectBox
              testId="tool-detail-mode"
              value={settings.toolDetails}
              options={[
                { value: "collapsed", label: t("默认折叠") },
                { value: "expanded", label: t("默认展开") },
              ]}
              onChange={(value: ToolDetailMode) => settings.update({ toolDetails: value })}
            />
          </Row>
          <Row
            label={t("执行前说明")}
            hint={t("每组操作开始前保留一句简短说明；相同目的连续命令共用一次，目的改变时再补。")}
          >
            <span className="text-11 text-fg-muted">{t("始终开启")}</span>
          </Row>
          <div className="flex flex-wrap gap-2 border-t border-line/50 pt-2">
            <Button variant="ghost" size="sm" onClick={onManagePermissions}>
              {t("管理权限与备份")}
            </Button>
            <Button variant="ghost" size="sm" onClick={onManageMcp}>
              {t("管理 MCP 连接")}
            </Button>
          </div>
        </Section>

        <Section
          title={t("通知")}
          description={t("只在主窗口最小化、隐藏或收进托盘时发桌面通知；主窗口可见时只在会话里显示状态。重进与历史恢复不补发。")}
        >
          <Toggle
            label={t("后台通知")}
            description={t("总开关；关闭后三类通知都不发。")}
            checked={settings.notifications.enabled}
            onChange={(enabled) => settings.setNotification({ enabled })}
          />
          <Toggle
            label={t("等待确认")}
            description={t("待确认通知可以直接允许或拒绝，与聊天审批卡共用同一个审批 ID。")}
            checked={settings.notifications.approval}
            disabled={!settings.notifications.enabled}
            onChange={(approval) => settings.setNotification({ approval })}
          />
          <Toggle
            label={t("任务完成")}
            description={t("点击通知回到对应任务。")}
            checked={settings.notifications.success}
            disabled={!settings.notifications.enabled}
            onChange={(success) => settings.setNotification({ success })}
          />
          <Toggle
            label={t("任务失败")}
            description={t("点击通知回到失败的任务与真实错误。")}
            checked={settings.notifications.failed}
            disabled={!settings.notifications.enabled}
            onChange={(failed) => settings.setNotification({ failed })}
          />
        </Section>

        <Section title={t("界面与动效")}>
          <Toggle
            label={t("跟随最新回复")}
            description={t("在底部时平滑跟随；向上阅读时暂停，点「回到底部」恢复。")}
            checked={settings.followLatest}
            onChange={(followLatest) => settings.update({ followLatest })}
          />
          <Row
            label={t("新任务右侧工作区")}
            hint={t("只决定新建任务的默认展开；已有会话仍保留自己的标签、宽度与展开状态。")}
          >
            <SelectBox
              testId="new-task-pane"
              value={settings.newTaskPane}
              options={[
                { value: "closed", label: t("收起") },
                { value: "open", label: t("打开") },
              ]}
              onChange={(value: NewTaskPane) => settings.update({ newTaskPane: value })}
            />
          </Row>
          <Row
            label={t("动效")}
            hint={t("跟随系统会尊重系统的减弱动效偏好；减弱后只压缩时长，不改变结果。")}
          >
            <SelectBox
              testId="motion-mode"
              value={settings.motion}
              options={[
                { value: "system", label: t("跟随系统") },
                { value: "reduced", label: t("减弱动效") },
              ]}
              onChange={(value: MotionMode) => settings.update({ motion: value })}
            />
          </Row>
        </Section>

        <p className="px-1 pb-2 text-10 leading-4 text-fg-subtle">
          {t("默认值只影响之后新建的任务；当前会话可用上面的「恢复默认」逐项切换。模型与连接测试仍需保存成功后才生效。")}
        </p>
      </div>
    </ExtremePageShell>
  );
}
