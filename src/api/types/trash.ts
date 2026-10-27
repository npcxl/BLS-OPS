/**
 * 远程回收站（`~/.bls-ops-trash`）。
 *
 * 删除默认移动到这里，而不是直接抹掉；恢复与永久删除是两个独立操作。
 */
export interface TrashEntry {
  /** 时间戳（毫秒），也是回收站目录名。 */
  id: string;
  name: string;
  original_path: string;
  deleted_at: number;
  /** `file` | `directory` | `symlink` | `other` */
  kind: string;
}
