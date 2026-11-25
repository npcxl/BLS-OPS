/**
 * 权限模式与**删除前备份**。
 *
 * 默认是只读：查询直接执行，只有后端判定"确实会写文件 / 改配置 / 改服务 /
 * 删数据"时才请用户确认一次；sudo 禁用。打开「完全权限」后，修改范围内的
 * 写入、修改与删除直接执行（写文件仍会自动备份），sudo 也允许。
 *
 * 只查询的任务有独立硬边界：执行器直接拦下写 / 改 / 删，两种权限下都不产生
 * 确认 —— 权限只决定"写要不要问"，不决定"该不该写"。
 * 任何一次写/删除都**先在同目录留一份带标记的备份**：
 *
 * ```
 * /srv/ops/config.yaml                                ← 原文件
 * /srv/ops/config.yaml.bls-bak-20260102030405         ← 备份（同目录、可追溯）
 * ```
 *
 * 用后缀而不是 `.bak/` 子目录：单文件删除时不必新建目录，`find` 也好找；
 * 标记里带 `bls-bak` 是为了和用户自己的 `.bak` / `.old` 区分开，清理时
 * 不会误删别人留的备份。
 */

export type PermissionMode = "readonly" | "ask" | "full";

/** 备份文件名里的固定标记。清理只认这个标记（与后端 `.bls-bak.` 一致）。 */
export const BACKUP_MARK = ".bls-bak.";

/** 备份策略：开关决定是否先备份，保留期限只清理本应用生成的备份。 */
export interface BackupPolicy {
  /** 修改 / 覆盖前备份。 */
  beforeWrite: boolean;
  /** 删除前备份（删除后可能已经拿不到原文件）。 */
  beforeDelete: boolean;
  /** 保留天数；0 = 永久保留。 */
  retentionDays: number;
}

export const DEFAULT_BACKUP_POLICY: BackupPolicy = {
  beforeWrite: true,
  beforeDelete: true,
  retentionDays: 30,
};

/** 可选的保留期限（天）。 */
export const BACKUP_RETENTION_OPTIONS = [7, 30, 90, 0] as const;

/** 时间戳：`20260102030405`（本地时区无意义，只求唯一与可排序）。 */
export function backupStamp(at = Date.now()): string {
  const date = new Date(at);
  const pad = (value: number) => String(value).padStart(2, "0");
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds()),
  ].join("");
}

/** 某个文件的备份路径（同目录、带标记与时间戳）。 */
export function backupPathFor(path: string, at = Date.now()): string {
  return `${path}${BACKUP_MARK}${backupStamp(at)}`;
}

/** 这个文件名是不是我们的备份。 */
export function isBackupPath(path: string): boolean {
  return path.includes(BACKUP_MARK);
}

/** 从备份路径还原出原文件路径。 */
export function originalPathOf(backupPath: string): string {
  const index = backupPath.lastIndexOf(BACKUP_MARK);
  return index < 0 ? backupPath : backupPath.slice(0, index);
}

/** 单引号转义。 */
function quote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * 删除前的备份命令。
 *
 * **`cp -a` 且失败即中止**：备份没成功就不能删，否则就是"不可见的删除"。
 * 命令用 `&&` 串联，`cp` 失败时后面的 `rm` 不会执行。
 */
export function deleteWithBackupCommand(path: string, at = Date.now()): string {
  const backup = backupPathFor(path, at);
  return `cp -a ${quote(path)} ${quote(backup)} && rm -f ${quote(path)} && echo "backup: ${backup}"`;
}

/** 列出某个目录下的全部备份（只读）。 */
export function listBackupsCommand(dir: string): string {
  return `find ${quote(dir)} -type f -name ${quote(`*${BACKUP_MARK}*`)} 2>/dev/null | head -n 200`;
}

/** 清理某个目录下的全部备份（破坏性，仅「完全权限」可用）。 */
export function purgeBackupsCommand(dir: string): string {
  return `find ${quote(dir)} -type f -name ${quote(`*${BACKUP_MARK}*`)} -delete 2>/dev/null; echo done`;
}

export interface BackupEntry {
  /** 备份文件的绝对路径。 */
  path: string;
  /** 它保护的原文件路径。 */
  original: string;
}

/** 解析 `find` 的输出成结构化列表。 */
export function parseBackups(stdout: string): BackupEntry[] {
  return stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && isBackupPath(line))
    .map((path) => ({ path, original: originalPathOf(path) }));
}

/**
 * 权限模式的说明文案（界面上直接在开关旁边展示）。
 *
 * 只读：查询直接执行，写 / 改 / 删确认一次；完全权限：写入、修改与删除
 * 直接执行（含 sudo），但"只查询"的请求仍然只做只读操作。
 */
export const PERMISSION_HINT: Record<PermissionMode, string> = {
  readonly:
    "只读：只执行查询；写入、修改、删除会被直接拒绝，不产生确认。sudo 禁用。",
  ask:
    "按需确认：查询直接执行；命令确实要写文件、改配置、改服务或删数据时，逐条请你确认。sudo 需确认。",
  full:
    "完全访问：你明确要求的写入、修改与删除（含 sudo、服务重启）直接执行；严重操作（改 SSH / 防火墙 / 磁盘 / 删系统目录等）仍会确认。备份按权限页的策略执行，备份文件带 .bls-bak. 标记。",
};
