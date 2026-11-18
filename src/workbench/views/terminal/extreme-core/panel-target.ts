/**
 * 「服务器命令面板」的目标：右栏该开哪个标签、看哪个资源。
 *
 * 模型通过结构化动作请求打开面板，**参数一律经过这里校验**才允许生效：
 * 只接受白名单标签、绝对路径、已知的日志来源类型。校验失败不会"猜一个"，
 * 而是回一句说明 —— 打开错的面板比不打开更糟。
 */

/**
 * **服务器运行面板**的标签。
 *
 * 注意：「远程文件」是**另一个面板**（`RemoteWorkspacePanel`），不在这组标签里
 * —— 运行面板看的是这台机器现在在跑什么，不是文件树。
 */
export type PanelTab = "status" | "services" | "logs" | "output";

/** 模型还能请求打开「远程文件」面板：它走另一条路径，不占这里的标签。 */
export type PanelRequestTab = PanelTab | "files";

export const PANEL_TABS: readonly PanelTab[] = ["status", "services", "logs", "output"];

/**
 * 日志的真实来源：按服务器上**实际**是谁在写日志来分。
 *
 * 类型定义在 API 层（跨端共用），这里再导出一次，便于同目录引用。
 */
export type { LogSource } from "@/api/types/panel";
import type { LogSource } from "@/api/types/panel";

export interface PanelRequest {
  tab: PanelRequestTab;
  /** 远程文件标签的目录；日志文件来源的目录由 `source` 决定。 */
  path?: string;
  source?: LogSource;
  /** 命令输出标签：哪个任务的哪一步。 */
  taskId?: string;
  stepIndex?: number;
  /**
   * 发起这次请求时的 SSH 连接。
   *
   * 渲染日志/输出前核对：探测是异步的，期间用户可能切了会话，旧来源不能
   * 打开到新会话的右栏里。
   */
  sessionId?: string;
}

const MAX_PATH = 512;
const NAME_PATTERN = /^[A-Za-z0-9._:@/+-]+$/;

/** 绝对路径，且不含 `..`：面板只允许落在确定的目录/文件上。 */
export function safeAbsolutePath(value: string): string | null {
  const path = value.trim();
  if (!path.startsWith("/") || path.length > MAX_PATH) return null;
  if (path.split("/").some((part) => part === "..")) return null;
  if (path.includes("\0") || path.includes("\n") || path.includes("\r")) return null;
  return path;
}

/** systemd unit / 容器名：只允许安全字符，长度受限。 */
export function safeResourceName(value: string): string | null {
  const name = value.trim();
  if (name.length === 0 || name.length > 128) return null;
  if (!NAME_PATTERN.test(name)) return null;
  // `-` 开头的名字会被当成命令行选项。
  if (name.startsWith("-")) return null;
  return name;
}

/**
 * 解析一段结构化动作：
 *
 * ```
 * [[panel:logs:/var/log/nginx/access.log]]         ← 文件日志
 * [[panel:logs:file:/var/log/nginx/access.log]]
 * [[panel:logs:journal:nginx]]
 * [[panel:logs:docker:bls-nginx]]
 * [[panel:files:/var/www]]
 * [[panel:output]]                                  ← 当前任务最后一步的输出
 * ```
 *
 * 也接受 JSON 形态（模型更不容易写错引号外的分隔）：
 * `[[panel:logs:{"kind":"docker","name":"bls-nginx"}]]`。
 */
export function parsePanelAction(text: string): PanelRequest | null {
  const marker = text.match(/\[\[panel:([^\]\n]+)\]\]/);
  if (!marker) return null;
  const body = marker[1].trim();
  const parts = body.split(":");

  const tab = parts[0]?.trim() as PanelRequestTab | undefined;
  if (!tab || (tab !== "files" && !PANEL_TABS.includes(tab))) return null;

  if (tab === "files") {
    const path = safeAbsolutePath(parts.slice(1).join(":"));
    return path ? { tab, path } : null;
  }

  if (tab === "output") {
    return { tab };
  }

  // logs
  const rest = parts.slice(1).join(":").trim();
  if (!rest) return null;
  if (rest.startsWith("{")) {
    try {
      const parsed = JSON.parse(rest) as {
        kind?: string;
        name?: string;
        path?: string;
        label?: string;
        namespace?: string;
      };
      const label = (parsed.label ?? "").trim().slice(0, 80);
      if (parsed.kind === "journal") {
        const unit = safeResourceName(parsed.name ?? "");
        return unit ? { tab, source: { kind: "journal", unit, label: label || unit } } : null;
      }
      if (parsed.kind === "docker") {
        const container = safeResourceName(parsed.name ?? "");
        return container
          ? { tab, source: { kind: "docker", container, label: label || container } }
          : null;
      }
      if (parsed.kind === "file") {
        const path = safeAbsolutePath(parsed.path ?? "");
        return path ? { tab, source: { kind: "file", path, label: label || path } } : null;
      }
      if (parsed.kind === "k8s" || parsed.kind === "kubernetes") {
        const pod = safeResourceName(parsed.name ?? "");
        if (!pod) return null;
        const namespace =
          typeof parsed.namespace === "string" && parsed.namespace
            ? safeResourceName(parsed.namespace)
            : null;
        if (typeof parsed.namespace === "string" && parsed.namespace && !namespace) return null;
        return {
          tab,
          source: {
            kind: "k8s",
            pod,
            namespace,
            label: label || (namespace ? `${namespace}/${pod}` : pod),
          },
        };
      }
      return null;
    } catch {
      return null;
    }
  }

  // 短形态：`portal:file:/path` / `portal:journal:unit` / `portal:docker:name`
  const [kind, ...tail] = rest.split(":");
  const value = tail.join(":").trim();
  if (kind === "journal") {
    const unit = safeResourceName(value);
    return unit ? { tab, source: { kind: "journal", unit, label: unit } } : null;
  }
  if (kind === "docker") {
    const container = safeResourceName(value);
    return container ? { tab, source: { kind: "docker", container, label: container } } : null;
  }
  if (kind === "k8s" || kind === "kubernetes") {
    // 支持 `k8s:pod` 与 `k8s:namespace/pod`。
    const [namespace, pod] = value.includes("/")
      ? [value.split("/")[0], value.split("/").slice(1).join("/")]
      : ["", value];
    const name = safeResourceName(pod);
    if (!name) return null;
    const ns = namespace ? safeResourceName(namespace) : null;
    if (namespace && !ns) return null;
    return {
      tab,
      source: {
        kind: "k8s",
        pod: name,
        namespace: ns,
        label: ns ? `${ns}/${name}` : name,
      },
    };
  }
  // 默认按文件日志处理（`[[panel:logs:/var/log/...]]`）。
  const path = safeAbsolutePath(kind === "file" ? value : rest);
  return path ? { tab, source: { kind: "file", path, label: path } } : null;
}

/** 从正文里剥掉面板动作，气泡不显示这些标记。 */
export function stripPanelAction(text: string): string {
  return text.replace(/\[\[panel:[^\]\n]+\]\]/g, "").trim();
}

/**
 * 生成**只读**的探测命令：确认目标在这台服务器上真实存在，再打开面板。
 *
 * 这一步是"先识别实际来源"的落地：模型说 `journal:nginx`，但这台机的 nginx
 * 在容器里跑，`systemctl` 会查不到 —— 那就不能打开一个永远空着的日志面板。
 */
export function probeCommand(request: PanelRequest): string | null {
  if (request.tab === "files" && request.path) {
    return `test -d ${shellQuote(request.path)} && echo yes || echo no`;
  }
  const source = request.source;
  if (!source) return null;
  if (source.kind === "file") {
    return `test -f ${shellQuote(source.path)} && echo yes || echo no`;
  }
  if (source.kind === "journal") {
    // `is-active` 对未知 unit 返回 inactive/unknown，两者都视为"这台机上没有它"。
    return `systemctl list-unit-files ${shellQuote(`${source.unit}.service`)} --no-legend 2>/dev/null | wc -l`;
  }
  if (source.kind === "k8s") {
    const ns = source.namespace ? ` -n ${shellQuote(source.namespace)}` : "";
    return `kubectl get pod ${shellQuote(source.pod)}${ns} --no-headers 2>/dev/null | wc -l`;
  }
  return `docker ps -a --format '{{.Names}}' | grep -Fx ${shellQuote(source.container)} | wc -l`;
}

/** 探测输出 → 目标是否存在（不抛错：探测失败按"不存在"处理，面板不打开）。 */
export function probeSucceeded(request: PanelRequest, stdout: string): boolean {
  const text = stdout.trim();
  if (request.tab === "files" || request.source?.kind === "file") return text === "yes";
  const count = Number.parseInt(text.split("\n").pop() ?? "", 10);
  return Number.isFinite(count) && count > 0;
}

export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** 面板标题（右栏标签与聊天提示共用，避免两处说法不一致）。 */
export function panelTitle(request: PanelRequest): string {
  if (request.tab === "files") return request.path ?? "/";
  if (request.tab === "status") return "status";
  if (request.tab === "services") return "services";
  if (request.tab === "output") return "output";
  return request.source?.label ?? "logs";
}
