/**
 * **环境事实包**。
 *
 * 这里只做"准备工作"，不做决定：
 * * 这台机器是什么系统、什么权限；
 * * 有哪些工具真的可用（`command -v` 的实测结果，不是猜）；
 * * 项目里有哪些文件（顶层结构）；
 * * 域名现在解析到哪，是不是这台机器；
 * * 哪些端口正被占用。
 *
 * **不给"该走哪条流程"的建议** —— 怎么部署、先查什么、要不要备份，交给模型
 * 结合这些事实自由编排，由用户确认。写死流程只会让它对没见过的环境束手无策。
 */

/** 域名解析结论。 */
export type DnsVerdict = "points-here" | "points-elsewhere" | "unresolved" | "unknown";

export interface EnvironmentReport {
  os?: string;
  arch?: string;
  user?: string;
  /** 是否 root（`id -u` == 0）。 */
  isRoot?: boolean;
  /** **实测可用**的工具名（`command -v` 有输出才算）。 */
  tools: string[];
  /** 项目文件（相对路径，已按目录折叠成顶层结构）。 */
  projectFiles: string[];
  /** 附件总数与总大小（让模型知道规模）。 */
  attachmentCount?: number;
  attachmentBytes?: number;
  /** 域名解析证明。 */
  dns?: {
    domain: string;
    /** `dig +short` 拿到的地址。 */
    resolved: string[];
    /** 本机对外地址（若已知）。 */
    selfAddress?: string;
    verdict: DnsVerdict;
  };
  /** 正在监听的地址（`ss -ltn` 的摘要）。 */
  listening?: string[];
}

/**
 * 一次探测**所有关心的工具**。
 *
 * 用 `command -v` 而不是 `which`：后者在最小化镜像里常常没装。
 * 不存在的工具不输出任何行，解析时只收有输出的。
 */
export const TOOL_PROBE_COMMAND =
  "for t in docker kubectl systemctl nginx rsync unzip tar curl dig openssl git python3 node npm pnpm cargo go java mvn; do " +
  "command -v \"$t\" >/dev/null 2>&1 && echo \"$t\"; done";

/** 解析 `TOOL_PROBE_COMMAND` 的输出。 */
export function parseTools(stdout: string): string[] {
  return [...new Set(stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean))];
}

/** 解析 `dig +short` 的输出（去掉空行与 CNAME 尾点）。 */
export function parseResolved(stdout: string): string[] {
  return [
    ...new Set(
      stdout
        .split(/\r?\n/)
        .map((line) => line.trim().replace(/\.$/, ""))
        .filter((line) => line.length > 0),
    ),
  ];
}

/**
 * 判断域名是否指向本机。
 *
 * 三态很重要：
 * * `points-here` —— 可以在本机直接验证公网入口；
 * * `points-elsewhere` —— **别在本机瞎改**，先让用户确认改的是哪台；
 * * `unresolved` —— 域名还没配，部署完也访问不到。
 *
 * 拿不到本机地址时返回 `unknown`，不猜。
 */
export function judgeDns(resolved: string[], selfAddress?: string): DnsVerdict {
  if (resolved.length === 0) return "unresolved";
  if (!selfAddress) return "unknown";
  const target = selfAddress.trim();
  return resolved.includes(target) ? "points-here" : "points-elsewhere";
}

/**
 * 把项目文件折叠成**顶层结构**。
 *
 * 三百个文件的平铺清单对模型没用（也吃上下文）；它需要知道的是"顶层有哪些
 * 目录、每个目录下有几个文件"。超过 `maxEntries` 后按目录聚合。
 */
export function summarizeProjectTree(files: string[], maxEntries = 40): string[] {
  const tops = new Map<string, number>();
  for (const file of files) {
    const [head] = file.split("/");
    const key = file.includes("/") ? `${head}/` : file;
    tops.set(key, (tops.get(key) ?? 0) + 1);
  }
  const entries = [...tops.entries()].sort(([a], [b]) => a.localeCompare(b));
  const lines = entries
    .slice(0, maxEntries)
    .map(([name, count]) => (name.endsWith("/") ? `${name}  (${count} 个文件)` : name));
  if (entries.length > maxEntries) {
    lines.push(`… 另有 ${entries.length - maxEntries} 项`);
  }
  return lines;
}

/** 结论 → 一句人话（写进上下文，也用于界面提示）。 */
export function describeDnsVerdict(verdict: DnsVerdict): string {
  switch (verdict) {
    case "points-here":
      return "域名已指向本机，可以在本机验证公网入口";
    case "points-elsewhere":
      return "域名指向别的主机 —— 改动前先确认目标机器，否则改完也访问不到";
    case "unresolved":
      return "域名当前解析不到，部署完成后也无法通过域名访问";
    case "unknown":
      return "缺少本机对外地址，无法判断域名是否指向本机";
  }
}

/**
 * 渲染成给模型看的**事实段落**。
 *
 * 只有事实，没有"建议先做什么"。模型自己决定下一步。
 */
export function renderEnvironmentReport(report: EnvironmentReport): string {
  const lines: string[] = [];

  const system = [report.os, report.arch, report.user ? `用户 ${report.user}` : null]
    .filter(Boolean)
    .join(" · ");
  if (system) {
    lines.push(`系统：${system}${report.isRoot ? "（root）" : ""}`);
  }

  if (report.tools.length > 0) {
    lines.push(`实测可用工具：${report.tools.join("、")}`);
  } else {
    lines.push("实测可用工具：（未探测到，或探测未执行）");
  }

  if (report.attachmentCount !== undefined) {
    const size =
      report.attachmentBytes !== undefined ? `（约 ${Math.round(report.attachmentBytes / 1024)} KB）` : "";
    lines.push(`附件：${report.attachmentCount} 个文件${size}`);
  }
  if (report.projectFiles.length > 0) {
    lines.push(`项目顶层结构：\n${summarizeProjectTree(report.projectFiles).map((line) => `  ${line}`).join("\n")}`);
  }

  if (report.dns) {
    const addresses = report.dns.resolved.length > 0 ? report.dns.resolved.join(", ") : "无记录";
    lines.push(
      `域名 ${report.dns.domain}：解析到 ${addresses} —— ${describeDnsVerdict(report.dns.verdict)}`,
    );
  }

  if (report.listening && report.listening.length > 0) {
    lines.push(`正在监听：${report.listening.join("、")}`);
  }

  return lines.join("\n");
}
