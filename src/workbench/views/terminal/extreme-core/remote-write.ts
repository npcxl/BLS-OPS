/**
 * 服务器文件的**写前备份**。
 *
 * 超能里任何一次写（AI 改文件、部署替换、静态更新）都先落一份同目录备份，
 * 命令与路径都从这里生成，避免各条写路径各写一套（漏备份就是改坏线上文件
 * 没法回退）。
 *
 * 纯函数，便于单测；执行仍走现有的 `sshExec`。
 */
const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;

export interface WriteBackup {
  /** 备份文件绝对路径（与源文件同目录，便于就地回滚）。 */
  path: string;
  /** 备份命令；回滚时把 `cp -a` 的方向反过来即可。 */
  command: string;
  /** 回滚命令。 */
  rollback: string;
}

/**
 * 生成备份计划。`stamp` 由调用方传入（毫秒时间戳），保证可测。
 *
 * 备份名带时间戳后缀：同一文件多次改动各留一份，不会被覆盖。
 */
export function planWriteBackup(target: string, stamp: number | string = Date.now()): WriteBackup {
  const path = `${target}.bls-bak.${stamp}`;
  return {
    path,
    command: `cp -a ${quote(target)} ${quote(path)}`,
    rollback: `cp -a ${quote(path)} ${quote(target)}`,
  };
}

/** 写文件前必须先备份的类型：目录不备份（由调用方按文件逐个处理）。 */
export function needsBackup(entry: { kind: "file" | "dir" | "symlink"; size?: number }): boolean {
  return entry.kind === "file";
}
