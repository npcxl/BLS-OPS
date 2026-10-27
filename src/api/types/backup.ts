/**
 * 整机配置备份 / 恢复。
 *
 * 备份里**没有密钥**：凭据只带 id / 名称 / 用户名 / 类型，`secret_ref` 由后端
 * 清空。导入后需要重新绑定凭据，UI 必须把这件事说清楚。
 */

/** 一个分区的统计：总计 / 新增 / 冲突（本地已存在）。 */
export interface BackupSection {
  key: string;
  total: number;
  added: number;
  conflicts: number;
}

export interface BackupSummary {
  path: string;
  bytes: number;
  exported_at: number;
  servers: number;
  groups: number;
  credentials: number;
  known_hosts: number;
  projects: number;
  settings_included: boolean;
}

export interface BackupPreview {
  format: string;
  version: number;
  app_version: string;
  exported_at: number;
  sections: BackupSection[];
  /** 冲突项示例（`server: web-01`），最多 10 条。 */
  conflict_samples: string[];
  settings_included: boolean;
  /** 必须如实展示给用户的说明（凭据要重绑、格式偏旧…）。 */
  warnings: string[];
}

export interface BackupImportResult {
  added: number;
  overwritten: number;
  skipped: number;
  /** 备份里带的偏好，前端写入 localStorage。 */
  settings?: unknown;
}
