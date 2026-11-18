import { opsApi } from "@/api/ops-api";

/**
 * 超能模式的**只读预检**。
 *
 * 一条 `ssh_exec` 走完所有探测（各自用 `echo '@@@'` 分隔），不写任何东西、
 * 不改任何配置。结果按四态呈现：
 *
 * - `checked`：检测到（带实测值）
 * - `missing`：探测成功但没找到（例如没装 Docker）
 * - `denied`：命令没跑起来多半是权限/环境问题（stderr 非空且无输出）
 * - `unchecked`：还没查（未连接 / 探测失败）
 *
 * 用户名、目录名、扩展名都只是线索，**结论一律来自实测输出**。
 */
export type PreflightState = "checked" | "missing" | "denied" | "unchecked";

export interface PreflightField {
    /** i18n key（显示名）。 */
    label: string;
    /** 实测值；`null` = 没有可用值。 */
    value: string | null;
    state: PreflightState;
}

export interface PreflightResult {
    os: PreflightField;
    arch: PreflightField;
    user: PreflightField;
    disk: PreflightField;
    docker: PreflightField;
    compose: PreflightField;
    /** 家目录绝对路径（SFTP 写文件用；拿不到为 null）。 */
    home: string | null;
    /** 原始输出（排障与"给出依据"用）。 */
    raw: string;
    }

const SEPARATOR = "@@@";

/** 每一段探测各占一行，顺序与下面 parse 一一对应。 */
const PROBE = [
    // 1. 发行版
    "cat /etc/os-release 2>/dev/null | sed -n 's/^PRETTY_NAME=//p' | head -1 | tr -d '\"'",
    // 2. CPU 架构
    "uname -m 2>/dev/null",
    // 3. 当前用户
    "id -un 2>/dev/null",
    // 4. 是否 root（0 = root）
    "id -u 2>/dev/null",
    // 5. 根分区可用空间（MB）
    "df -Pm / 2>/dev/null | tail -1 | awk '{print $4}'",
    // 6. docker 是否存在
    "command -v docker 2>/dev/null",
    // 7. compose 版本（v2 插件或 v1 独立版）
    "docker compose version --short 2>/dev/null || docker-compose version --short 2>/dev/null",
    // 8. 家目录（SFTP 写文件要绝对路径，`~` 不会被展开）
    "printf '%s' \"$HOME\"",
    ].join(` ; echo '${SEPARATOR}' ; `);

const empty = (label: string, state: PreflightState = "unchecked"): PreflightField => ({
    label,
    value: null,
    state,
});

/** 环境探测：只读，12 秒超时。 */
export async function runPreflight(sessionId: string): Promise<PreflightResult> {
    const result = await opsApi.sshExec(sessionId, PROBE, 12_000);
    const parts = result.stdout.split(SEPARATOR).map((part) => part.trim());
    const [os, arch, user, uid, diskMb, dockerPath, composeVersion, home] = parts;

    const composeField: PreflightField = composeVersion
        ? { label: "Compose", value: composeVersion, state: "checked" }
        : dockerPath
            ? { label: "Compose", value: null, state: "missing" }
            : empty("Compose");

    return {
        os: os ? { label: "Operating system", value: os, state: "checked" } : empty("Operating system"),
        arch: arch ? { label: "Architecture", value: arch, state: "checked" } : empty("Architecture"),
        user: user
            ? {
                label: "Current user",
                value: uid === "0" ? `${user} (root)` : user,
                state: "checked",
            }
            : empty("Current user", result.stderr ? "denied" : "unchecked"),
        disk:
            diskMb && /^\d+$/.test(diskMb)
                ? { label: "Free space", value: `${Number(diskMb)} MB`, state: "checked" }
                : empty("Free space"),
        docker: dockerPath
            ? { label: "Docker", value: dockerPath, state: "checked" }
            : { label: "Docker", value: null, state: "missing" },
        compose: composeField,
        home: home && home.startsWith("/") ? home : null,
        raw: result.stdout,
        };
}
