/**
 * P5.5.1 —— 设置里的 **AI 模型** 管理区。
 *
 * # 密钥的边界（写进这一层的形状里）
 *
 * 前端拿到的只有 `has_api_key` 这一个布尔值：
 * * **没有**读取 API Key 的接口；
 * * 编辑时输入框**不回显**原 Key（留空 = 保留原 Key）；
 * * 新建必须填 Key，之后它只存在于系统凭据管理器；
 * * 所有错误都过 `toErrorMessage`：不显示请求头、原始响应或密钥。
 *
 * # 连接测试
 *
 * 由 Rust 侧发一次最小请求，只回状态 / 耗时 / 脱敏错误 / 真实尝试次数。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Check, ChevronRight, PlugZap, Plus, Trash2 } from "@/components/icons";

import {
  opsApi,
  type AiProviderSaveRequest,
  type AiProviderTestResult,
  type AiProviderView,
} from "@/api/ops-api";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { ErrorState } from "@/components/ui/error-state";
import { Field, Modal, fieldClass } from "@/components/ui/modal";
import { useActionError } from "@/hooks/use-action-error";
import { Tooltip } from "@/components/ui/tooltip";
import { cn } from "@/lib/cn";

import { EmptyRow, Group, ListGroup } from "./settings-parts";

/**
 * 能力从哪来。
 *
 * * `auto` —— **自动识别**：不写显式能力，菜单与请求都按内置能力表；
 * * `manual` —— **手动覆盖**：只把用户勾选的档位写进配置；
 * * `provider` —— **由供应商决定**：显式声明"没有可调档位"，请求不带
 *   `reasoning_effort` / `context_budget`，句子照常发。
 *
 * 新建默认 `auto`。编辑旧配置时**保留原来的模式**：普通保存不能凭空产生
 * 覆盖值（那会把"未知模型"写成"支持四档 + 1M 预算"）。
 */
type CapabilityMode = "auto" | "manual" | "provider";

type Draft = {
  /** `null` = 新建。 */
  id: string | null;
  name: string;
  base_url: string;
  model: string;
  /** 空 = 保留原 Key（编辑时）／新建时必须填。 */
  api_key: string;
  enabled: boolean;
  is_default: boolean;
  allow_insecure_http: boolean;
  timeout_seconds: number;
  max_output_tokens: number;
  capabilityMode: CapabilityMode;
  /** 该模型支持的思考强度（点选，不手输）。 */
  efforts: string[];
  /** 菜单里可选的上下文档位（点选，不手输）。 */
  budgets: number[];
};

/**
 * 思考强度预设。
 *
 * 后端只认这四个值（`reasoning_effort` 的协议枚举），界面上把最高档叫 MAX
 * —— 和极核输入区里的菜单同一套叫法，用户不用记协议里的英文。
 */
const EFFORT_PRESETS: { value: string; label: string }[] = [
  { value: "low", label: "低" },
  { value: "medium", label: "中" },
  { value: "high", label: "高" },
  { value: "max", label: "MAX" },
];

/**
 * 上下文档位预设：覆盖常见窗口档，用户点选即可。
 *
 * 预设会把自己用到的档位填进来；这里必须列全，否则"已选中但界面上没有
 * 对应胶囊"，用户既看不见也改不掉。
 *
 * 不提供"自己填 token 数"：填错一位（300000 而不是 307200）会让请求在窗口
 * 边缘被服务端拒绝，而且菜单上写 300K、请求里是 300000 也说不清。
 */
const BUDGET_PRESETS: { tokens: number; label: string }[] = [
  { tokens: 64 * 1024, label: "64K" },
  { tokens: 128 * 1024, label: "128K" },
  { tokens: 200 * 1024, label: "200K" },
  { tokens: 256 * 1024, label: "256K" },
  { tokens: 300 * 1024, label: "300K" },
  { tokens: 400 * 1024, label: "400K" },
  { tokens: 600 * 1024, label: "600K" },
  { tokens: 1024 * 1024, label: "1M" },
];

/**
 * 常用模型预设。
 *
 * **名字里不写版本号**：版本一个月一变，写死就会立刻过时；模型 ID 用各家
 * 的 latest 别名或当前版本，用户也能直接改。列表只是"少填几个字段"，
 * 不是能力承诺。
 */
type ModelPreset = {
  id: string;
  name: string;
  hint: string;
  base_url: string;
  model: string;
  efforts: string[];
  budgets: number[];
};

const MODEL_PRESETS: ModelPreset[] = [
  {
    id: "deepseek",
    name: "DeepSeek",
    hint: "api.deepseek.com · latest chat alias",
    base_url: "https://api.deepseek.com/v1",
    // `deepseek-chat` 是官方跟随最新版的别名，不把 4.1 / 4.2 写进预设。
    model: "deepseek-chat",
    efforts: ["low", "high", "max"],
    budgets: [300 * 1024, 600 * 1024, 1024 * 1024],
  },
  {
    id: "deepseek-reasoner",
    name: "DeepSeek Reasoner",
    hint: "api.deepseek.com · latest reasoner alias",
    base_url: "https://api.deepseek.com/v1",
    model: "deepseek-reasoner",
    efforts: ["low", "high", "max"],
    budgets: [300 * 1024, 600 * 1024, 1024 * 1024],
  },
  {
    id: "openai-gpt",
    name: "OpenAI GPT",
    hint: "api.openai.com · gpt-6",
    base_url: "https://api.openai.com/v1",
    model: "gpt-6",
    efforts: ["low", "medium", "high"],
    budgets: [128 * 1024, 256 * 1024, 400 * 1024],
  },
  {
    id: "qwen",
    name: "Qwen",
    hint: "DashScope compatible · qwen-max (latest alias)",
    base_url: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    model: "qwen-max",
    efforts: ["low", "medium", "high"],
    budgets: [128 * 1024, 256 * 1024],
  },
  {
    id: "glm",
    name: "GLM",
    hint: "open.bigmodel.cn · glm-5.3",
    base_url: "https://open.bigmodel.cn/api/paas/v4",
    model: "glm-5.3",
    efforts: ["low", "medium", "high", "max"],
    budgets: [300 * 1024, 600 * 1024, 1024 * 1024],
  },
  {
    id: "glm-flash",
    name: "GLM Flash",
    hint: "open.bigmodel.cn · glm-5.3-flash",
    base_url: "https://open.bigmodel.cn/api/paas/v4",
    model: "glm-5.3-flash",
    efforts: ["low", "medium", "high", "max"],
    budgets: [300 * 1024, 600 * 1024, 1024 * 1024],
  },
  {
    id: "kimi",
    name: "Kimi",
    hint: "api.moonshot.cn · kimi-k3.1-pro",
    base_url: "https://api.moonshot.cn/v1",
    model: "kimi-k3.1-pro",
    efforts: ["low", "medium", "high", "max"],
    budgets: [300 * 1024, 600 * 1024, 1024 * 1024],
  },
  {
    id: "openrouter",
    name: "OpenRouter",
    hint: "openrouter.ai · latest DeepSeek alias",
    base_url: "https://openrouter.ai/api/v1",
    model: "deepseek/deepseek-chat",
    efforts: ["low", "medium", "high"],
    budgets: [64 * 1024, 128 * 1024],
  },
];

function emptyDraft(): Draft {
  return {
    id: null,
    name: "",
    base_url: "",
    model: "",
    api_key: "",
    enabled: true,
    is_default: false,
    allow_insecure_http: false,
    timeout_seconds: 30,
    max_output_tokens: 1200,
    /*
     * **新建默认自动识别**：什么都不勾，保存时也不写显式能力。
     *
     * 以前新建默认勾满四档强度 + 三个预算（含 1M）：接一个未知模型就会把
     * "我们并不知道它支持什么"写成"它支持这些"。
     */
    capabilityMode: "auto",
    efforts: [],
    budgets: [],
  };
}

function draftFrom(provider: AiProviderView): Draft {
  const declaredEfforts = provider.reasoning_efforts ?? [];
  // 旧配置可能带重复档位：回显时先去重，保存时也不会再写回去。
  const declaredBudgets = [...new Set(provider.context_budgets ?? [])].sort((a, b) => a - b);
  /*
   * **保留原来的模式**。
   *
   * `capability_overridden === false` = 从未声明过（新加字段的旧记录 / 内置表
   * 命中）：进"自动识别"，保存时仍然不写覆盖值。
   *
   * 声明过但两样都是空的 = 用户选了"由供应商决定"（显式空声明）。
   */
  const overridden = provider.capability_overridden === true;
  const capabilityMode: CapabilityMode = !overridden
    ? "auto"
    : declaredEfforts.length === 0 && declaredBudgets.length === 0
      ? "provider"
      : "manual";
  return {
    id: provider.id,
    name: provider.name,
    base_url: provider.base_url,
    model: provider.model,
    // 不回显原 Key；留空即保留。
    api_key: "",
    enabled: provider.enabled,
    is_default: provider.is_default,
    allow_insecure_http: provider.allow_insecure_http,
    timeout_seconds: provider.timeout_seconds,
    max_output_tokens: provider.max_output_tokens,
    capabilityMode,
    // 非手动覆盖时不回填任何档位：菜单来自内置表 / 供应商默认。
    efforts: capabilityMode === "manual" ? declaredEfforts : [],
    budgets: capabilityMode === "manual" ? declaredBudgets : [],
  };
}

export function AiProviderSettings() {
  const { t } = useTranslation();
  const [providers, setProviders] = useState<AiProviderView[] | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<AiProviderView | null>(null);
  const [deleteSecret, setDeleteSecret] = useState(false);
  const [busy, setBusy] = useState(false);
  // 原始异常 + 可重试：模型连通性失败要能看清是网络、鉴权还是地址写错。
  const { error, fail, clear, retry } = useActionError();
  const [results, setResults] = useState<Record<string, AiProviderTestResult>>({});

  const load = useCallback(async () => {
    const list = await opsApi.aiProviderList();
    setProviders(list);
    return list;
  }, []);

  useEffect(() => {
    void load().catch((cause) => fail(cause, () => void load()));
  }, [load, fail]);

  const test = async (provider: AiProviderView) => {
    setBusy(true);
    clear();
    try {
      const result = await opsApi.aiProviderTest(provider.id);
      setResults((current) => ({ ...current, [provider.id]: result }));
    } catch (cause) {
      fail(cause, () => void test(provider));
    } finally {
      setBusy(false);
    }
  };

  const makeDefault = async (provider: AiProviderView) => {
    setBusy(true);
    clear();
    try {
      await opsApi.aiProviderSetDefault(provider.id);
      await load();
    } catch (cause) {
      fail(cause, () => void makeDefault(provider));
    } finally {
      setBusy(false);
    }
  };

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    setBusy(true);
    clear();
    try {
      await opsApi.aiProviderDelete(deleteTarget.id, deleteSecret);
      setDeleteTarget(null);
      setDeleteSecret(false);
      await load();
    } catch (cause) {
      fail(cause, () => void confirmDelete());
    } finally {
      setBusy(false);
    }
  };

  return (
    <Group
      title={t("AI models")}
      hint={t("Models only review deployment proposals; they never execute anything.")}
      action={
        <Tooltip label={t("Add model")}>
          <Button
            variant="ghost"
            size="xs"
            className="h-6 px-1.5"
            aria-label={t("Add model")}
            onClick={() => setDraft(emptyDraft())}
          >
            <Plus size={13} />
          </Button>
        </Tooltip>
      }
    >
      {error ? <ErrorState error={error} compact onRetry={retry} className="px-3 pb-1" /> : null}
      <ListGroup>
        {providers === null ? (
          <EmptyRow>{t("Loading")}</EmptyRow>
        ) : providers.length === 0 ? (
          <EmptyRow>{t("No models yet")}</EmptyRow>
        ) : (
          providers.map((provider) => (
            <div
              key={provider.id}
              className="group flex flex-col gap-1 px-3 py-2 transition-colors hover:bg-surface-hover/60"
            >
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  data-testid={`ai-edit-${provider.id}`}
                  className="flex min-w-0 flex-1 items-center gap-2.5 text-left"
                  onClick={() => setDraft(draftFrom(provider))}
                >
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-1.5">
                      <span className="truncate text-12 text-fg">{provider.name}</span>
                      {provider.is_default ? (
                        <span className="shrink-0 rounded bg-accent/10 px-1 text-9 text-accent">
                          {t("Default")}
                        </span>
                      ) : null}
                      {!provider.enabled ? (
                        <span className="shrink-0 text-9 text-fg-subtle">{t("Disabled")}</span>
                      ) : null}
                    </span>
                    <span className="block truncate text-11 text-fg-subtle">
                      {provider.model} · {provider.base_url} ·{" "}
                      {provider.has_api_key ? t("Key saved") : t("Key missing")}
                    </span>
                  </span>
                  <ChevronRight size={13} className="shrink-0 text-fg-subtle" />
                </button>

                <Tooltip label={t("Test connection")} side="left">
                  <button
                    type="button"
                    aria-label={t("Test connection")}
                    data-testid={`ai-test-${provider.id}`}
                    disabled={busy}
                    className="shrink-0 rounded p-1 text-fg-subtle hover:text-fg disabled:opacity-50"
                    onClick={() => void test(provider)}
                  >
                    <PlugZap size={12} />
                  </button>
                </Tooltip>

                {!provider.is_default && provider.enabled ? (
                  <Tooltip label={t("Set as default")} side="left">
                    <button
                      type="button"
                      aria-label={t("Set as default")}
                      data-testid={`ai-default-${provider.id}`}
                      disabled={busy}
                      className="shrink-0 rounded p-1 text-fg-subtle hover:text-fg disabled:opacity-50"
                      onClick={() => void makeDefault(provider)}
                    >
                      <Check size={12} />
                    </button>
                  </Tooltip>
                ) : null}

                <Tooltip label={t("Delete model provider")} side="left">
                  <button
                    type="button"
                    aria-label={t("Delete model provider")}
                    data-testid={`ai-delete-${provider.id}`}
                    className="shrink-0 rounded p-1 text-fg-subtle opacity-0 hover:text-danger group-hover:opacity-100"
                    onClick={() => {
                      setDeleteTarget(provider);
                      setDeleteSecret(false);
                    }}
                  >
                    <Trash2 size={12} />
                  </button>
                </Tooltip>
              </div>

              {results[provider.id] ? (
                <p
                  className={cn(
                    "pl-9 text-10",
                    results[provider.id].ok ? "text-fg-muted" : "text-danger",
                  )}
                >
                  {results[provider.id].ok
                    ? t("Connection OK ({{ms}} ms, {{attempts}} attempt(s))", {
                        ms: results[provider.id].latency_ms,
                        attempts: results[provider.id].attempts,
                      })
                    : results[provider.id].message}
                </p>
              ) : null}
            </div>
          ))
        )}
      </ListGroup>

      {draft ? (
        <AiProviderForm
          draft={draft}
          onChange={setDraft}
          onClose={() => setDraft(null)}
          onSaved={async () => {
            setDraft(null);
            await load();
          }}
        />
      ) : null}

      {deleteTarget ? (
        <ConfirmDialog
          open
          danger
          title={t("Delete model provider")}
          description={t('Delete "{{name}}"? The saved configuration is removed.', {
            name: deleteTarget.name,
          })}
          confirmLabel={t("Delete")}
          pending={busy}
          onCancel={() => {
            setDeleteTarget(null);
            setDeleteSecret(false);
          }}
          onConfirm={() => void confirmDelete()}
        >
          <label className="mt-3 flex items-center gap-2 text-11 text-fg-muted">
            <input
              type="checkbox"
              data-testid="delete-secret"
              checked={deleteSecret}
              onChange={(event) => setDeleteSecret(event.target.checked)}
            />
            {t("Also delete the API key from the system credential manager")}
          </label>
        </ConfirmDialog>
      ) : null}
    </Group>
  );
}

function ChoicePill({
  selected,
  label,
  onClick,
}: {
  selected: boolean;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onClick}
      className={cn(
        "rounded-full border px-2.5 py-1 text-11 transition-colors",
        selected
          ? "border-accent/60 bg-accent/10 text-accent"
          : "border-line/60 bg-surface-1 text-fg-muted hover:text-fg",
      )}
    >
      {label}
    </button>
  );
}

function AiProviderForm({
  draft,
  onChange,
  onClose,
  onSaved,
}: {
  draft: Draft;
  onChange: (draft: Draft) => void;
  onClose: () => void;
  onSaved: () => Promise<void> | void;
}) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<AiProviderTestResult | null>(null);
  // 保存失败留在弹窗里（表单数据不丢），错误带阶段与恢复建议。
  const { error, fail, clear } = useActionError();
  const editing = draft.id !== null;
  const apiKeyRef = useRef<HTMLInputElement | null>(null);
  // 地址 / 模型 / Key 一变，上次测试结论就不再代表当前配置。
  useEffect(() => {
    setTestResult(null);
  }, [draft.base_url, draft.model, draft.api_key, draft.allow_insecure_http]);
  /** 当前字段正好等于哪个预设；手动改过地址/模型就自动回到 custom。 */
  const activePreset =
    MODEL_PRESETS.find(
      (preset) => preset.base_url === draft.base_url && preset.model === draft.model,
    )?.id ?? "custom";

  const applyPreset = (preset: ModelPreset) => {
    onChange({
      ...draft,
      name: preset.name,
      base_url: preset.base_url,
      model: preset.model,
      // 预设把上下文与思考强度也填好；用户仍可在下面点选调整。
      capabilityMode: "manual",
      efforts: [...preset.efforts],
      budgets: [...preset.budgets],
    });
    // 预设已把地址/模型填好，焦点直接落到唯一还要填的 Key 上。
    requestAnimationFrame(() => apiKeyRef.current?.focus());
  };

  const useCustom = () => {
    // 自定义只清空地址/模型/能力，不丢已经输入的 Key 与开关。
    onChange({
      ...emptyDraft(),
      api_key: draft.api_key,
      enabled: draft.enabled,
      is_default: draft.is_default,
    });
  };

  /** 保存与"先测一次"共用同一份请求体，避免两处校验漂移。 */
  const buildRequest = (): AiProviderSaveRequest => ({
    id: draft.id,
    name: draft.name.trim(),
    provider_kind: "openai_compatible",
    base_url: draft.base_url.trim(),
    model: draft.model.trim(),
    // 空 = 保留原 Key（前端不回显，也不会读）。
    api_key: draft.api_key.trim() ? draft.api_key : null,
    enabled: draft.enabled,
    is_default: draft.is_default,
    allow_insecure_http: draft.allow_insecure_http,
    timeout_seconds: draft.timeout_seconds,
    max_output_tokens: draft.max_output_tokens,
    /*
     * 能力声明**只按当前模式**写：
     * * 自动识别 —— 一律 `null`，交给内置表（未知模型保持未知）；
     * * 手动覆盖 —— 只写用户勾选的档位；窗口取所选预算的最大档；
     * * 由供应商决定 —— 显式空数组（等于"没有可调档位"），请求不带参数。
     *
     * 这条边界是"普通保存不能凭空产生覆盖值"的落点。
     */
    context_window:
      draft.capabilityMode === "manual" && draft.budgets.length > 0
        ? Math.max(...draft.budgets)
        : null,
    context_budgets:
      draft.capabilityMode === "manual"
        ? [...new Set(draft.budgets)].sort((a, b) => a - b)
        : draft.capabilityMode === "provider"
          ? []
          : null,
    // 按预设顺序输出（后端也按升序用），避免点击顺序影响能力表。
    reasoning_efforts:
      draft.capabilityMode === "manual"
        ? EFFORT_PRESETS.filter((item) => draft.efforts.includes(item.value)).map(
            (item) => item.value,
          )
        : draft.capabilityMode === "provider"
          ? []
          : null,
  });

  const submit = async () => {
    setBusy(true);
    clear();
    try {
      await opsApi.aiProviderSave(buildRequest());
      await onSaved();
    } catch (cause) {
      fail(cause, () => void submit());
    } finally {
      setBusy(false);
    }
  };

  /**
   * 先测连通性，不保存。
   *
   * 新建时必须有 Key；编辑时留空则后端临时读一次已保存的 Key。测试用的
   * 明文 Key 只在这次请求的内存里，不落库、不写钥匙串。
   */
  const testDraft = async () => {
    setTesting(true);
    clear();
    setTestResult(null);
    try {
      const result = await opsApi.aiProviderTestDraft(buildRequest());
      setTestResult(result);
    } catch (cause) {
      fail(cause, () => void testDraft());
    } finally {
      setTesting(false);
    }
  };

  const canTest =
    Boolean(draft.base_url.trim() && draft.model.trim()) &&
    (editing || Boolean(draft.api_key.trim()));

  return (
    <Modal
      open
      width={520}
      className="settings-ai-modal"
      title={editing ? t("Edit model") : t("Add model")}
      onClose={onClose}
    >
      {/* 滚动交给 Modal 自己的内容区（`max-h-[60vh] overflow-y-auto`）——
          这里再套一层 overflow 会同时出现内外两个滚动条。 */}
      <div className="settings-ai-form flex flex-col gap-3">
        {error ? <ErrorState error={error} compact /> : null}

        {!editing && (
          <div>
            <p className="text-12 font-medium text-fg">{t("Quick add")}</p>
            <p className="mt-0.5 text-11 leading-relaxed text-fg-subtle">
              {t("Pick a preset and fill in only the API Key; presets use each provider's latest alias rather than a fixed version, and the model ID is still editable.")}
            </p>
            <div className="mt-2 grid grid-cols-2 gap-1.5">
              {MODEL_PRESETS.map((preset) => {
                const selected = activePreset === preset.id;
                return (
                  <button
                    key={preset.id}
                    type="button"
                    data-testid={`preset-${preset.id}`}
                    aria-pressed={selected}
                    onClick={() => applyPreset(preset)}
                    className={cn(
                      "min-w-0 rounded-lg border px-2.5 py-1.5 text-left transition-colors",
                      selected
                        ? "border-accent/60 bg-accent/10 text-accent"
                        : "border-line/60 bg-surface-1 text-fg-muted hover:bg-surface-hover hover:text-fg",
                    )}
                  >
                    <span className="flex min-w-0 items-center gap-2">
                      <span className="min-w-0">
                        <span className="block truncate text-12">{preset.name}</span>
                        <span className="block truncate text-10 text-fg-subtle">
                          {preset.hint}
                        </span>
                      </span>
                    </span>
                  </button>
                );
              })}
              <button
                type="button"
                data-testid="preset-custom"
                aria-pressed={activePreset === "custom"}
                onClick={useCustom}
                className={cn(
                  "min-w-0 rounded-lg border px-2.5 py-1.5 text-left transition-colors",
                  activePreset === "custom"
                    ? "border-accent/60 bg-accent/10 text-accent"
                    : "border-line/60 bg-surface-1 text-fg-muted hover:bg-surface-hover hover:text-fg",
                )}
              >
                <span className="flex min-w-0 items-center gap-2">
                  <span className="min-w-0">
                    <span className="block text-12">{t("Custom")}</span>
                    <span className="block truncate text-10 text-fg-subtle">
                      {t("Enter your own base URL and model")}
                    </span>
                  </span>
                </span>
              </button>
            </div>
            {activePreset !== "custom" && (
              <p className="mt-1.5 text-10 text-fg-subtle">
                {t("Preset filled in — only the API Key is needed. You can still edit it from the list after saving.")}
              </p>
            )}
          </div>
        )}

        <Field label={t("Name")}>
          <input
            className={fieldClass}
            data-testid="provider-name"
            value={draft.name}
            onChange={(event) => onChange({ ...draft, name: event.target.value })}
          />
        </Field>

        <Field label={t("Provider type")}>
          <input className={fieldClass} value={t("OpenAI compatible")} readOnly disabled />
        </Field>

        <Field
          label={t("Base URL")}
          hint={t("Format: https://<host>/v1. Keep the provider’s API prefix. The app adds /chat/completions or /models automatically.")}
        >
          <input
            className={fieldClass}
            data-testid="provider-base-url"
            value={draft.base_url}
            onChange={(event) => onChange({ ...draft, base_url: event.target.value })}
          />
        </Field>

        <Field label={t("Model")}>
          <input
            className={fieldClass}
            data-testid="provider-model"
            value={draft.model}
            onChange={(event) => onChange({ ...draft, model: event.target.value })}
          />
        </Field>

        <Field
          label={t("API Key")}
          hint={
            editing
              ? t("Leave empty to keep the saved key. Keys are only written to the system credential manager.")
              : t("The key is written to the system credential manager only; the database keeps a reference.")
          }
        >
          <input
            ref={apiKeyRef}
            className={fieldClass}
            type="password"
            autoComplete="off"
            data-testid="provider-api-key"
            placeholder={editing ? t("Leave empty to keep the saved key") : ""}
            value={draft.api_key}
            onChange={(event) => onChange({ ...draft, api_key: event.target.value })}
          />
        </Field>

        <div className="grid grid-cols-2 gap-3">
          <Field label={t("Timeout (seconds)")}>
            <input
              className={fieldClass}
              type="number"
              min={5}
              max={180}
              data-testid="provider-timeout"
              value={draft.timeout_seconds}
              onChange={(event) =>
                onChange({ ...draft, timeout_seconds: Number(event.target.value) })
              }
            />
          </Field>
          <Field label={t("Max output tokens")}>
            <input
              className={fieldClass}
              type="number"
              min={128}
              max={8000}
              data-testid="provider-max-tokens"
              value={draft.max_output_tokens}
              onChange={(event) =>
                onChange({ ...draft, max_output_tokens: Number(event.target.value) })
              }
            />
          </Field>
        </div>

        {/*
         * 能力声明：先选**来源**，再决定要不要勾档位。
         *
         * 一律**点选**，不给手输：token 数填错一位就会在窗口边缘被服务端拒绝，
         * 而档位本来就只有协议里的四个枚举值。
         */}
        <div className="rounded-lg border border-line/60 p-2.5">
          <p className="text-11 text-fg-muted">{t("能力来源")}</p>
          <div className="mt-1.5 flex flex-wrap gap-1.5" data-testid="provider-capability-mode">
            {(
              [
                ["auto", t("自动识别")],
                ["manual", t("手动覆盖")],
                ["provider", t("由供应商决定")],
              ] as [CapabilityMode, string][]
            ).map(([mode, label]) => (
              <ChoicePill
                key={mode}
                selected={draft.capabilityMode === mode}
                label={label}
                onClick={() => onChange({ ...draft, capabilityMode: mode })}
              />
            ))}
          </div>
          <p className="mt-1.5 text-10 text-fg-subtle">
            {draft.capabilityMode === "auto"
              ? t("按内置能力表识别；认不出的模型沿用供应商默认设置，不写任何覆盖值。")
              : draft.capabilityMode === "provider"
                ? t("不写可调档位：请求不传思考强度与上下文预算，由供应商决定。")
                : t("只把下面勾选的档位写进配置，请求按这份声明发送。")}
          </p>

          {/* 手动覆盖才显示档位：其余两种模式下勾选没有意义。 */}
          {draft.capabilityMode === "manual" && (
            <>
              <p className="mt-3 text-11 text-fg-muted">{t("思考强度")}</p>
              <p className="mt-0.5 text-10 text-fg-subtle">
                {t("勾选该模型支持的档位，输入区的菜单只列出这些")}
              </p>
              <div className="mt-2 flex flex-wrap gap-1.5" data-testid="provider-efforts">
                {EFFORT_PRESETS.map((preset) => {
                  const selected = draft.efforts.includes(preset.value);
                  return (
                    <ChoicePill
                      key={preset.value}
                      selected={selected}
                      label={preset.label}
                      onClick={() =>
                        onChange({
                          ...draft,
                          efforts: selected
                            ? draft.efforts.filter((item) => item !== preset.value)
                            : [...draft.efforts, preset.value],
                        })
                      }
                    />
                  );
                })}
              </div>

              <p className="mt-3 text-11 text-fg-muted">{t("上下文档位")}</p>
              <p className="mt-0.5 text-10 text-fg-subtle">
                {t("输入区「上下文」菜单里可选的预算；窗口按最大档算")}
              </p>
              <div className="mt-2 flex flex-wrap gap-1.5" data-testid="provider-context-budgets">
                {BUDGET_PRESETS.map((preset) => {
                  const selected = draft.budgets.includes(preset.tokens);
                  return (
                    <ChoicePill
                      key={preset.tokens}
                      selected={selected}
                      label={preset.label}
                      onClick={() =>
                        onChange({
                          ...draft,
                          budgets: selected
                            ? draft.budgets.filter((item) => item !== preset.tokens)
                            : [...draft.budgets, preset.tokens],
                        })
                      }
                    />
                  );
                })}
              </div>
              {/* 勾了就按勾的送：模型真窗口更小时服务端会直接 400，这里先说清楚。 */}
              <p className="mt-2 text-10 text-fg-subtle">
                {t("只勾这个模型真实支持的档位；勾了超出窗口的档位，请求会被服务端拒绝。")}
              </p>
            </>
          )}
          {/*
           * 开关型接口（"开启 / 关闭思考"这类）没有做请求适配，就不在这里显示：
           * 打开了却发不出去，比没有这个开关更糟。
           */}
        </div>

        <label className="flex items-center gap-2 text-11 text-fg-muted">
          <input
            type="checkbox"
            data-testid="provider-enabled"
            checked={draft.enabled}
            onChange={(event) => onChange({ ...draft, enabled: event.target.checked })}
          />
          {t("Enabled")}
        </label>

        <label className="flex items-center gap-2 text-11 text-fg-muted">
          <input
            type="checkbox"
            data-testid="provider-default"
            checked={draft.is_default}
            onChange={(event) => onChange({ ...draft, is_default: event.target.checked })}
          />
          {t("Use as default")}
        </label>

        <label className="flex items-start gap-2 text-11 text-fg-muted">
          <input
            type="checkbox"
            data-testid="provider-insecure"
            checked={draft.allow_insecure_http}
            onChange={(event) =>
              onChange({ ...draft, allow_insecure_http: event.target.checked })
            }
          />
          <span>
            {t("Allow plain HTTP for non-local hosts")}
            <span className="mt-0.5 block text-10 text-fg-subtle">
              {t("Only enable this for a trusted self-hosted gateway on your own network.")}
            </span>
          </span>
        </label>

        {testResult && (
          <p
            role="status"
            className={cn(
              "text-11 leading-relaxed",
              testResult.ok ? "text-success" : "text-danger",
            )}
          >
            {testResult.ok
              ? t("Connection OK ({{ms}} ms, {{attempts}} attempt(s))", {
                  ms: testResult.latency_ms,
                  attempts: testResult.attempts,
                })
              : testResult.message}
          </p>
        )}

        <div className="flex items-center gap-2">
          <Button
            variant="ghost"
            size="sm"
            className="gap-1"
            disabled={busy || testing || !canTest}
            title={
              canTest
                ? t("Test connection")
                : t("Fill in the base URL, model and API key first")
            }
            onClick={() => void testDraft()}
            data-testid="provider-test-draft"
          >
            <PlugZap size={12} /> {testing ? t("Testing…") : t("Test connection")}
          </Button>
          <span className="flex-1" />
          <Button variant="ghost" size="sm" disabled={busy || testing} onClick={onClose}>
            {t("Cancel")}
          </Button>
          <Button
            size="sm"
            disabled={busy || testing}
            onClick={() => void submit()}
            data-testid="provider-save"
          >
            {busy ? t("Saving") : t("Save")}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
