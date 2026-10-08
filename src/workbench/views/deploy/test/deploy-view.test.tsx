/**
 * 部署中心页面冒烟测试（真实组件 + 假 IPC）。
 *
 * 验证三件事：
 * 1. 五个 Tab 都渲染出来，空态给的是"先选服务器/建应用"这种可执行的提示；
 * 2. **组件不直接 invoke** —— 它调用的每一个后端能力都出现在 `opsApi` 上
 *    （mock 里没有的能力一旦被调用，测试会因为 undefined 直接崩）；
 * 3. 新建应用的弹窗把结构化实体（含 `server_id`）交给 `deploymentApplicationSave`，
 *    而不是把用户输入拼成命令。
 */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import "@/i18n";

const listApplicationsMock = vi.fn(async (_serverId: string) => [] as unknown[]);
const saveApplicationMock = vi.fn(async (application: unknown) => application);

vi.mock("@/api/ops-api", () => ({
  toErrorMessage: (cause: unknown) => String(cause),
  opsApi: {
    deploymentApplicationList: (serverId: string) => listApplicationsMock(serverId),
    deploymentApplicationSave: (application: unknown) => saveApplicationMock(application),
    deploymentApplicationDelete: async () => ({ environments: 0 }),
    deploymentEnvironmentList: async () => [],
    deploymentEnvironmentSave: async () => undefined,
    deploymentEnvironmentDelete: async () => ({ services: 0 }),
    deploymentServiceUnitList: async () => [],
    deploymentServiceUnitSave: async () => undefined,
    deploymentServiceUnitDelete: async () => 0,
    deploymentServiceUnitLinkProject: async () => undefined,
    deploymentServiceUnitUnlinkProject: async () => undefined,
    deploymentPlanList: async () => [],
    deploymentPlanGet: async () => null,
    deploymentPlanSave: async (graph: unknown) => graph,
    deploymentPlanDelete: async () => 0,
    deploymentRunList: async () => [],
    deploymentReleaseList: async () => [],
    projectConfirmedList: async () => [],
  },
}));

import { i18n } from "@/i18n";
import { useDomainStore } from "@/stores/domain-store";
import type { ServerRecord } from "@/api/ops-api";
import type { WorkspaceTab } from "@/workbench/types";
import { DeployView } from "../DeployView";

const TAB: WorkspaceTab = { id: "tab-1", type: "deployment", title: "Deploy" };

const SERVER = {
  id: "srv-1",
  name: "web-01",
  host: "10.0.0.1",
  port: 22,
  username: "root",
} as unknown as ServerRecord;

let container: HTMLDivElement;
let root: Root;

beforeAll(async () => {
  // React 19 需要这个标记才认 `act()`；不设只是刷屏警告，但会淹没真正的失败信息。
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  await i18n.changeLanguage("zh-CN");
});

beforeEach(() => {
  useDomainStore.setState({ servers: [SERVER] });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.clearAllMocks();
  useDomainStore.setState({ servers: [] });
});

/** 渲染并冲掉首帧的异步加载。 */
async function render() {
  await act(async () => {
    root.render(<DeployView tab={TAB} />);
  });
  await act(async () => {
    await Promise.resolve();
  });
}

/** 弹窗是 portal 到 `document.body` 的，所以查询范围必须是整页而不是容器。 */
function clickByText(text: string) {
  const button = Array.from(document.body.querySelectorAll("button")).find((node) =>
    (node.textContent ?? "").includes(text),
  );
  if (!button) throw new Error(`找不到按钮：${text}`);
  act(() => {
    button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

/** React 受控输入：必须走原生 setter，否则 onChange 不触发。 */
function typeInto(input: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const prototype =
    input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
  setter?.call(input, value);
  act(() => {
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("部署中心页面", () => {
  it("渲染五个 Tab 与页头边界说明", async () => {
    await render();
    const text = container.textContent ?? "";
    expect(text).toContain(i18n.t("Deployment Center"));
    expect(text).toContain(i18n.t("Plans are not executed automatically"));
    for (const key of ["Applications", "Environments", "Deploy services", "Plans", "Runs"]) {
      expect(text, `${key} Tab`).toContain(i18n.t(key));
    }
  });

  it("按服务器载入应用；没有应用时给出可执行的空态", async () => {
    await render();
    // 默认选中第一台服务器后立刻拉取它的应用列表。
    expect(listApplicationsMock).toHaveBeenCalledWith("srv-1");
    expect(container.textContent).toContain(i18n.t("Create an application to get started"));
  });

  it("新建应用：名称为空时给出校验提示，且不调用 IPC", async () => {
    await render();
    clickByText(i18n.t("New application"));
    clickByText(i18n.t("Save"));
    const text = `${container.textContent ?? ""}${document.body.textContent ?? ""}`;
    expect(text).toContain(i18n.t("This field is required"));
    expect(saveApplicationMock).not.toHaveBeenCalled();
  });

  it("新建应用：弹窗把结构化实体交给 IPC，而不是命令字符串", async () => {
    await render();
    clickByText(i18n.t("New application"));

    const inputs = document.body.querySelectorAll<HTMLInputElement>("input");
    // 字段顺序：应用名称 → 来源地址（来源类型选了"服务器已有目录"时必填绝对路径）。
    const [nameInput, sourceInput] = [inputs[0], inputs[1]];
    expect(nameInput).toBeDefined();
    typeInto(nameInput!, "官网");
    typeInto(sourceInput!, "/opt/web");
    expect(nameInput!.value, "受控输入应该已接受新值").toBe("官网");

    clickByText(i18n.t("Save"));

    await act(async () => {
      await Promise.resolve();
    });

    expect(saveApplicationMock).toHaveBeenCalledTimes(1);
    const payload = saveApplicationMock.mock.calls[0][0] as Record<string, unknown>;
    expect(payload.name).toBe("官网");
    expect(payload.server_id).toBe("srv-1");
    expect(payload.application_kind).toBe("frontend");
    // 新实体的 id / 时间戳交给后端生成。
    expect(payload.id).toBe("");
  });

  it("未选服务器时不拉取列表（页面不会拿空服务器去查）", async () => {
    useDomainStore.setState({ servers: [] });
    await render();
    expect(listApplicationsMock).not.toHaveBeenCalled();
    expect(container.textContent).toContain(i18n.t("Select a server first"));
  });
});
