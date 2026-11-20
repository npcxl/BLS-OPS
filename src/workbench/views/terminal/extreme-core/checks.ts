/**
 * **前置条件的实测证明**。
 *
 * 部署能不能成，往往不取决于命令写得对不对，而取决于几个前置条件：
 * 域名是不是指向这台机器、端口有没有被占、目录能不能写、磁盘够不够、
 * 上游能不能连通、证书覆不覆盖这个域名。
 *
 * 这里把每一项做成**结构化检查项**，统一五种结论：
 *
 * | 状态 | 含义 |
 * |---|---|
 * | `passed` | 已验证通过（有实测输出作证据） |
 * | `unmet` | 条件未满足 —— 要用户或系统先改（比如 DNS 指向别处） |
 * | `denied` | 无权限，当前账号做不了 |
 * | `unverified` | 无法验证（缺工具、拿不到地址、命令不可用） |
 * | `not-applicable` | 不适用（没有域名、不是 HTTPS…） |
 *
 * 故意不区分成"成功/失败"：`unmet` 要用户动手、`denied` 要换权限、
 * `unverified` 是平台能力不足 —— 三种处理方式完全不同。
 */
import { i18n } from "@/i18n";

import { describeDnsVerdict, judgeDns, type DnsVerdict } from "./environment";

/** 当前界面是不是英文 —— 这批文本会**进模型上下文**，必须跟着界面走。 */
function isEnglish(): boolean {
  return (i18n.resolvedLanguage ?? i18n.language)?.toLowerCase().startsWith("en") ?? false;
}

export type CheckStatus = "passed" | "unmet" | "denied" | "unverified" | "not-applicable";

export interface CheckItem {
  /** 稳定 id，用于"只复查受影响的检查"。 */
  id: string;
  /** 检查什么（域名解析 / 80 端口 / 目录可写…）。 */
  label: string;
  /** 检查对象。 */
  target: string;
  status: CheckStatus;
  /** 实测证据：命令输出、观测值。没有证据就不该给 `passed`。 */
  evidence?: string;
  /** 检查时刻（毫秒）。 */
  at: number;
  /** `unmet` / `denied` 时，用户需要做的那一件事。 */
  blockedBy?: string;
}

/** 状态 → 一行（跟随界面语言）。 */
export function statusLabel(status: CheckStatus): string {
  const en = isEnglish();
  switch (status) {
    case "passed":
      return en ? "verified" : "已验证";
    case "unmet":
      return en ? "unmet" : "条件未满足";
    case "denied":
      return en ? "permission denied" : "无权限";
    case "unverified":
      return en ? "could not verify" : "无法验证";
    case "not-applicable":
      return en ? "not applicable" : "不适用";
  }
}

/**
 * 汇总：哪些阻塞了、哪些只是没法验证。
 *
 * `blocked` 只包含 `unmet` / `denied` —— 这两类必须有人动手才能继续；
 * `unverified` 单列，因为它可能是"平台缺工具"，不代表任务不能做。
 */
export function summarizeChecks(items: CheckItem[]): {
  passed: number;
  unmet: number;
  denied: number;
  unverified: number;
  total: number;
  blocked: CheckItem[];
  /** 整体能否继续（没有 unmet / denied）。 */
  ready: boolean;
} {
  const count = (status: CheckStatus) => items.filter((item) => item.status === status).length;
  const blocked = items.filter((item) => item.status === "unmet" || item.status === "denied");
  return {
    passed: count("passed"),
    unmet: count("unmet"),
    denied: count("denied"),
    unverified: count("unverified"),
    total: items.length,
    blocked,
    ready: blocked.length === 0,
  };
}

/** 渲染成给模型看的一段（只写事实与结论，不给流程）。 */
export function renderChecks(items: CheckItem[]): string {
  if (items.length === 0) return "";
  const en = isEnglish();
  const lines = items.map((item) => {
    const label = en ? i18n.t(item.label, { defaultValue: item.label }) : item.label;
    const head = en
      ? `- ${label} (${item.target}): ${statusLabel(item.status)}`
      : `- ${item.label}（${item.target}）：${statusLabel(item.status)}`;
    const evidence = item.evidence ? (en ? ` — ${item.evidence}` : ` —— ${item.evidence}`) : "";
    const blocked = item.blockedBy ? (en ? `; needs: ${item.blockedBy}` : `；需要：${item.blockedBy}`) : "";
    return `${head}${evidence}${blocked}`;
  });
  const summary = summarizeChecks(items);
  const overall = en
    ? summary.ready
      ? `can proceed (${summary.passed}/${summary.total} verified)`
      : `${summary.blocked.length} item(s) blocking`
    : summary.ready
      ? `可以继续（${summary.passed}/${summary.total} 已验证）`
      : `有 ${summary.blocked.length} 项阻塞`;
  return en
    ? `Precondition checks (${overall}):\n${lines.join("\n")}`
    : `前置条件检查（${overall}）：\n${lines.join("\n")}`;
}

/**
 * DNS 检查。
 *
 * 复用 `judgeDns` 的三态，映射到五态：指向别的主机是 `unmet`（用户要改记录），
 * 拿不到本机地址是 `unverified`（平台缺信息），没配记录是 `unmet`。
 */
export function checkDns(input: {
  domain: string;
  resolved: string[];
  selfAddress?: string;
  at?: number;
}): CheckItem {
  const verdict: DnsVerdict = judgeDns(input.resolved, input.selfAddress);
  const status: CheckStatus =
    verdict === "points-here"
      ? "passed"
      : verdict === "points-elsewhere" || verdict === "unresolved"
        ? "unmet"
        : "unverified";
  const en = isEnglish();
  return {
    id: `dns:${input.domain}`,
    label: en ? "DNS resolution" : "域名解析",
    target: input.domain,
    status,
    evidence: `${input.resolved.length > 0 ? input.resolved.join(", ") : en ? "no record" : "无记录"} ${en ? "—" : "——"} ${describeDnsVerdict(verdict)}`,
    at: input.at ?? Date.now(),
    blockedBy:
      status === "unmet"
        ? verdict === "points-elsewhere"
          ? en
            ? "point the A record at this machine, or confirm the deployment belongs on the host the record points to"
            : "把 A 记录改为本机地址，或确认应部署到记录指向的那台机器"
          : en
            ? "add an A record for this domain"
            : "为这个域名添加 A 记录"
        : undefined,
  };
}

/**
 * 端口占用检查。
 *
 * `ss -ltn` 的输出里出现 `:<port>` 就说明被占用 —— 部署前必须知道是
 * "自己的旧进程占着"还是"别人的服务占着"，两者处理方式不同。
 */
export function checkPort(input: {
  port: number;
  listening: string[];
  at?: number;
}): CheckItem {
  const occupied = input.listening.some((line) => new RegExp(`[:.]${input.port}(\\s|$)`).test(line));
  const en = isEnglish();
  return {
    id: `port:${input.port}`,
    label: en ? `Port ${input.port}` : `端口 ${input.port}`,
    target: `:${input.port}`,
    status: occupied ? "unmet" : "passed",
    evidence: occupied ? (en ? "already listening" : "已在监听") : en ? "free" : "未被占用",
    at: input.at ?? Date.now(),
    blockedBy: occupied
      ? en
        ? "confirm the process holding it can be stopped, or use another port"
        : "确认占用它的服务是否可以停止，或改用其他端口"
      : undefined,
  };
}

/**
 * 目录可写检查。
 *
 * 依据 `test -w` 的结果；没跑过就不要给 `passed` —— 给 `unverified`。
 */
export function checkWritable(input: {
  path: string;
  /** `test -w` 的结论；`undefined` 表示没测。 */
  writable?: boolean;
  at?: number;
}): CheckItem {
  const en = isEnglish();
  return {
    id: `write:${input.path}`,
    label: en ? "Directory writable" : "目录可写",
    target: input.path,
    status: input.writable === undefined ? "unverified" : input.writable ? "passed" : "denied",
    evidence:
      input.writable === undefined
        ? en
          ? "not tested"
          : "未测试"
        : input.writable
          ? "test -w passed"
          : "test -w failed",
    at: input.at ?? Date.now(),
    blockedBy:
      input.writable === false
        ? en
          ? "switch to a directory you can write to, or run as a privileged account"
          : "换一个有写权限的目录，或用提权账号执行"
        : undefined,
  };
}

/** 解析 `df -Pk <path>` 的可用空间（字节）。 */
export function parseDiskAvailable(stdout: string): number | null {
  const lines = stdout.trim().split(/\r?\n/);
  if (lines.length < 2) return null;
  const fields = lines[lines.length - 1].trim().split(/\s+/);
  // `Filesystem 1024-blocks Used Available Capacity Mounted` —— available 在第 4 列。
  const availableKb = Number(fields[3]);
  return Number.isFinite(availableKb) ? availableKb * 1024 : null;
}

/** 磁盘余量检查：低于 `needBytes` 就是 `unmet`。 */
export function checkDisk(input: {
  path: string;
  availableBytes: number | null;
  needBytes: number;
  at?: number;
}): CheckItem {
  const { availableBytes, needBytes } = input;
  const en = isEnglish();
  const mb = (bytes: number) => `${Math.round(bytes / 1024 / 1024)} MB`;
  return {
    id: `disk:${input.path}`,
    label: en ? "Disk headroom" : "磁盘余量",
    target: input.path,
    status:
      availableBytes === null ? "unverified" : availableBytes >= needBytes ? "passed" : "unmet",
    evidence:
      availableBytes === null
        ? en
          ? "df output unreadable"
          : "读不到 df 输出"
        : en
          ? `${mb(availableBytes)} available, ${mb(needBytes)} needed`
          : `可用 ${mb(availableBytes)}，需要 ${mb(needBytes)}`,
    at: input.at ?? Date.now(),
    blockedBy:
      availableBytes !== null && availableBytes < needBytes
        ? en
          ? "free up disk space or choose another deployment directory"
          : "清理磁盘或更换部署目录"
        : undefined,
  };
}

/**
 * 证书覆盖检查。
 *
 * `openssl x509 -noout -dates -ext subjectAltName` 的输出里同时看两件事：
 * 域名在不在 SAN 里、`notAfter` 有没有过期。
 */
export function checkCertificate(input: {
  domain: string;
  /** `openssl x509` 的输出；没拿到就是 `undefined`。 */
  details?: string;
  at?: number;
}): CheckItem {
  const en = isEnglish();
  const base = {
    id: `tls:${input.domain}`,
    label: en ? "HTTPS certificate" : "HTTPS 证书",
    target: input.domain,
    at: input.at ?? Date.now(),
  };
  if (!input.details) {
    return {
      ...base,
      status: "not-applicable",
      evidence: en ? "no readable certificate (HTTPS may not be configured yet)" : "没有可读取的证书（可能还没配 HTTPS）",
    };
  }
  const san = /DNS:([^,\n]+)/g;
  const names = [...input.details.matchAll(san)].map((match) => match[1].trim());
  const covers = names.some((name) => name === input.domain || (name.startsWith("*.") && input.domain.endsWith(name.slice(1))));
  const notAfter = /notAfter=(.+)/.exec(input.details)?.[1]?.trim();
  const expired = notAfter ? new Date(notAfter).getTime() < Date.now() : false;

  if (!covers) {
    return {
      ...base,
      status: "unmet",
      evidence: en
        ? `the certificate covers ${names.join(", ") || "unknown domains"}, not ${input.domain}`
        : `证书覆盖 ${names.join(", ") || "未知域名"}，不含 ${input.domain}`,
      blockedBy: en
        ? "re-issue a certificate for this domain, or use a domain it already covers"
        : "为这个域名重新签发证书，或改用已覆盖的域名",
    };
  }
  if (expired) {
    return {
      ...base,
      status: "unmet",
      evidence: en ? `the certificate expired on ${notAfter}` : `证书已于 ${notAfter} 过期`,
      blockedBy: en ? "renew the certificate" : "续签证书",
    };
  }
  return {
    ...base,
    status: "passed",
    evidence: en
      ? `covers ${input.domain}, valid until ${notAfter ?? "unknown"}`
      : `覆盖 ${input.domain}，有效期至 ${notAfter ?? "未知"}`,
  };
}

/** 上游可达性：`curl -m 5 -o /dev/null -w '%{http_code}'` 的结果。 */
export function checkUpstream(input: {
  url: string;
  httpCode?: number;
  at?: number;
}): CheckItem {
  const code = input.httpCode;
  const ok = code !== undefined && code > 0 && code < 500;
  const en = isEnglish();
  return {
    id: `upstream:${input.url}`,
    label: en ? "Upstream reachable" : "上游可达",
    target: input.url,
    status: code === undefined ? "unverified" : ok ? "passed" : "unmet",
    evidence: code === undefined ? (en ? "request returned nothing" : "请求没有返回") : `HTTP ${code}`,
    at: input.at ?? Date.now(),
    blockedBy:
      code !== undefined && !ok
        ? en
          ? "check that the upstream service is running, listening on the right port and path"
          : "确认上游服务是否在运行、监听端口与路径是否正确"
        : undefined,
  };
}
