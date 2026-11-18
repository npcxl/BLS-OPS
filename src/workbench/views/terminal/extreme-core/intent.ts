/**
 * 超能的**意图路由**（纯函数）。
 *
 * 解决的问题：对话里已经定位好目标、用户只说「开始吧」，界面却去生成另一种
 * 计划。这里把"这句话是不是在继续某个任务"变成可测的判断：
 *
 * * 只有**唯一**可继续的任务时才自动接续；
 * * 有待确认计划 → 直接执行它；没有计划 → 生成计划等确认；
 * * 多个任务都在等 → 让用户选，**不新起任务**；
 * * 其余情况走普通问答。
 */
import { canContinue, hasPlan, type TaskContext } from "./task-context";

/** 简短肯定/继续类回复。只匹配**整句**，避免"开始部署前先看看"被误判。 */
const START_PATTERNS = [
  /^(开始|开始吧|开始执行|继续|继续吧|确认|确认执行|执行|执行吧|可以|好的?|行|嗯|走|走起|干吧|上吧)[。.!！~～]*$/,
  /^(ok|okay|go|go ahead|start|continue|confirm|proceed|yes)[.!]*$/i,
];

export function isStartIntent(text: string): boolean {
  const value = text.trim();
  if (value.length === 0 || value.length > 24) return false;
  return START_PATTERNS.some((pattern) => pattern.test(value));
}

export function isStopIntent(text: string): boolean {
  // `停` 单独一个字也算：等确认 / 执行中这两个时刻，用户只会打这么短。
  return /^(?:(?:停止|取消|中止)(?:任务|部署|执行)?|停|停一下|先停|stop|cancel)[。.!！]*$/i.test(
    text.trim(),
  );
}

/**
 * 「重试」类短句：`重试` / `再试一次` / `刚才那步再跑一下`。
 *
 * 只认**整句**且限长（≤24 字）：像「重试按钮为什么没反应」这种提问不能被当成
 * 重试去重新起一个任务。
 */
const RETRY_PATTERNS = [
  /^(重试|再试|重新试|重跑|再跑|再来一次|retry|try\s*again)(一下|一次|一遍)?[。.!！~～]*$/i,
  /^(刚才|上一步|上条|那一步|那步|这步|这个)?[^，。！？]{0,6}(再|重新)(跑|试|执行)(一下|一次)?[。.!！]*$/,
];

export function isRetryIntent(text: string): boolean {
  const value = text.trim();
  if (value.length === 0 || value.length > 24) return false;
  return RETRY_PATTERNS.some((pattern) => pattern.test(value));
}

/** 有待确认的写操作时，用户这句话是在表态还是提问。 */
export type ApprovalIntent = "allow" | "deny" | "explain";

/**
 * 「按你说的改 / 先别动 / 会影响什么」——确认卡上的三种口头答复。
 *
 * 只认**整句**短回复（≤24 字），避免把正常提问当成表态。问影响的句子放宽到
 * 40 字，但仍要求出现"影响 / 风险 / 会改什么"这类词：宁可走问答，也不要
 * 把一句分析当成"允许执行"。
 */
const ALLOW_PATTERNS = [
  /^(按你说的改|按你说的做|按你说的办|按你说的|就按你说的|就这么改|就这么办|改吧|可以|行|好|好的|同意|允许|确认|确认执行|执行|执行吧|开始|开始吧|动手|动手吧|上吧|继续|继续吧)[。.!！~～]*$/,
  /^(ok|okay|yes|go ahead|apply it|do it|proceed)[.!]*$/i,
];

const DENY_PATTERNS = [
  /^(先别动|别动|不要动|别改|不要改|先不要|先不|先别|先等等|等等|暂停|停|停止|取消|拒绝|算了吧|算了|不行|不要|别执行|先不改|先不弄)[。.!！~～]*$/,
  /^(no|nope|stop|cancel|not now|hold on)[.!]*$/i,
];

const EXPLAIN_PATTERN = /(影响|风险|会改(什么|哪|啥)|改哪|动哪|为什么|为啥|具体改|会动到|有什么变化|安全吗|会坏吗)/;

/** 组合确认只能包含同意、执行当前操作和完成后通知。 */
const AFFIRMATIVE_CLAUSE = /^(嗯|好|好的|可以|行|没问题|同意)$/;
const EXECUTE_CLAUSE = /^(?:(?:就)?按你说的[改做办]|就这样[改做办]|就这么[改做办]|确认执行|执行|开始)(?:吧)?$/;
const REPORT_CLAUSE = /^(?:做|改|执行|跑|完成)(?:完)?(?:了)?(?:告诉我|通知我|叫我)$/;

export function approvalIntent(text: string): ApprovalIntent | null {
  const value = text.trim();
  if (!value) return null;
  if (DENY_PATTERNS.some((pattern) => pattern.test(value))) return "deny";
  /*
   * 整句就是一句**无条件**的答应（「确认执行」「按你说的改」「ok」）：这几个
   * 模式本身不含条件词，先按允许处理。
   */
  if (value.length <= 24 && ALLOW_PATTERNS.some((pattern) => pattern.test(value))) return "allow";
  if (value.length <= 40 && EXPLAIN_PATTERN.test(value)) return "explain";
  const [affirmative, execute, report, ...rest] = value
    .replace(/[。.!！~～]+$/, "")
    .split(/[，,]/)
    .map((clause) => clause.trim());
  if (
    rest.length === 0 &&
    AFFIRMATIVE_CLAUSE.test(affirmative) &&
    execute &&
    EXECUTE_CLAUSE.test(execute) &&
    (report === undefined || REPORT_CLAUSE.test(report))
  ) {
    return "allow";
  }
  return null;
}

export type IntentRoute =
  /** 继续这个任务：已有计划 → 直接执行；没有 → 生成计划。 */
  | { kind: "continue"; taskId: string; action: "run" | "plan" }
  /** 多个任务可继续：交给用户选，绝不新起任务。 */
  | { kind: "choose"; taskIds: string[] }
  /** 普通问答。 */
  | { kind: "chat" };

/**
 * 决定这条消息该走向哪里。
 *
 * `tasks` 传当前会话里的任务（顺序不限）；只有 `canContinue` 的才参与匹配。
 */
export function routeIntent(text: string, tasks: TaskContext[]): IntentRoute {
  if (!isStartIntent(text)) return { kind: "chat" };

  const candidates = tasks.filter(canContinue);
  if (candidates.length === 0) return { kind: "chat" };
  if (candidates.length > 1) return { kind: "choose", taskIds: candidates.map((task) => task.taskId) };

  const [task] = candidates;
  return { kind: "continue", taskId: task.taskId, action: hasPlan(task) ? "run" : "plan" };
}
