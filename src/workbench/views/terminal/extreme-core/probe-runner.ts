/**
 * **一次 SSH 拿齐前置条件**。
 *
 * `checks.ts` 里的检查器是纯函数，输入来自这里。把五条独立命令合成一次往返：
 * 每条输出前面打一个 `@@@tag` 分隔行，解析时按标记切段 —— 比开五个通道快，
 * 也不会出现"磁盘读到了、端口没读到"的中间态。
 *
 * 全部命令只读：`df` / `ss` / `test` / `hostname`。不写文件、不改配置。
 */
import {
  checkDisk,
  checkPort,
  checkWritable,
  type CheckItem,
} from "./checks";
import { parseResolved } from "./environment";

/** 分段标记。用 `@@@` 是因为它不会出现在路径或输出里。 */
const TAG = "@@@";

/** 需要探测的目录 —— 调用方按任务目标传（临时目录、线上目录…）。 */
export function probeCommand(path: string, options: { domain?: string } = {}): string {
  const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;
  const parts = [
    `echo ${TAG}disk`,
    `df -Pk ${quote(path)} 2>/dev/null | tail -1`,
    `echo ${TAG}ports`,
    `ss -ltn 2>/dev/null | awk 'NR>1{print $4}' | head -n 60`,
    `echo ${TAG}write`,
    `test -w ${quote(path)} && echo yes || echo no`,
    `echo ${TAG}self`,
    // 对外地址：优先公网路由，拿不到再退回第一个内网地址。
    `ip route get 1.1.1.1 2>/dev/null | awk '{for(i=1;i<=NF;i++) if($i=="src") print $(i+1)}' | head -n 1`,
    `echo ${TAG}hostname`,
    `hostname -I 2>/dev/null | awk '{print $1}'`,
  ];
  if (options.domain) {
    parts.push(`echo ${TAG}dns`, `dig +short ${quote(options.domain)} 2>/dev/null | head -n 10`);
  }
  return parts.join("; ");
}

export interface ProbeResult {
  /** 目标目录可用空间（字节）。 */
  diskAvailable: number | null;
  /** 监听中的地址（`0.0.0.0:80` / `[::]:443`）。 */
  listening: string[];
  /** 目标目录是否可写；`undefined` 表示没读到结论。 */
  writable?: boolean;
  /** 本机对外地址（拿不到就是 undefined）。 */
  selfAddress?: string;
  /** 域名解析结果（只传了 domain 才有）。 */
  resolved?: string[];
}

/**
 * 解析分段输出。
 *
 * 每一段以 `@@@tag` 开头，内容是到下一个标记之前的所有行。缺段（命令失败、
 * 被截断）时对应字段保持"未知"，**绝不编造**。
 */
export function parseProbe(stdout: string): ProbeResult {
  const sections = new Map<string, string[]>();
  let current: string | null = null;
  for (const raw of stdout.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith(TAG)) {
      current = line.slice(TAG.length).trim();
      sections.set(current, []);
      continue;
    }
    if (current) sections.get(current)?.push(line);
  }

  const text = (tag: string) => (sections.get(tag) ?? []).filter(Boolean).join("\n");

  // df：`Filesystem 1024-blocks Used Available Capacity Mounted` → available 在第 4 列。
  const diskFields = text("disk").split(/\s+/).filter(Boolean);
  const availableKb = Number(diskFields[3]);
  const diskAvailable = Number.isFinite(availableKb) ? availableKb * 1024 : null;

  const listening = (sections.get("ports") ?? []).filter(Boolean);

  const writeAnswer = text("write");
  const writable = writeAnswer === "yes" ? true : writeAnswer === "no" ? false : undefined;

  const selfAddress = text("self") || text("hostname") || undefined;

  const resolvedRaw = sections.get("dns");
  const resolved = resolvedRaw ? parseResolved(resolvedRaw.join("\n")) : undefined;

  return { diskAvailable, listening, writable, selfAddress, resolved };
}

/**
 * 把探测结果转成检查项。
 *
 * 只对有输入的项目生成结论 —— 没传 `port` 就不检查端口，不要凭空造一条
 * "不适用"。域名相关的检查交给 `checks.checkDns`（它要 `selfAddress`）。
 */
export function checksFromProbe(input: {
  probe: ProbeResult;
  path: string;
  needBytes: number;
  port?: number;
  at?: number;
}): CheckItem[] {
  const items: CheckItem[] = [
    checkWritable({ path: input.path, writable: input.probe.writable, at: input.at }),
    checkDisk({
      path: input.path,
      availableBytes: input.probe.diskAvailable,
      needBytes: input.needBytes,
      at: input.at,
    }),
  ];
  if (input.port !== undefined) {
    items.push(checkPort({ port: input.port, listening: input.probe.listening, at: input.at }));
  }
  return items;
}
