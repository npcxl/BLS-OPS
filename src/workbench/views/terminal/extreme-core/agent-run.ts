/**
 * Agent 运行的**等待与收尾**。
 *
 * 循环在 Rust 侧，前端不等 SSH：启动后这里只做两件事：
 * * 订阅 `agent-event` 的终态事件（由视图注册）；
 * * 轮询 `aiAgentSnapshot` 兜底（事件丢了也能收敛，重进时能恢复）。
 *
 * 等待逻辑放在模块级而不是组件里：`ask()` 的闭包即使跨组件卸载也要能收尾，
 * 否则"收起面板再回来"会永远停在"正在回答…"。
 */
import { opsApi } from "@/api/ops-api";
import type { AgentEvent, AgentSnapshot } from "@/api/types/agent";

type Waiter = (snapshot: AgentSnapshot) => void;

const waiters = new Map<string, Set<Waiter>>();

/** 终态事件的快照（没有步骤：只用于收尾正文与错误）。 */
export function snapshotFromEvent(event: AgentEvent): AgentSnapshot {
  const status =
    event.kind === "finished"
      ? "success"
      : event.kind === "failed"
        ? "failed"
        : event.kind === "cancelled"
          ? "cancelled"
          : "running";
  return {
    taskId: event.taskId,
    status,
    model: event.model ?? "",
    content: event.content ?? "",
    error: event.message ?? null,
    cwd: event.cwd ?? "",
    server: "",
    sessionId: "",
    steps: [],
    context: event.context,
    updatedAt: Date.now(),
  };
}

/** 视图收到终态事件时调用：唤醒所有等待同一个 taskId 的人。 */
export function notifyAgentFinished(snapshot: AgentSnapshot): void {
  const listeners = waiters.get(snapshot.taskId);
  if (!listeners) return;
  for (const listener of [...listeners]) listener(snapshot);
}

function isTerminal(status: string): boolean {
  return status === "success" || status === "failed" || status === "cancelled";
}

/**
 * 等到任务结束。
 *
 * `timeoutMs` 与后端总上限（30 分钟）对齐，再多留一分钟收尾。
 * 无法确认终态时返回 null。
 */
export function waitForAgentRun(
  taskId: string,
  options: {
    pollMs?: number;
    timeoutMs?: number;
    /**
     * 只认这个时刻之后更新的快照。
     *
     * 续跑会**复用同一个 taskId**（卡片不换），但上一轮留下的终态快照可能还
     * 在，第一次轮询就读到它 → 界面直接"完成"，而新一轮其实刚开始。启动时
     * 传下"这次开始的时刻"，比它旧的记录一律忽略。
     */
    since?: number;
    /** 每次轮询到快照都回调（界面用它显示上下文用量，不必等到结束）。 */
    onSnapshot?: (snapshot: AgentSnapshot) => void;
  } = {},
): Promise<AgentSnapshot | null> {
  const pollMs = options.pollMs ?? 1500;
  const timeoutMs = options.timeoutMs ?? 31 * 60 * 1000;
  const since = options.since ?? 0;

  return new Promise((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const started = Date.now();

    const finish = (snapshot: AgentSnapshot | null) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      waiters.get(taskId)?.delete(listener);
      if (waiters.get(taskId)?.size === 0) waiters.delete(taskId);
      resolve(snapshot);
    };
    const listener: Waiter = (snapshot) => {
      if (isTerminal(snapshot.status) && snapshot.updatedAt >= since) finish(snapshot);
    };

    const set = waiters.get(taskId) ?? new Set<Waiter>();
    set.add(listener);
    waiters.set(taskId, set);

    /** 连续拿到 null 的次数：运行还没登记（刚启动）和记录已被清掉要区分开。 */
    let missing = 0;
    const tick = async () => {
      if (settled) return;
      try {
        const snapshot = await opsApi.aiAgentSnapshot(taskId);
        if (settled) return;
        // 上一轮留下的快照（updatedAt 早于本次启动）：不是这次的结果。
        if (snapshot && snapshot.updatedAt < since) {
          missing += 1;
        } else if (snapshot) {
          missing = 0;
          options.onSnapshot?.(snapshot);
          if (isTerminal(snapshot.status)) {
            finish(snapshot);
            return;
          }
        } else {
          missing += 1;
        }
      } catch {
        // 单次查询失败不致命：下一轮继续（事件仍是主通道）。
      }
      if (settled) return;
      const elapsed = Date.now() - started;
      // 后端没有这条运行（进程重启 / 记录已清理）：别让界面永远等下去。
      if (missing >= 3 && elapsed > 5000) {
        finish(null);
        return;
      }
      if (elapsed > timeoutMs) {
        finish(null);
        return;
      }
      timer = setTimeout(() => void tick(), pollMs);
    };

    // 立刻查一次：`agent_start` 已经登记过运行，正常情况下这一轮就能拿到。
    void tick();
  });
}

/** 视图主动放弃等待（例如组件卸载 / 用户关闭会话）。 */
export function forgetAgentWait(taskId: string): void {
  const listeners = waiters.get(taskId);
  if (!listeners) return;
  for (const listener of [...listeners]) {
    listener({
      taskId,
      status: "cancelled",
      model: "",
      content: "",
      error: null,
      cwd: "",
      server: "",
      sessionId: "",
      steps: [],
      updatedAt: Date.now(),
    });
  }
  waiters.delete(taskId);
}
