/**
 * 任务卡 / 任务历史共用的**视图模型**。
 *
 * 纯函数，不碰 React、不碰 Tauri：把「执行中的计划」和「历史记录里的
 * plan_json」收敛成同一个 `TaskCardModel`，卡片、历史详情、任务 Tab 都渲染
 * 这一个东西，避免三处各写一套状态映射。
 */
import type { AgentOutcome } from "@/api/types/agent";
import type { ExtremeTaskRecord } from "@/api/types/extreme";
import type { DeployStep } from "./deploy-plan";
import type { TaskKind, TaskStatus } from "./task";

/** 历史状态 → 卡片状态。后端存的是 success/failed/cancelled/running/waiting。 */
export function statusOf(raw: string): TaskStatus {
  switch (raw) {
    case "success":
      return "done";
    case "failed":
      return "failed";
    case "cancelled":
      return "cancelled";
    case "waiting":
      return "waiting";
    case "running":
    case "verifying":
      return "running";
    case "confirming":
      return "confirming";
    default:
      return "inspecting";
  }
}

/** 卡片状态 → 历史状态（写库用）。 */
export function statusForRecord(status: TaskStatus): string {
  switch (status) {
    case "done":
      return "success";
    case "failed":
      return "failed";
    case "cancelled":
      return "cancelled";
    case "waiting":
      return "waiting";
    case "confirming":
      return "waiting";
    default:
      return "running";
  }
}

const KINDS: TaskKind[] = ["deploy", "query", "probe", "build", "automation"];
const KIND_ALIAS: Record<string, TaskKind> = { transfer: "deploy" };

export function kindOf(raw: string | undefined): TaskKind {
  const kind = raw ?? "deploy";
  if (KIND_ALIAS[kind]) return KIND_ALIAS[kind];
  return (KINDS as string[]).includes(kind) ? (kind as TaskKind) : "deploy";
}

/**
 * 任务类型看**用户目标**，不看步骤风险。
 *
 * 旧实现"有写步骤就是自动化、全只读就是检测"会把"查一下跑的服务"归成检测，
 * 也会把"重启 nginx"归成自动化之外的类型；用户在「查询 / 构建」筛选里找不到
 * 自己刚做的事。风险仍然单独记录，不再参与分类。
 *
 * 顺序有意为之：
 * 1. 部署 / 构建是明确交付动作，优先；
 * 2. 强改动动词（重启 / 删除 / 修改…）压过"查/看"——"查一下然后重启"是改；
 * 3. 「检查 / 巡检」比泛查询更具体，先判；
 * 4. 都没有明确动词时按自动化处理（保守：不把可能改动的事归成只读查询）。
 * 「更新 / 升级」不放进强改动：常见于"查一下有没有更新"。
 */
export function kindOfGoal(goal: string): TaskKind {
  const text = goal.trim().toLowerCase();
  if (!text) return "automation";
  if (/部署|发布|上线|deploy|release/.test(text)) return "deploy";
  if (/构建|编译|打包|build|compile/.test(text)) return "build";
  if (
    /重启|启动|停止|关闭|删除|删掉|移除|修改|改成|调整|修复|修好|处理|写入|安装|卸载|回滚|配置|restart|start|stop|delete|remove|write|install|uninstall|rollback|chmod|chown|kill|flush/.test(
      text,
    )
  ) {
    return "automation";
  }
  if (/巡检|检测|诊断|排查|检查|probe|inspect|diagnose|check/.test(text)) return "probe";
  if (/查|看|列出|列一下|状态|日志|哪些|有没有|是否|统计|show|list|status|log|query/.test(text)) {
    return "query";
  }
  return "automation";
}

export type TaskRisk = "read" | "write" | "danger";

export function normalizeRisk(raw: string | undefined): TaskRisk {
  return raw === "danger" || raw === "write" ? raw : "read";
}

/** 一组步骤里的最高风险（类别仍由目标决定，风险单独存）。 */
export function riskOfSteps(steps: DeployStep[]): TaskRisk {
  let risk: TaskRisk = "read";
  for (const step of steps) {
    if (step.risk === "danger") return "danger";
    if (step.risk === "write") risk = "write";
  }
  return risk;
}

/** 从 `plan_json` 解析出最高风险；解析不了 / 空计划返回 `null`。 */
export function riskOfPlan(planJson: string): TaskRisk | null {
  try {
    const parsed: unknown = JSON.parse(planJson);
    if (!Array.isArray(parsed) || parsed.length === 0) return null;
    return riskOfSteps(parsed as DeployStep[]);
  } catch {
    return null;
  }
}

/** 任务产物：文件传输步骤里的目标路径，历史详情可以直接打开预览。 */
export interface TaskArtifact {
  name: string;
  path: string;
}

export interface TaskCardModel {
  id: string;
  source?: "agent";
  kind: TaskKind;
  title: string;
  /**
   * 这张卡属于哪条对话（workspace）。
   *
   * 任务卡全局按 taskId 存（后台任务要能继续更新），但**渲染与回写**必须按
   * 归属判定：A 的任务绝不能出现在 B 的对话里。
   */
  workspaceId?: string | null;
  /** 服务器配置 id（同名服务器靠它区分）。 */
  serverId?: string | null;
  /**
   * 发起这条任务的消息 id。
   *
   * 生成计划时显式写入，卡片就挂在那条消息下面；历史记录里没有对应消息，
   * 保持 `undefined`（不能退回"找最近一条没挂卡的消息"，那正是串任务的原因）。
   */
  originMessageId?: string;
  /** 用户原话 / 生成计划时的目标，用于"继续"时重新拼上下文。 */
  goal: string;
  status: TaskStatus;
  /** 一句话当前结果。 */
  result: string;
  server: string;
  sessionId: string;
  /**
   * 任务当前目录（Agent 每条命令执行后回读）。
   *
   * 右侧文件面板按它跟随：模型 `cd` 到哪，面板就停在哪，用户看到的是同一
   * 个目录，不用自己再输一遍路径。
   */
  cwd?: string;
  /** 生成计划时的会话：预览任务产物要用它，切服务器后也不改。 */
  createdAt: number;
  updatedAt: number;
  steps: DeployStep[];
  /** 可预览的产物（服务器绝对路径）。 */
  artifacts: TaskArtifact[];
  /** 终态验证结论：`verified` / `partial` / `needs_info`。 */
  outcome?: AgentOutcome | null;
}

export function stepProgress(steps: DeployStep[]): { done: number; total: number; current?: DeployStep } {
  const total = steps.length;
  let done = 0;
  let current: DeployStep | undefined;
  for (const step of steps) {
    if (step.state === "success" || step.state === "skipped") done += 1;
    else if (!current && step.state !== "pending" && step.state !== "waiting") current = step;
  }
  return { done, total, current };
}

/** 步骤里能直接打开的服务器文件（上传步骤的目标路径）。 */
export function artifactsOf(steps: DeployStep[]): TaskArtifact[] {
  const out: TaskArtifact[] = [];
  for (const step of steps) {
    // 只有**执行成功**的步骤才算"确认存在"；失败 / 未执行的路径不进入口。
    if (step.state !== "success") continue;
    const path = step.remotePath;
    if (!path) continue;
    const name = path.split("/").filter(Boolean).pop() ?? path;
    if (out.some((item) => item.path === path)) continue;
    out.push({ name, path });
  }
  return out;
}

export function titleOf(kind: TaskKind, server: string): string {
  switch (kind) {
    case "query":
      return `${server} · 查询`;
    case "probe":
      return `${server} · 检测`;
    case "build":
      return `${server} · 构建`;
    case "automation":
      return `${server} · 自动化`;
    default:
      return `${server} · 部署`;
  }
}

/** 历史记录 → 卡片。`plan_json` 解析失败时退化成"空步骤 + 记录摘要"。 */
export function cardFromRecord(
  record: ExtremeTaskRecord,
  goal = "",
  originMessageId?: string,
): TaskCardModel {
  let steps: DeployStep[] = [];
  try {
    const parsed = JSON.parse(record.planJson) as unknown;
    if (Array.isArray(parsed)) steps = parsed as DeployStep[];
  } catch {
    steps = [];
  }
  const recordGoal = record.goal?.trim() ?? "";
  const kind = recordGoal ? kindOfGoal(recordGoal) : kindOf(record.kind);
  /*
   * 从库里读出来的 `running` / `waiting` 一定是**上次进程留下的**：任务句柄
   * 只在内存里，进程退出就没有任何东西会再推进它。标成「已中断」，并允许
   * 从检查点恢复；不能继续显示成"执行中"。
   */
  const interrupted = record.status === "running" || record.status === "waiting";
  let outcome: AgentOutcome | null = null;
  if (record.outcomeJson) {
    try {
      const parsed = JSON.parse(record.outcomeJson) as unknown;
      if (parsed && typeof parsed === "object" && "level" in parsed) {
        outcome = parsed as AgentOutcome;
      }
    } catch {
      outcome = null;
    }
  }
  return {
    id: record.id,
    kind,
    // 旧记录没有归属字段：保留为未关联，不猜。
    workspaceId: record.workspaceId ?? null,
    serverId: record.serverId ?? null,
    // 标题稳定：自定义名称 > 用户目标 > 类型 + 服务器；不拿会变的摘要当标题。
    title: record.name?.trim() || recordGoal || titleOf(kind, record.server),
    originMessageId,
    goal: recordGoal || goal,
    status: interrupted ? "interrupted" : statusOf(record.status),
    result: interrupted
      ? "上次运行已中断：最后一步是否生效需要先在服务器上核对。"
      : record.summary,
    server: record.server,
    sessionId: record.sessionId,
    cwd: record.cwd || undefined,
    createdAt: record.createdAt,
    updatedAt: record.createdAt,
    steps,
    artifacts: artifactsOf(steps),
    outcome,
  };
}

/** 执行中的计划 → 卡片（和历史记录同构，卡片组件不用区分来源）。 */
export function cardFromPlan(input: {
  id: string;
  plan: DeployStep[];
  server: string;
  sessionId: string;
  /** 归属：哪条对话发起的（后台任务回写与渲染都按它判定）。 */
  workspaceId?: string | null;
  serverId?: string | null;
  /** 发起这条任务的消息：卡片只挂这一条。 */
  originMessageId?: string;
  goal?: string;
  status?: TaskStatus;
  result?: string;
  kind?: TaskKind;
  createdAt?: number;
}): TaskCardModel {
  const kind = input.kind ?? "deploy";
  const progress = stepProgress(input.plan);
  const now = Date.now();
  const failed = input.plan.find((step) => step.state === "failed");
  const status = input.status ?? (failed ? "failed" : progress.done === progress.total && progress.total > 0 ? "done" : "running");
  return {
    id: input.id,
    kind,
    workspaceId: input.workspaceId ?? null,
    serverId: input.serverId ?? null,
    title: titleOf(kind, input.server),
    originMessageId: input.originMessageId,
    goal: input.goal ?? "",
    status,
    result:
      input.result ??
      (failed
        ? `卡在「${failed.title}」`
        : `${progress.done}/${progress.total} 步完成`),
    server: input.server,
    sessionId: input.sessionId,
    createdAt: input.createdAt ?? now,
    updatedAt: now,
    steps: input.plan,
    artifacts: artifactsOf(input.plan),
  };
}

/**
 * 还有任务要处理的对话（删除对话时会被拦下）。
 *
 * 「删除对话」与「停止任务」是两件事：正在跑 / 等确认时删掉记录，用户就再也
 * 看不到进度与输出，而任务还在服务器上跑。
 */
export function blockedWorkspaces(
  tasks: Record<string, TaskCardModel>,
  currentWorkspaceId: string | null,
  executing: boolean,
): Set<string> {
  const blocked = new Set<string>();
  for (const task of Object.values(tasks)) {
    if (
      task.workspaceId &&
      (task.status === "running" || task.status === "confirming" || task.status === "waiting")
    ) {
      blocked.add(task.workspaceId);
    }
  }
  if (executing && currentWorkspaceId) blocked.add(currentWorkspaceId);
  return blocked;
}

/** 历史列表「执行中 / 等待用户」置顶：返回排序后的新数组。 */
export function sortHistory(records: ExtremeTaskRecord[]): ExtremeTaskRecord[] {
  const active = (status: string) => status === "running" || status === "waiting";
  return [...records].sort((a, b) => {
    const activeA = active(a.status) ? 1 : 0;
    const activeB = active(b.status) ? 1 : 0;
    if (activeA !== activeB) return activeB - activeA;
    return b.createdAt - a.createdAt;
  });
}

/** 历史列表的筛选条件；`all` / 空串不筛。 */
export interface HistoryFilter {
  kind?: string;
  status?: string;
  server?: string;
}

/** 合并之后再筛：状态用的是实时覆盖后的结果，不会出现"筛选与列表对不上"。 */
export function filterHistory(
  records: ExtremeTaskRecord[],
  filter: HistoryFilter,
): ExtremeTaskRecord[] {
  const match = (value: string | undefined, wanted: string | undefined) =>
    !wanted || wanted === "all" || value === wanted;
  return records.filter(
    (record) =>
      match(record.kind, filter.kind) &&
      match(record.status, filter.status) &&
      match(record.server, filter.server),
  );
}

/**
 * 历史列表的**唯一合并入口**：先按 taskId 合并数据库记录与内存实时状态，
 * 再统一筛选 / 排序。
 *
 * 顺序反了（先按状态查库、再覆盖）就会出现"执行中筛选里躺着已成功的任务"
 * "成功筛选里看不到刚完成的任务" —— 因为筛选发生在实时状态之前。
 *
 * 实时卡片还会补上数据库还没写进去的**新任务**；类型统一按用户目标重算，
 * 旧记录没有 goal 时沿用保存的类型。风险从步骤里重算，旧记录才准。
 */
export function mergeHistory(
  records: ExtremeTaskRecord[],
  live: Record<string, TaskCardModel>,
): ExtremeTaskRecord[] {
  const map = new Map<string, ExtremeTaskRecord>();
  for (const record of records) {
    const goal = record.goal?.trim() ?? "";
    map.set(record.id, {
      ...record,
      goal,
      kind: goal ? kindOfGoal(goal) : kindOf(record.kind),
      risk: riskOfPlan(record.planJson) ?? normalizeRisk(record.risk),
    });
  }
  for (const card of Object.values(live)) {
    const record = map.get(card.id);
    const goal = card.goal?.trim() || record?.goal?.trim() || "";
    map.set(card.id, {
      id: card.id,
      kind: goal ? kindOfGoal(goal) : kindOf(card.kind),
      server: card.server || record?.server || "",
      serverId: card.serverId ?? record?.serverId ?? null,
      workspaceId: card.workspaceId ?? record?.workspaceId ?? null,
      sessionId: card.sessionId || record?.sessionId || "",
      status: statusForRecord(card.status),
      name: record?.name ?? "",
      goal,
      risk: riskOfSteps(card.steps),
      summary: card.result || record?.summary || "",
      planJson: JSON.stringify(card.steps),
      createdAt: card.createdAt ?? record?.createdAt ?? Date.now(),
    });
  }
  return sortHistory([...map.values()]);
}
