/**
 * Agent 事件 → 任务卡步骤的**唯一映射**（纯函数，便于单测）。
 *
 * 三个入口（实时事件、重进时的快照、历史记录）都收敛到同一套
 * `DeployStep[]`：卡片、历史详情、右栏读到的是同一个东西，不会出现
 * "聊天里 3 步、历史里 5 步"这种对不上的情况。
 */
import type { AgentEvent, AgentStep } from "@/api/types/agent";
import type { DeployStep, StepState } from "./deploy-plan";
import { kindOfGoal, titleOf, type TaskCardModel } from "./task-view";
import type { TaskKind, TaskStatus } from "./task";

export type Translate = (key: string, options?: Record<string, unknown>) => string;

/** 步骤在卡片上的状态（`waiting` 表示等用户确认）。 */
function stepState(state: string | undefined): StepState {
  switch (state) {
    case "running":
      return "running";
    case "waiting":
      return "waiting";
    case "success":
      return "success";
    case "failed":
      return "failed";
    case "skipped":
      return "skipped";
    default:
      return "pending";
  }
}

/** 一个空步骤（事件只给了 taskId / index 时兜底）。 */
function blankStep(index: number, event: AgentEvent): AgentStep {
  return {
    index,
    callId: event.callId ?? "",
    tool: event.tool ?? "",
    path: event.path ?? null,
    risk: event.risk ?? "read",
    state: event.state ?? "running",
    command: event.command ?? "",
    script: event.script ?? null,
    summary: event.summary ?? null,
    stdout: "",
    stderr: "",
    exitCode: null,
    cwd: event.cwd ?? "",
    truncated: false,
    backupPath: null,
    rollback: null,
    impact: event.impact ?? null,
    elapsedMs: 0,
  };
}

/**
 * 把一条事件合并进步骤列表（返回新数组）。
 *
 * * `tool_started` / `approval_required`：新建或覆盖该 index 的元信息；
 * * `tool_output`：**追加** stdout / stderr（界面边收边长）；
 * * `tool_finished`：整条替换（后端有完整输出，避免增量和完整值对不上）。
 */
export function mergeAgentStep(steps: AgentStep[], event: AgentEvent): AgentStep[] {
  if (event.stepIndex === undefined) return steps;
  const index = event.stepIndex;
  const position = steps.findIndex((step) => step.index === index);
  const current = position >= 0 ? steps[position] : blankStep(index, event);

  let next: AgentStep;
  if (event.kind === "tool_output") {
    next = {
      ...current,
      stdout: current.stdout + (event.stdout ?? ""),
      stderr: current.stderr + (event.stderr ?? ""),
    };
  } else if (event.kind === "tool_finished") {
    next = {
      ...current,
      state: event.state ?? "success",
      stdout:
        event.stdout !== undefined && event.stdout !== null ? event.stdout : current.stdout,
      stderr:
        event.stderr !== undefined && event.stderr !== null ? event.stderr : current.stderr,
      exitCode: event.exitCode === undefined ? current.exitCode : event.exitCode,
      cwd: event.cwd ?? current.cwd,
      truncated: event.truncated ?? current.truncated,
      backupPath: event.backupPath ?? current.backupPath,
      rollback: event.rollback ?? current.rollback,
      impact: event.impact ?? current.impact,
      script: event.script ?? current.script,
      summary: event.summary ?? current.summary,
      elapsedMs: event.elapsedMs ?? current.elapsedMs,
    };
  } else {
    next = {
      ...current,
      ...(event.tool ? { tool: event.tool } : {}),
      ...(event.path !== undefined ? { path: event.path } : {}),
      ...(event.risk ? { risk: event.risk } : {}),
      ...(event.state ? { state: event.state } : {}),
      ...(event.command ? { command: event.command } : {}),
      ...(event.cwd ? { cwd: event.cwd } : {}),
      ...(event.impact !== undefined ? { impact: event.impact } : {}),
      ...(event.backupPath !== undefined ? { backupPath: event.backupPath } : {}),
      ...(event.rollback !== undefined ? { rollback: event.rollback } : {}),
      ...(event.script !== undefined ? { script: event.script } : {}),
      ...(event.summary !== undefined ? { summary: event.summary } : {}),
    };
  }

  if (position < 0) return [...steps, next];
  const copy = [...steps];
  copy[position] = next;
  return copy;
}

/** 快照里的步骤 → 内部步骤（字段补齐，防止旧记录缺字段）。 */
export function stepsFromSnapshot(steps: AgentStep[] | undefined): AgentStep[] {
  return (steps ?? []).map((step) => ({
    ...blankStep(step.index, {} as AgentEvent),
    ...step,
    path: step.path ?? null,
    backupPath: step.backupPath ?? null,
    rollback: step.rollback ?? null,
    impact: step.impact ?? null,
    script: step.script ?? null,
    summary: step.summary ?? null,
  }));
}

/** 步骤标题：一句话摘要 > 命令本身 > 工具名，都不要"执行命令"这种空话。 */
export function stepTitle(step: AgentStep, t: Translate): string {
  const path = step.path ?? "";
  if (step.summary?.trim()) return step.summary.trim();
  switch (step.tool) {
    case "read_file":
      return t("读取 {{path}}", { path });
    case "list_dir":
      return t("列出目录 {{path}}", { path });
    case "write_file":
      return t("写入 {{path}}", { path });
    case "run_shell": {
      const first = step.command.split("\n").find((line) => line.trim())?.trim() ?? "";
      return first.length > 0 ? truncate(first, 90) : t("执行命令");
    }
    default:
      return step.tool || t("工具调用");
  }
}

function truncate(value: string, limit: number): string {
  return value.length <= limit ? value : `${value.slice(0, limit)}…`;
}

/** 风险的中文标签（确认框与卡片共用）。 */
export function riskLabel(risk: string | undefined, t: Translate): string {
  switch (risk) {
    case "danger":
      return t("危险");
    case "write":
      return t("写入");
    default:
      return t("只读");
  }
}

/** 步骤状态的一句话（卡片上区分"已确认 / 已拒绝 / 等待确认"）。 */
function stateNote(state: string, t: Translate): string {
  switch (state) {
    case "waiting":
      return t("等待你的确认");
    case "failed":
      return t("执行失败");
    case "success":
      return t("已完成");
    case "running":
      return t("执行中");
    default:
      return "";
  }
}

/** Agent 步骤 → 任务卡步骤。 */
export function toDeploySteps(steps: AgentStep[], t: Translate): DeployStep[] {
  return steps.map((step) => {
    const note = stateNote(step.state, t);
    const waiting = step.state === "waiting";
    /*
     * 待确认的那一步：完整命令与影响都在确认卡里，链上只留一句"在下方确认"，
     * 否则同一份内容会在操作链、卡片和回复里铺三遍。
     *
     * `write_file` 的命令体是整段 base64：原样展示会把卡片刷成几万字符，
     * 也等于把文件内容重复存一份。这里只给目标路径与备份位置。
     */
    const command = waiting || step.tool === "write_file" ? undefined : step.command || undefined;
    const detail = waiting
      ? [riskLabel(step.risk, t), t("在下方确认后才会执行")].filter(Boolean).join(" · ")
      : [riskLabel(step.risk, t), step.path ?? "", note, step.impact ?? ""]
          .filter(Boolean)
          .join(" · ");
    return {
      id: `agent-${step.index}`,
      kind: "tool",
      title: stepTitle(step, t),
      detail,
      command,
      // `cd` 包装与内部标记只进调试详情；待确认的那一步整块交给确认卡。
      script: waiting ? undefined : step.script ?? undefined,
      remotePath: step.tool === "write_file" ? step.path ?? undefined : undefined,
      risk: step.risk,
      backupPath: step.backupPath ?? undefined,
      rollback: step.rollback ?? undefined,
      state: stepState(step.state),
      stdout: step.stdout,
      stderr: step.stderr,
      exitCode: step.exitCode ?? null,
      truncated: step.truncated,
    };
  });
}

/** Agent 运行状态 → 卡片状态。 */
export function taskStatusOf(status: string): TaskStatus {
  switch (status) {
    case "waiting":
      return "confirming";
    case "success":
      return "done";
    case "failed":
      return "failed";
    case "cancelled":
      return "cancelled";
    default:
      return "running";
  }
}

/** 有一处写 / 危险操作就是"自动化"任务，全只读则是"检测"。 */
export function kindOfSteps(steps: AgentStep[]): TaskKind {
  return steps.some((step) => step.risk !== "read") ? "automation" : "probe";
}

/** 卡片上那句话：说清现在卡在哪、下一步是什么。 */
export function agentSummary(
  steps: AgentStep[],
  status: string,
  error: string | null | undefined,
  t: Translate,
): string {
  const failed = [...steps].reverse().find((step) => step.state === "failed");
  const waiting = [...steps].reverse().find((step) => step.state === "waiting");
  const running = [...steps].reverse().find((step) => step.state === "running");
  const last = steps[steps.length - 1];
  switch (status) {
    case "waiting":
      return t("等待你确认：{{command}}", {
        command: truncate(waiting?.summary ?? waiting?.command ?? "", 80),
      });
    case "success":
      return t("已完成 {{n}} 步", { n: steps.length });
    case "failed":
      return error?.trim() ||
        (failed
          ? t("第 {{n}} 步失败：{{detail}}", {
              n: failed.index + 1,
              detail: firstLine(failed.stderr) || firstLine(failed.stdout),
            })
          : t("执行失败"));
    case "cancelled":
      return t("已停止（停在「{{step}}」）", {
        step: truncate(last?.summary || last?.command || last?.tool || "", 80),
      });
    default:
      return running
        ? t("正在执行：{{command}}", {
            command: truncate(running.summary || running.command, 80),
          })
        : t("执行中…");
  }
}

function firstLine(value: string): string {
  return value.split("\n").map((line) => line.trim()).find(Boolean) ?? "";
}

/** 用事件 / 快照重建卡片（保留发起消息、创建时间与用户改的名称）。 */
export function cardFromAgent(input: {
  taskId: string;
  server: string;
  sessionId: string;
  /** 归属：哪条对话发起的（后台任务回写与渲染都按它判定）。 */
  workspaceId?: string | null;
  serverId?: string | null;
  originMessageId?: string;
  goal: string;
  steps: AgentStep[];
  status: string;
  error?: string | null;
  cwd?: string;
  existing?: TaskCardModel;
  now?: number;
  t: Translate;
}): TaskCardModel {
  const now = input.now ?? Date.now();
  // 类型看用户目标；没有目标（旧路径）才退回步骤风险，避免"查服务"被归成自动化。
  const kind = input.goal.trim() ? kindOfGoal(input.goal) : kindOfSteps(input.steps);
  /*
   * 快照里的 `status` 可能是 `running`，但某一步正挂着等确认（老快照 / 后端刚
   * 挂起的那一瞬间）。卡片必须显示"等你确认"，否则重进会以为它还在跑。
   */
  const status =
    input.status === "running" &&
    input.steps.some((step) => step.state === "waiting")
      ? "waiting"
      : input.status;
  return {
    id: input.taskId,
    source: "agent",
    kind,
    workspaceId: input.existing?.workspaceId ?? input.workspaceId ?? null,
    serverId: input.existing?.serverId ?? input.serverId ?? null,
    title: input.existing?.title ?? titleOf(kind, input.server),
    originMessageId: input.existing?.originMessageId ?? input.originMessageId,
    goal: input.existing?.goal || input.goal,
    status: taskStatusOf(status),
    result: agentSummary(input.steps, status, input.error, input.t),
    server: input.server,
    sessionId: input.sessionId,
    cwd: input.cwd ?? input.existing?.cwd,
    createdAt: input.existing?.createdAt ?? now,
    updatedAt: now,
    steps: toDeploySteps(input.steps, input.t),
    // 写过的文件直接给预览入口：用户能立刻对照备份看到改成了什么。
    artifacts: input.steps
      .filter((step) => step.tool === "write_file" && step.path)
      .map((step) => ({
        name: (step.path ?? "").split("/").filter(Boolean).pop() ?? step.path ?? "",
        path: step.path ?? "",
      }))
      .filter(
        (artifact, index, list) =>
          artifact.path !== "" &&
          list.findIndex((item) => item.path === artifact.path) === index,
      ),
  };
}
