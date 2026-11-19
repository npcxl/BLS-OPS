/**
 * 超能模式的任务历史类型。
 *
 * 与后端 `commands::extreme::ExtremeTaskRecord` 一一对应（camelCase）。
 * `planJson` 里是 `DeployStep[]` 的 JSON，历史详情按它恢复每步真实输出。
 */
export type ExtremeTaskKind = "deploy" | "query" | "probe" | "build" | "automation" | "transfer";

/** 历史里的状态：执行中的 `running` / `waiting` 也可能被写进去。 */
export type ExtremeTaskStatus = "running" | "waiting" | "success" | "failed" | "cancelled";

export interface ExtremeTaskRecord {
  id: string;
  kind: ExtremeTaskKind;
  server: string;
  /** 服务器配置 id：同名服务器 / 同地址不同账号靠它区分。 */
  serverId?: string | null;
  /** 发起这条任务的对话（workspace）。旧记录为 `null`（未关联）。 */
  workspaceId?: string | null;
  /** 生成计划时的 SSH 会话，仅用于关联；任务产物预览优先用它。 */
  sessionId: string;
  status: ExtremeTaskStatus | string;
  /** 用户自定义名称；为空时界面显示 goal / summary。 */
  name?: string;
  /** 用户目标：任务类型与稳定标题从它来。旧记录为空。 */
  goal?: string;
  /** 本次任务的最高风险（与类型分开记录）。旧记录缺省按 read。 */
  risk?: "read" | "write" | "danger";
  summary: string;
  planJson: string;
  /** 终态验证结论（JSON）；旧记录为空。 */
  outcomeJson?: string;
  /** 任务当前目录（恢复执行的起点）；旧记录为空。 */
  cwd?: string;
  createdAt: number;
}

/** 历史列表的筛选条件：空串 / 不传 = 不筛。 */
export interface ExtremeTaskFilter {
  limit?: number;
  kind?: string;
  status?: string;
  server?: string;
  serverId?: string;
  workspaceId?: string;
}
