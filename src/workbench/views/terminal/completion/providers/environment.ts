/**
 * EnvironmentProvider —— **按服务器真实运行环境**生成命令建议。
 *
 * 与知识库的区别：知识库给的是"通用语法"，这里给的是"这台机器上能跑的
 * 那条命令"。Nginx 可能是宿主机装的、跑在 Docker 里、由 Compose 管理，
 * 也可能同时有好几个容器 —— 三种情况该给的命令完全不同，所以建议必须由
 * 环境探测结果（`NginxEnvironment`）驱动。
 *
 * 三条纪律：
 * - 多个 Nginx 容器时**先给容器选择器**，绝不替用户挑第一个；
 * - 选过的容器按会话记住；容器消失或停止后选择立即失效；
 * - 风险等级来自后端，`reload`/`restart` 是"需确认"，删除类根本不生成。
 */

import type {
  NginxContainer,
  NginxEnvironment,
  SuggestedCommand,
} from "@/api/types/environment";
import {
  configMounts,
  describeContainer,
  publishedPorts,
} from "@/api/types/environment";
import { quotePathSegment } from "../path-input";
import type {
  CompletionContext,
  CompletionItem,
  CompletionProvider,
  CompletionResult,
  ParsedLine,
} from "../types";

/** 会被当成"想运维 Nginx"的命令词。 */
const NGINX_WORDS = new Set(["nginx", "openresty"]);

/**
 * 每个 SSH 会话记住的容器选择。
 *
 * 只在内存里（切换会话要各自独立，重启应用重新探测一次也不贵）。
 */
const selections = new Map<string, string>();

export function rememberNginxContainer(sessionId: string, name: string): void {
  selections.set(sessionId, name);
}

export function forgetNginxContainer(sessionId: string): void {
  selections.delete(sessionId);
}

export function selectedNginxContainer(sessionId: string): string | null {
  return selections.get(sessionId) ?? null;
}

/** 清空所有会话的选择（断开连接 / 切换服务器时调用）。 */
export function clearNginxSelections(): void {
  selections.clear();
}

/** 校验并解析当前生效的选择：容器没了或停了就失效（绝不带着错误选择出命令）。 */
function resolveSelection(
  env: NginxEnvironment,
  sessionId: string,
): { container: NginxContainer | null; dropped: boolean } {
  const remembered = selectedNginxContainer(sessionId);
  if (!remembered) return { container: null, dropped: false };
  const found = env.containers.find((item) => item.name === remembered);
  if (!found || !found.running) {
    forgetNginxContainer(sessionId);
    return { container: null, dropped: true };
  }
  return { container: found, dropped: false };
}

export interface EnvironmentProviderOptions {
  /**
   * 取出该会话建议命令的**纯函数**（后端同一套规则的前端镜像）。
   * 抽出来是为了可测：换一份环境就能断言"给出哪些命令"。
   */
  commandsFor: (env: NginxEnvironment, selection: string | null) => SuggestedCommand[];
}

/** 默认实现：与 Rust `env_probe::nginx_commands` 规则一致。 */
export const nginxCommandsFor = nginxCommands;

export function createEnvironmentProvider(
  options: EnvironmentProviderOptions = { commandsFor: nginxCommandsFor },
): CompletionProvider {
  return {
    id: "environment",
    matches(parsed: ParsedLine): boolean {
      if (!NGINX_WORDS.has(parsed.command)) return false;
      // 只在命令词或第一个参数上接管：`nginx -t <更多参数>` 不再插手。
      return parsed.index <= 1;
    },
    async complete(ctx: CompletionContext, _parsed: ParsedLine): Promise<CompletionResult> {
      const line = ctx.line.trim();
      const requestKey = `env:${ctx.sessionId}:${line}`;
      const env = ctx.environment ?? null;

      if (!env) {
        return { items: [], notice: "正在探测服务器运行环境…", requestKey };
      }
      if (env.kind === "none") {
        return {
          items: [],
          notice: env.dockerReason ?? "这台服务器上没有检测到 Nginx",
          requestKey,
        };
      }

      const { container: remembered, dropped } = resolveSelection(env, ctx.sessionId);
      // 只有一个容器时没什么可选的 —— 直接就是它。
      const container = remembered ?? (env.containers.length === 1 ? env.containers[0] : null);
      const start = 0;
      const end = ctx.line.length;

      // 多个容器且没有有效选择 → 先给选择器（名称 / 镜像 / 状态 / 端口 /
      // Compose 项目），用户选完才可能出命令。
      // `dropped` 同样要重新选：记住的那个已经不在了，替他选另一个是不行的。
      if (env.kind === "multiple" && (!container || dropped)) {
        const items: CompletionItem[] = env.containers.map((item, index) => ({
          label: item.name,
          insertText: quotePathSegment(item.name, null, false),
          detail: describeContainer(item),
          icon: "container",
          type: "container",
          replaceRange: { start, end },
          priority: 200 - index,
          source: "environment",
          container: item,
        }));
        return {
          items,
          notice: dropped
            ? "之前选择的容器已停止或不存在，请重新选择"
            : "检测到多个 Nginx 容器，请先选择要操作的容器",
          requestKey,
        };
      }

      const commands = options.commandsFor(env, container?.name ?? null);
      const needle = line.toLowerCase();
      const matched =
        needle === "" || NGINX_WORDS.has(needle)
          ? commands
          : commands.filter(
              (item) =>
                item.command.toLowerCase().includes(needle) ||
                item.title.toLowerCase().includes(needle),
            );

      const items: CompletionItem[] = matched.map((item, index) => ({
        label: item.command,
        insertText: item.command,
        detail: item.title,
        icon: "command",
        type: "command",
        replaceRange: { start, end },
        priority: 100 - index,
        source: "environment",
        command: item,
      }));

      if (items.length === 0) {
        return { items: [], notice: `没有匹配的 Nginx 命令（${env.kind}）`, requestKey };
      }

      const state = container ? describeEnvironment(container) : undefined;
      return { items, notice: state, requestKey };
    },
  };
}

/**
 * 环境摘要（规格里的"提示区域"）：容器 / 镜像 / 端口 / 配置挂载 / 状态。
 *
 * 一行里塞不下就按顺序截断 —— 用户要的是"我到底在操作哪个 Nginx"。
 */
export function describeEnvironment(container: NginxContainer): string {
  const parts = [`容器 ${container.name}`, `镜像 ${container.image}`];
  const ports = publishedPorts(container);
  if (ports.length > 0) parts.push(`端口 ${ports.join("、")}`);
  const mounts = configMounts(container);
  if (mounts.length > 0) {
    parts.push(`配置 ${mounts[0].source} → ${mounts[0].destination}`);
  }
  parts.push(container.running ? "运行中" : container.state);
  if (container.compose) parts.push(`Compose ${container.compose.project}/${container.compose.service}`);
  return parts.join(" · ");
}

// -- 命令生成（Rust `env_probe::nginx_commands` 的前端镜像） ------------------

/** 与 Rust 端 `container_commands` / `host_commands` 一一对应。 */
export function nginxCommands(
  env: NginxEnvironment,
  selection: string | null,
): SuggestedCommand[] {
  if (env.kind === "none") return [];
  if (env.kind === "host") return hostCommands();

  const container =
    env.containers.length === 1
      ? env.containers[0]
      : (env.containers.find((item) => item.name === selection) ?? null);
  if (!container) return [];

  const compose =
    container.compose !== null &&
    container.compose.project !== "" &&
    container.compose.service !== "" &&
    container.compose.workingDir !== "";

  const commands: SuggestedCommand[] = [];
  if (compose && container.compose) {
    const { project, service, workingDir } = container.compose;
    const equivalent = `cd ${quote(workingDir)} && docker compose`;
    commands.push(
      {
        id: "compose.ps",
        title: "查看 Compose 服务状态",
        command: `docker compose -p ${project} ps ${service}`,
        risk: "read_only",
        note: `等价写法：${equivalent} ps ${service}`,
      },
      {
        id: "compose.logs",
        title: "查看最近 200 行日志",
        command: `docker compose -p ${project} logs --tail 200 ${service}`,
        risk: "read_only",
        note: `等价写法：${equivalent} logs --tail 200 ${service}`,
      },
      {
        id: "compose.test",
        title: "校验配置（nginx -t）",
        command: `docker compose -p ${project} exec ${service} nginx -t`,
        risk: "read_only",
        note: null,
      },
      {
        id: "compose.reload",
        title: "平滑重载配置",
        command: `docker compose -p ${project} exec ${service} nginx -s reload`,
        risk: "medium",
        note: "会改变运行中的服务状态，执行前请确认",
      },
      {
        id: "compose.restart",
        title: "重启服务",
        command: `docker compose -p ${project} restart ${service}`,
        risk: "medium",
        note: "重启会短暂中断连接，执行前请确认",
      },
    );
  }

  const name = quote(container.name);
  commands.push(
    { id: "docker.version", title: "查看版本", command: `docker exec ${name} nginx -v`, risk: "read_only", note: null },
    { id: "docker.test", title: "校验配置", command: `docker exec ${name} nginx -t`, risk: "read_only", note: null },
    { id: "docker.dump", title: "查看完整配置", command: `docker exec ${name} nginx -T`, risk: "read_only", note: null },
    {
      id: "docker.reload",
      title: "平滑重载",
      command: `docker exec ${name} nginx -s reload`,
      risk: "medium",
      note: "会改变运行中的服务状态，执行前请确认",
    },
    { id: "docker.logs", title: "查看日志（最近 200 行）", command: `docker logs --tail 200 ${name}`, risk: "read_only", note: null },
    { id: "docker.logs.follow", title: "实时跟踪日志", command: `docker logs -f ${name}`, risk: "read_only", note: "持续输出，按 Ctrl+C 退出" },
    { id: "docker.inspect", title: "查看容器详情", command: `docker inspect ${name}`, risk: "read_only", note: null },
    { id: "docker.exec", title: "进入容器", command: `docker exec -it ${name} sh`, risk: "low", note: "交互式命令，不会生成结果快照" },
    { id: "docker.port", title: "查看端口映射", command: `docker port ${name}`, risk: "read_only", note: null },
    {
      id: "docker.mounts",
      title: "查看配置挂载",
      command: `docker inspect --format '{{range .Mounts}}{{println .Source}} {{.Destination}}{{end}}' ${name}`,
      risk: "read_only",
      note: null,
    },
  );
  return commands;
}

function hostCommands(): SuggestedCommand[] {
  return [
    { id: "host.version", title: "查看版本", command: "nginx -v", risk: "read_only", note: null },
    { id: "host.test", title: "校验配置", command: "nginx -t", risk: "read_only", note: null },
    { id: "host.dump", title: "查看完整配置", command: "nginx -T", risk: "read_only", note: null },
    { id: "host.status", title: "查看运行状态", command: "systemctl status nginx", risk: "read_only", note: null },
    {
      id: "host.reload",
      title: "平滑重载配置",
      command: "nginx -s reload",
      risk: "medium",
      note: "会改变运行中的服务状态，执行前请确认",
    },
  ];
}

/** 容器名/路径写进命令前必须转义。 */
function quote(value: string): string {
  if (/^[A-Za-z0-9_./@+=:,-]*$/.test(value)) return value;
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\$/g, "\\$").replace(/`/g, "\\`")}"`;
}
