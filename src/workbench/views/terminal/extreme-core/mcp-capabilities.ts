/**
 * 超能模式的内置运维技能 + 服务器能力探测。
 *
 * 技能本身由现有 Agent 工具提供（run_shell / read_file / …），这里只负责
 * "这台服务器有没有对应的运行时"与"默认是否勾选"。探测是一次只读 SSH
 * 往返，结果按服务器缓存；重连（sessionId 变化）时重新探测。
 */

export type BuiltinMcpId =
  | "inspect"
  | "logs"
  | "files"
  | "dns"
  | "docker"
  | "nginx"
  | "systemd"
  | "database";

export interface McpEnvProbe {
  /** 探测会话；重连后与当前 sessionId 不一致就重探。 */
  sessionId: string;
  checkedAt: number;
  docker: boolean;
  compose: boolean;
  nginx: boolean;
  systemd: boolean;
  database: boolean;
  dns: boolean;
  files: boolean;
  logs: boolean;
  inspect: boolean;
}

export interface BuiltinMcpSkill {
  id: BuiltinMcpId;
  name: string;
  summary: string;
  detail: string;
  /** 需要哪项探测结论；没有 = 只要 SSH 连接就可用。 */
  requires?: "docker" | "nginx" | "systemd" | "database" | "dns";
}

export const BUILTIN_MCP_SKILLS: BuiltinMcpSkill[] = [
  {
    id: "inspect",
    name: "服务器巡检",
    summary: "查看系统状态、进程、端口与资源",
    detail: "通过当前 SSH 连接执行只读命令，适合先了解机器现状。",
  },
  {
    id: "logs",
    name: "实时日志",
    summary: "读取服务日志与 journal / 容器输出",
    detail: "沿用现有日志通道；连接断开时不可用。",
  },
  {
    id: "files",
    name: "远程文件",
    summary: "读取、修改、上传与解压文件",
    detail: "受任务权限与备份策略约束；只读档会拒绝写入。",
  },
  {
    id: "dns",
    name: "DNS / TLS / HTTP",
    summary: "解析域名、检查证书与 HTTP 响应",
    detail: "需要当前服务器能执行 dig / curl 等只读命令。",
    requires: "dns",
  },
  {
    id: "docker",
    name: "Docker / Compose",
    summary: "查看容器、Compose 服务与镜像",
    detail: "检测到 docker 后默认启用；未安装时不可用。",
    requires: "docker",
  },
  {
    id: "nginx",
    name: "Nginx / 站点排查",
    summary: "检查站点配置、语法与容器内 Nginx",
    detail: "检测到 nginx 或 /etc/nginx 后默认启用。",
    requires: "nginx",
  },
  {
    id: "systemd",
    name: "systemd",
    summary: "查看与操作 systemd 服务",
    detail: "检测到 systemctl 后默认启用；重启关键服务仍按严重操作确认。",
    requires: "systemd",
  },
  {
    id: "database",
    name: "数据库排查",
    summary: "连接 MySQL / PostgreSQL / Redis 排查",
    detail: "检测到数据库客户端或已绑定连接后启用。",
    requires: "database",
  },
];

const TAG = "@@@";

/** 一次只读探测：只看命令在不在、目录在不在，不改任何配置。 */
export const MCP_PROBE_SCRIPT = [
  `echo ${TAG}docker; if command -v docker >/dev/null 2>&1; then echo yes; else echo no; fi`,
  `echo ${TAG}compose; if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then echo yes; else echo no; fi`,
  `echo ${TAG}nginx; if command -v nginx >/dev/null 2>&1 || test -d /etc/nginx; then echo yes; else echo no; fi`,
  `echo ${TAG}systemd; if command -v systemctl >/dev/null 2>&1; then echo yes; else echo no; fi`,
  `echo ${TAG}database; if command -v mysql >/dev/null 2>&1 || command -v psql >/dev/null 2>&1 || command -v redis-cli >/dev/null 2>&1; then echo yes; else echo no; fi`,
  `echo ${TAG}dns; if command -v dig >/dev/null 2>&1 || command -v getent >/dev/null 2>&1; then echo yes; else echo no; fi`,
].join("; ");

export function parseMcpProbe(stdout: string, sessionId: string): McpEnvProbe {
  const sections = new Map<string, string>();
  let current = "";
  for (const raw of stdout.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith(TAG)) {
      current = line.slice(TAG.length).trim();
      continue;
    }
    if (current && line) sections.set(current, line);
  }
  const yes = (key: string) => sections.get(key) === "yes";
  return {
    sessionId,
    checkedAt: Date.now(),
    docker: yes("docker"),
    compose: yes("compose"),
    nginx: yes("nginx"),
    systemd: yes("systemd"),
    database: yes("database"),
    dns: yes("dns"),
    files: true,
    logs: true,
    inspect: true,
  };
}

/** 技能在当前服务器是否可用。 */
export function builtinAvailable(
  skill: BuiltinMcpSkill,
  probe: McpEnvProbe | null,
  connected: boolean,
): boolean {
  if (!connected) return false;
  if (!skill.requires) return true;
  return Boolean(probe?.[skill.requires]);
}


