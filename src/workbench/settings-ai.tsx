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
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Bot, Check, ChevronRight, PlugZap, Plus, Trash2 } from "lucide-react";

import { opsApi, toErrorMessage, type AiProviderTestResult, type AiProviderView } from "@/api/ops-api";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { ErrorText, Field, Modal, fieldClass } from "@/components/ui/modal";
import { Tooltip } from "@/components/ui/tooltip";
import { cn } from "@/lib/cn";

import { EmptyRow, Group, ListGroup } from "./settings-parts";

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
};

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
  };
}

function draftFrom(provider: AiProviderView): Draft {
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
  };
}

export function AiProviderSettings() {
  const { t } = useTranslation();
  const [providers, setProviders] = useState<AiProviderView[] | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<AiProviderView | null>(null);
  const [deleteSecret, setDeleteSecret] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [results, setResults] = useState<Record<string, AiProviderTestResult>>({});

  const load = useCallback(async () => {
    const list = await opsApi.aiProviderList();
    setProviders(list);
    return list;
  }, []);

  useEffect(() => {
    void load().catch((cause) => setError(toErrorMessage(cause)));
  }, [load]);

  const test = async (provider: AiProviderView) => {
    setBusy(true);
    setError(null);
    try {
      const result = await opsApi.aiProviderTest(provider.id);
      setResults((current) => ({ ...current, [provider.id]: result }));
    } catch (cause) {
      setError(toErrorMessage(cause));
    } finally {
      setBusy(false);
    }
  };

  const makeDefault = async (provider: AiProviderView) => {
    setBusy(true);
    setError(null);
    try {
      await opsApi.aiProviderSetDefault(provider.id);
      await load();
    } catch (cause) {
      setError(toErrorMessage(cause));
    } finally {
      setBusy(false);
    }
  };

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    setBusy(true);
    setError(null);
    try {
      await opsApi.aiProviderDelete(deleteTarget.id, deleteSecret);
      setDeleteTarget(null);
      setDeleteSecret(false);
      await load();
    } catch (cause) {
      setError(toErrorMessage(cause));
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
      {error ? <p className="px-3 pb-1 text-11 text-danger">{error}</p> : null}
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
                  <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-[8px] bg-surface-2 text-fg-subtle">
                    <Bot size={13} />
                  </span>
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
  const [error, setError] = useState<string | null>(null);
  const editing = draft.id !== null;

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await opsApi.aiProviderSave({
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
      });
      await onSaved();
    } catch (cause) {
      setError(toErrorMessage(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open
      width={440}
      title={editing ? t("Edit model") : t("Add model")}
      onClose={onClose}
    >
      <div className="flex max-h-[70vh] flex-col gap-3 overflow-auto ops-scroll">
        {error ? <ErrorText>{error}</ErrorText> : null}

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
          hint={t("For example https://api.example.com/v1; a self-hosted gateway usually allows plain HTTP on the local network.")}
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

        <div className="flex items-center justify-end gap-2">
          <Button variant="ghost" size="sm" disabled={busy} onClick={onClose}>
            {t("Cancel")}
          </Button>
          <Button size="sm" disabled={busy} onClick={() => void submit()} data-testid="provider-save">
            {busy ? t("Saving") : t("Save")}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
