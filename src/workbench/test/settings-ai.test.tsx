/**
 * P5.5.1 —— 设置页「AI 模型」管理测试。
 *
 * 覆盖：新建 / 编辑（不回显 Key、留空保留）/ 连接测试 / 设默认 / 删除（询问是否
 * 同步删除钥匙串密钥）/ 密钥状态展示。
 *
 * 与其它设置测试同一套约定：mock 里只列 opsApi 上真实存在的方法。
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import "@/i18n";

const listMock = vi.fn();
const saveMock = vi.fn();
const deleteMock = vi.fn();
const setDefaultMock = vi.fn();
const testMock = vi.fn();
const testDraftMock = vi.fn();

vi.mock("@/api/ops-api", () => ({
  toErrorMessage: (cause: unknown) => String(cause),
  opsApi: {
    aiProviderList: () => listMock(),
    aiProviderGet: async () => null,
    aiProviderSave: (...args: unknown[]) => saveMock(...args),
    aiProviderDelete: (...args: unknown[]) => deleteMock(...args),
    aiProviderSetDefault: (...args: unknown[]) => setDefaultMock(...args),
    aiProviderTest: (...args: unknown[]) => testMock(...args),
    aiProviderTestDraft: (...args: unknown[]) => testDraftMock(...args),
  },
}));

import { i18n } from "@/i18n";
import { AiProviderSettings } from "../settings-ai";

let container: HTMLDivElement;
let root: Root;

beforeAll(async () => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  await i18n.changeLanguage("zh-CN");
});

afterEach(() => {
  if (root) act(() => root.unmount());
  if (container) container.remove();
  vi.clearAllMocks();
});

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

function q<T extends Element = HTMLElement>(selector: string): T {
  return document.body.querySelector(selector) as T;
}

function text(): string {
  return document.body.textContent ?? "";
}

function findButton(label: string): HTMLButtonElement | undefined {
  return Array.from(document.body.querySelectorAll("button")).find(
    (candidate) => candidate.textContent?.trim() === label,
  ) as HTMLButtonElement | undefined;
}

/** 受控 input 必须走 native setter（React 19 直接赋值不会触发 onChange）。 */
async function setInput(testId: string, value: string) {
  const input = q<HTMLInputElement>(`[data-testid="${testId}"]`);
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  await act(async () => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await tick();
  });
}

async function render(node: React.ReactNode) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(node);
  });
  for (let round = 0; round < 4; round += 1) {
    await act(async () => {
      await tick();
    });
  }
}

function provider(overrides: Record<string, unknown> = {}) {
  return {
    id: "p1",
    name: "本地模型",
    provider_kind: "openai_compatible",
    base_url: "http://127.0.0.1:1234/v1",
    model: "qwen",
    has_api_key: true,
    enabled: true,
    is_default: true,
    allow_insecure_http: false,
    timeout_seconds: 30,
    max_output_tokens: 800,
    created_at: 1,
    updated_at: 1,
    ...overrides,
  };
}

describe("设置页 AI 模型", () => {
  it("没有模型时明确说明", async () => {
    listMock.mockResolvedValue([]);
    await render(<AiProviderSettings />);
    expect(text()).toContain(i18n.t("还没有模型"));
  });

  it("密钥已保存 / 缺失都有明确展示", async () => {
    listMock.mockResolvedValue([provider({ has_api_key: false })]);
    await render(<AiProviderSettings />);
    expect(text()).toContain(i18n.t("密钥未保存"));
  });

  it("新建：填完表单保存，API Key 只交给后端一次", async () => {
    listMock.mockResolvedValue([]);
    saveMock.mockResolvedValue(provider());
    await render(<AiProviderSettings />);

    await act(async () => {
      q<HTMLButtonElement>(`[aria-label="${i18n.t("添加模型")}"]`).click();
      await tick();
    });

    await setInput("provider-name", "本地模型");
    await setInput("provider-base-url", "http://127.0.0.1:1234/v1");
    await setInput("provider-model", "qwen");
    await setInput("provider-api-key", "sk-secret-value");

    await act(async () => {
      q<HTMLButtonElement>('[data-testid="provider-save"]').click();
      await tick();
    });

    expect(saveMock).toHaveBeenCalledWith(
      expect.objectContaining({
        id: null,
        name: "本地模型",
        base_url: "http://127.0.0.1:1234/v1",
        model: "qwen",
        api_key: "sk-secret-value",
      }),
    );
  });

  it("预设：填一个 Key 就能保存，地址 / 模型 / 上下文 / 思考强度自动带入", async () => {
    listMock.mockResolvedValue([]);
    saveMock.mockResolvedValue(provider());
    await render(<AiProviderSettings />);

    await act(async () => {
      q<HTMLButtonElement>(`[aria-label="${i18n.t("添加模型")}"]`).click();
      await tick();
    });
    await act(async () => {
      q<HTMLButtonElement>('[data-testid="preset-deepseek"]').click();
      await tick();
    });

    expect(q<HTMLInputElement>('[data-testid="provider-name"]').value).toBe("DeepSeek");
    expect(q<HTMLInputElement>('[data-testid="provider-base-url"]').value).toBe(
      "https://api.deepseek.com/v1",
    );
    expect(q<HTMLInputElement>('[data-testid="provider-model"]').value).toBe("deepseek-chat");

    await setInput("provider-api-key", "sk-deepseek");
    await act(async () => {
      q<HTMLButtonElement>('[data-testid="provider-save"]').click();
      await tick();
    });

    expect(saveMock).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "DeepSeek",
        base_url: "https://api.deepseek.com/v1",
        model: "deepseek-chat",
        api_key: "sk-deepseek",
        context_window: 1024 * 1024,
        context_budgets: [300 * 1024, 600 * 1024, 1024 * 1024],
        reasoning_efforts: ["low", "high", "max"],
      }),
    );
  });

  it("保存前先测连通性：用草稿参数请求，不触发保存", async () => {
    listMock.mockResolvedValue([]);
    testDraftMock.mockResolvedValue({
      ok: true,
      latency_ms: 12,
      attempts: 1,
      message: "ok",
    });
    await render(<AiProviderSettings />);

    await act(async () => {
      q<HTMLButtonElement>(`[aria-label="${i18n.t("添加模型")}"]`).click();
      await tick();
    });
    await act(async () => {
      q<HTMLButtonElement>('[data-testid="preset-deepseek"]').click();
      await tick();
    });
    await setInput("provider-api-key", "sk-draft");

    await act(async () => {
      q<HTMLButtonElement>('[data-testid="provider-test-draft"]').click();
      await tick();
    });

    expect(testDraftMock).toHaveBeenCalledWith(
      expect.objectContaining({
        base_url: "https://api.deepseek.com/v1",
        model: "deepseek-chat",
        api_key: "sk-draft",
      }),
    );
    expect(saveMock).not.toHaveBeenCalled();
    expect(text()).toContain(
      i18n.t("Connection OK ({{ms}} ms, {{attempts}} attempt(s))", {
        ms: 12,
        attempts: 1,
      }),
    );
  });

  it("编辑：不回显原 Key，留空表示保留原 Key", async () => {
    listMock.mockResolvedValue([provider()]);
    saveMock.mockResolvedValue(provider({ name: "改名" }));
    await render(<AiProviderSettings />);

    await act(async () => {
      q<HTMLButtonElement>('[data-testid="ai-edit-p1"]').click();
      await tick();
    });

    // 输入框里**没有**原 Key（前端根本读不到它）。
    expect(q<HTMLInputElement>('[data-testid="provider-api-key"]').value).toBe("");

    await setInput("provider-name", "改名");
    await act(async () => {
      q<HTMLButtonElement>('[data-testid="provider-save"]').click();
      await tick();
    });

    expect(saveMock).toHaveBeenCalledWith(
      expect.objectContaining({ id: "p1", name: "改名", api_key: null }),
    );
  });

  /*
   * 能力默认走**自动识别**：新建不预设档位，编辑未知模型只改名也不会凭空
   * 写出"四档强度 + 1M 预算"。
   */
  it("未知模型只改名：保存不产生任何能力覆盖值", async () => {
    listMock.mockResolvedValue([
      provider({
        model: "unknown-gateway-alias",
        capability_known: false,
        capability_overridden: false,
        context_window: 0,
        context_budgets: [],
        reasoning_efforts: [],
      }),
    ]);
    saveMock.mockResolvedValue(provider());
    await render(<AiProviderSettings />);

    await act(async () => {
      q<HTMLButtonElement>('[data-testid="ai-edit-p1"]').click();
      await tick();
    });

    // 默认是「自动识别」：界面上没有档位勾选，只有来源三选一。
    expect(text()).toContain(i18n.t("自动识别"));
    expect(q('[data-testid="provider-efforts"]')).toBeNull();
    expect(q('[data-testid="provider-context-budgets"]')).toBeNull();

    await setInput("provider-name", "改个名字");
    await act(async () => {
      q<HTMLButtonElement>('[data-testid="provider-save"]').click();
      await tick();
    });

    expect(saveMock).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "p1",
        name: "改个名字",
        context_window: null,
        context_budgets: null,
        reasoning_efforts: null,
      }),
    );
  });

  it("新建默认自动识别：没有勾选就不写档位与预算", async () => {
    listMock.mockResolvedValue([]);
    saveMock.mockResolvedValue(provider());
    await render(<AiProviderSettings />);
    await act(async () => {
      q<HTMLButtonElement>(`[aria-label="${i18n.t("添加模型")}"]`).click();
      await tick();
    });
    await setInput("provider-name", "自建网关");
    await setInput("provider-base-url", "http://127.0.0.1:1234/v1");
    await setInput("provider-model", "alias");
    await setInput("provider-api-key", "sk-x");
    await act(async () => {
      q<HTMLButtonElement>('[data-testid="provider-save"]').click();
      await tick();
    });
    expect(saveMock).toHaveBeenCalledWith(
      expect.objectContaining({
        id: null,
        context_window: null,
        context_budgets: null,
        reasoning_efforts: null,
      }),
    );
  });

  it("手写能力声明过：编辑保留手动覆盖，档位照旧回显", async () => {
    listMock.mockResolvedValue([
      provider({
        capability_overridden: true,
        context_window: 600 * 1024,
        context_budgets: [300 * 1024, 600 * 1024],
        reasoning_efforts: ["low", "high"],
      }),
    ]);
    saveMock.mockResolvedValue(provider());
    await render(<AiProviderSettings />);
    await act(async () => {
      q<HTMLButtonElement>('[data-testid="ai-edit-p1"]').click();
      await tick();
    });
    expect(q('[data-testid="provider-efforts"]')).not.toBeNull();
    expect(q('[data-testid="provider-context-budgets"]')).not.toBeNull();
    await act(async () => {
      q<HTMLButtonElement>('[data-testid="provider-save"]').click();
      await tick();
    });
    expect(saveMock).toHaveBeenCalledWith(
      expect.objectContaining({
        context_window: 600 * 1024,
        context_budgets: [300 * 1024, 600 * 1024],
        reasoning_efforts: ["low", "high"],
      }),
    );
  });

  it("连接测试：只显示结果、耗时与真实尝试次数", async () => {
    listMock.mockResolvedValue([provider()]);
    testMock.mockResolvedValue({
      ok: true,
      latency_ms: 12,
      model: "qwen",
      message: "",
      error_code: null,
      attempts: 2,
    });
    await render(<AiProviderSettings />);

    await act(async () => {
      q<HTMLButtonElement>('[data-testid="ai-test-p1"]').click();
      await tick();
    });

    expect(testMock).toHaveBeenCalledWith("p1");
    expect(text()).toContain(
      i18n.t("Connection OK ({{ms}} ms, {{attempts}} attempt(s))", { ms: 12, attempts: 2 }),
    );
  });

  it("设为默认", async () => {
    listMock.mockResolvedValue([provider({ is_default: false })]);
    setDefaultMock.mockResolvedValue(undefined);
    await render(<AiProviderSettings />);

    await act(async () => {
      q<HTMLButtonElement>('[data-testid="ai-default-p1"]').click();
      await tick();
    });

    expect(setDefaultMock).toHaveBeenCalledWith("p1");
  });

  it("删除：先确认，并可选择同步删除钥匙串里的密钥", async () => {
    listMock.mockResolvedValue([provider()]);
    deleteMock.mockResolvedValue(undefined);
    await render(<AiProviderSettings />);

    await act(async () => {
      q<HTMLButtonElement>('[data-testid="ai-delete-p1"]').click();
      await tick();
    });

    // 默认**不**删密钥（避免误伤）。
    const checkbox = q<HTMLInputElement>('[data-testid="delete-secret"]');
    expect(checkbox.checked).toBe(false);

    await act(async () => {
      checkbox.click();
      await tick();
    });

    await act(async () => {
      findButton(i18n.t("Delete"))?.click();
      await tick();
    });

    expect(deleteMock).toHaveBeenCalledWith("p1", true);
  });
});
