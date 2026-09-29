/**
 * P5.1 制品导入面板测试。
 *
 * 重点不是"渲染出来了"，而是三条承诺：
 *
 * 1. 组件**只经 opsApi**（mock 里只列 opsApi 上存在的方法，调用别的会直接崩）；
 * 2. 提交给后端的是**结构化来源**（`{ kind: "local_folder", path }`），
 *    而不是任何命令字符串；
 * 3. 有阻断项时确认按钮**禁用**，且界面里**不出现密钥明文**（只有掩码证据）。
 */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import "@/i18n";

const startMock = vi.fn(async (request: unknown) => ({
    id: "task-new",
    application_id: "app-1",
    service_unit_id: null,
    source: (request as { source: unknown }).source,
    display_name: "web",
    stage: "queued",
    status: "running",
    progress: {
        stage: "queued",
        status: "running",
        processed_bytes: 0,
        total_bytes: 0,
        processed_entries: 0,
        total_entries: 0,
        percent: 0,
    },
    fingerprint: null,
    security: null,
    inspection: null,
    error: null,
    can_cancel: true,
    attempt: 1,
    created_at: 1,
    updated_at: 1,
    finished_at: null,
    artifact_id: null,
}));

const listTasksMock = vi.fn(async () => [] as unknown[]);
const cancelMock = vi.fn(async () => true);

vi.mock("@/api/ops-api", () => ({
    toErrorMessage: (cause: unknown) => String(cause),
    opsApi: {
        deploymentArtifactImportStart: (request: unknown) => startMock(request),
        deploymentArtifactImportList: () => listTasksMock(),
        deploymentArtifactImportStatus: async () => null,
        deploymentArtifactImportCancel: () => cancelMock(),
        deploymentArtifactImportRetry: async () => undefined,
        deploymentArtifactImportConfirm: async (confirmation: unknown) => confirmation,
        deploymentArtifactImportDelete: async () => undefined,
        deploymentArtifactUpload: async () => undefined,
        deploymentArtifactList: async () => [],
        sshConnectMonitor: async () => undefined,
        sshDisconnect: async () => undefined,
    },
}));

import { i18n } from "@/i18n";
import type { ArtifactImportTask, DeploymentEnvironment } from "@/api/types/deployment";
import { ArtifactImportPanel } from "../artifact-import";

const ENVIRONMENT = {
    id: "env-1",
    application_id: "app-1",
    server_id: "srv-1",
    name: "production",
    kind: "production",
    deploy_root: "/opt/shop",
    capacity_profile_id: null,
    notes: "",
    status: "active",
    created_at: 1,
    updated_at: 1,
} as unknown as DeploymentEnvironment;

/** 一份"等确认"的任务：含一个阻断项与一个服务候选。 */
function pendingTask(): ArtifactImportTask {
    return {
        id: "task-1",
        application_id: "app-1",
        service_unit_id: null,
        source: { kind: "local_folder", path: "/tmp/web" },
        display_name: "web",
        stage: "awaiting_confirmation",
        status: "succeeded",
        progress: {
            stage: "awaiting_confirmation",
            status: "succeeded",
            processed_bytes: 10,
            total_bytes: 10,
            processed_entries: 2,
            total_entries: 2,
            percent: 100,
        },
        fingerprint: {
            sha256: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
            size_bytes: 10,
            entry_count: 2,
            newest_mtime_ms: null,
            computed_at: 1,
            algorithm: "sha256",
            basis: "directory_manifest",
        },
        security: {
            findings: [
                {
                    kind: "symlink",
                    severity: "critical",
                    location: "../escape",
                    detail: "archive symlink points outside the extraction root",
                    evidence: null,
                    blocking: true,
                },
                {
                    kind: "access_token",
                    severity: "high",
                    location: ".env:1",
                    detail: "API token inside the artifact",
                    evidence: { preview: "ghp_********（40 字符）", length: 40, pattern: "github_personal_access_token" },
                    blocking: false,
                },
            ],
            entries_checked: 2,
            files_scanned: 2,
            bytes_scanned: 10,
            truncated: false,
        },
        inspection: {
            artifact_kind: "folder",
            source_kind: "local_path",
            stack: { language: "node", package_manager: "npm", framework: "vite", markers: ["package.json"] },
            build: [{ kind: "npm_script", manager: "npm", script: "build" }],
            start: [{ kind: "nginx_site", site_name: "web-web", root: "/dist" }],
            ports: [{ port: 80, protocol: "tcp", evidence: "nginx default" }],
            health: [],
            env_keys: [
                { key: "GITHUB_TOKEN", required: false, secret_like: true, evidence: ".env" },
            ],
            dependencies: [],
            services: [
                {
                    id: "dist/index.html",
                    name: "web-web",
                    role: "static",
                    service_kind: "static_nginx",
                    runtime: { kind: "static_nginx", site_name: "web-web", root: "/dist" },
                    artifact_kind: "dist",
                    source_path: "dist",
                    ports: [{ host_port: 80, container_port: 80, protocol: "tcp" }],
                    env_keys: [],
                    dependencies: [],
                    health: [],
                    confidence: 90,
                    evidence: ["dist/index.html"],
                    selected_by_default: true,
                },
            ],
            checks: [{ id: "coverage", label: "Inventory coverage", state: "ready", detail: "2 entries" }],
            open_questions: ["Confirm the absolute nginx site root"],
            files_seen: 2,
            truncated: false,
            inspected_at: 1,
        },
        error: null,
        can_cancel: false,
        attempt: 1,
        created_at: 1,
        updated_at: 1,
        finished_at: 1,
        artifact_id: null,
    };
}

let container: HTMLDivElement;
let root: Root;

beforeAll(async () => {
    (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    await i18n.changeLanguage("zh-CN");
});

beforeEach(() => {
    startMock.mockClear();
    listTasksMock.mockReset();
    listTasksMock.mockResolvedValue([]);
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
});

afterEach(() => {
    act(() => root.unmount());
    container.remove();
});

async function render() {
    await act(async () => {
        root.render(
            <ArtifactImportPanel
                serverId="srv-1"
                applicationId="app-1"
                environmentId="env-1"
                environments={[ENVIRONMENT]}
                onChanged={() => undefined}
            />,
        );
    });
    await act(async () => {
        await Promise.resolve();
    });
}

function byText(text: string): HTMLButtonElement | undefined {
    return Array.from(document.body.querySelectorAll("button")).find(
        (button) => button.textContent?.trim() === text,
    ) as HTMLButtonElement | undefined;
}

function typeInto(input: HTMLInputElement, value: string) {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    setter?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("制品导入面板", () => {
    it("列出五种来源，且默认是本地文件夹", async () => {
        await render();
        const select = document.body.querySelector("select") as HTMLSelectElement;
        const options = Array.from(select.options).map((option) => option.value);
        expect(options).toEqual([
            "local_folder",
            "local_archive",
            "local_file",
            "remote_directory",
            "docker_image_ref",
        ]);
    });

    it("开始导入时提交结构化来源，而不是命令字符串", async () => {
        await render();
        const input = Array.from(document.body.querySelectorAll("input")).find((element) =>
            element.getAttribute("placeholder")?.includes("/path/to/artifact"),
        ) as HTMLInputElement;
        act(() => typeInto(input, "/tmp/web"));
        const button = byText(i18n.t("Start import"));
        expect(button).toBeTruthy();
        await act(async () => {
            button?.click();
            await Promise.resolve();
        });

        expect(startMock).toHaveBeenCalledTimes(1);
        const request = startMock.mock.calls[0][0] as {
            application_id: string;
            session_id: string | null;
            source: { kind: string; path: string };
        };
        expect(request.application_id).toBe("app-1");
        expect(request.session_id).toBeNull();
        expect(request.source).toEqual({ kind: "local_folder", path: "/tmp/web" });
        // 结构化来源里不可能藏一条命令。
        expect(JSON.stringify(request.source)).not.toContain(";");
    });

    it("有阻断项时禁用确认，且界面里没有密钥明文", async () => {
        listTasksMock.mockResolvedValue([pendingTask()]);
        await render();

        // 候选与依据都在。
        expect(document.body.textContent).toContain("web-web");
        expect(document.body.textContent).toContain("dist/index.html");

        // 确认按钮被禁用（安全扫描一票否决）。
        const confirm = byText(i18n.t("Confirm import"));
        expect(confirm).toBeTruthy();
        expect(confirm?.disabled).toBe(true);

        // 只有掩码证据，没有原文。
        expect(document.body.textContent).toContain("ghp_********");
        expect(document.body.textContent).not.toContain("abcdefghij");
        expect(document.body.textContent).not.toContain("AKIA");
    });
});
