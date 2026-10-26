/**
 * 私钥文件导入的前端链路。
 *
 * 后端已经用「大小 + 内容必须是私钥」拦住了不该读的文件，这里只钉三件事：
 * 1. 选择文件后调的是**受限读取命令**（不是前端直读）；
 * 2. 内容进的是表单，用户还要点保存；
 * 3. 读取失败时错误可见，且不会把上次的内容清空。
 */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import "@/i18n";

const dialogOpen = vi.fn();
const readKeyFile = vi.fn();

vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: (...args: unknown[]) => dialogOpen(...args),
}));

vi.mock("@/api/ops-api", async () => {
  const actual = await vi.importActual<typeof import("@/api/ops-api")>("@/api/ops-api");
  return {
    ...actual,
    opsApi: {
      ...actual.opsApi,
      credentialReadPrivateKeyFile: (...args: unknown[]) => readKeyFile(...args),
    },
  };
});

import { i18n } from "@/i18n";
import { CredentialForm } from "../settings-context-sidebar";
import type { CredentialRecord } from "@/api/types/servers";

const KEY_TEXT = "-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXk=\n";

let container: HTMLDivElement;
let root: Root;

const credential = (): CredentialRecord =>
  ({
    id: "cred-new",
    name: "prod root",
    username: "root",
    credential_type: "private_key",
    secret_ref: null,
    passphrase_ref: null,
    created_at: 1,
    updated_at: 1,
  }) as CredentialRecord;

beforeAll(async () => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  await i18n.changeLanguage("zh-CN");
});

afterEach(() => {
  if (root) act(() => root.unmount());
  if (container) container.remove();
  vi.clearAllMocks();
});

async function render() {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root.render(<CredentialForm credential={credential()} onClose={() => undefined} />);
  });
}

const button = () => document.querySelector('[data-testid="credential-import-key"]') as HTMLButtonElement | null;
const textarea = () => document.querySelector("textarea") as HTMLTextAreaElement;

describe("私钥文件导入", () => {
  it("选择文件后走受限读取命令，内容进入表单", async () => {
    dialogOpen.mockResolvedValue("/home/me/.ssh/id_ed25519");
    readKeyFile.mockResolvedValue({
      file_name: "id_ed25519",
      content: KEY_TEXT,
      bytes: 64,
      format: "openssh",
      encrypted: null,
    });
    await render();

    await act(async () => {
      button()?.click();
      await Promise.resolve();
    });
    await act(async () => {
      await Promise.resolve();
    });

    // 路径交给后端，前端不自己读文件。
    expect(readKeyFile).toHaveBeenCalledWith("/home/me/.ssh/id_ed25519");
    expect(textarea().value).toContain("BEGIN OPENSSH PRIVATE KEY");
    expect(document.body.textContent).toContain(i18n.t("Loaded {{name}}", { name: "id_ed25519" }));
  });

  it("加密私钥会提示填写口令", async () => {
    dialogOpen.mockResolvedValue("/home/me/.ssh/encrypted.pem");
    readKeyFile.mockResolvedValue({
      file_name: "encrypted.pem",
      content: "-----BEGIN ENCRYPTED PRIVATE KEY-----\nxx\n",
      bytes: 48,
      format: "pem",
      encrypted: true,
    });
    await render();

    await act(async () => {
      button()?.click();
      await Promise.resolve();
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(document.body.textContent).toContain(
      i18n.t("Loaded {{name}} — it is encrypted, enter its passphrase below", {
        name: "encrypted.pem",
      }),
    );
  });

  it("取消选择时什么都不改", async () => {
    dialogOpen.mockResolvedValue(null);
    await render();
    await act(async () => {
      button()?.click();
      await Promise.resolve();
    });
    expect(readKeyFile).not.toHaveBeenCalled();
    expect(textarea().value).toBe("");
  });

  it("读取失败时显示错误，且不覆盖已输入的内容", async () => {
    dialogOpen.mockResolvedValue("/home/me/notes.txt");
    readKeyFile.mockRejectedValue(new Error("这个文件看起来不是私钥"));
    await render();

    // 先手工输入一点内容。
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
      setter.call(textarea(), "pasted-by-hand");
      textarea().dispatchEvent(new Event("input", { bubbles: true }));
      await Promise.resolve();
    });

    await act(async () => {
      button()?.click();
      await Promise.resolve();
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(document.body.textContent).toContain("这个文件看起来不是私钥");
    expect(textarea().value).toBe("pasted-by-hand");
  });
});
