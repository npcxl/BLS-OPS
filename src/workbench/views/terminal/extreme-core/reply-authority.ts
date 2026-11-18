/**
 * 回复正文的**权威覆盖**判定（纯函数）。
 *
 * 背景：流式中途收起面板 / 刷新再重进时，气泡里只有重进后收到的增量，
 * 缺重进前流出的前半段。后端终态 `content` 与快照才是权威全文 ——
 * "只在气泡为空时兜底"会把开头永久丢掉。
 *
 * 原则与 `tool_finished` 一致：**完整值覆盖增量**。
 */

/**
 * 终态时气泡该写什么。返回 `null` = 不动现有正文。
 *
 * * `finished` —— 权威全文非空且与现状不同就覆盖（修复重进丢开头）；
 * * `cancelled` —— 只在气泡为空时写「已停止。」，不清掉用户已看到的半截回答；
 * * `failed` —— 不动正文（失败原因在任务卡与错误条上）。
 *
 * `authoritative` 必须是**已过滤内部标记**的全文（调用方先跑
 * `stripPanelAction(parseActions(...))`），这里不做二次解析。
 */
export function terminalReplyText(
  kind: "finished" | "failed" | "cancelled",
  authoritative: string,
  current: string,
  stoppedLabel: string,
): string | null {
  if (kind === "finished") {
    return authoritative && authoritative !== current ? authoritative : null;
  }
  if (kind === "cancelled" && !current) return stoppedLabel;
  return null;
}

/**
 * 重进接回**还在跑**的任务时，要不要用快照前缀回填气泡。
 *
 * 不回填的两种情况：前缀为空 / 与现状一致（无事可做）；气泡已经比快照
 * **更新**（快照查询与增量到达的竞态）—— 回滚会把新到的尾巴冲掉。
 * 其余情况（气泡为空、只有半截后缀、是前缀的旧前缀）都回填：快照包含
 * 到查询时刻为止的全部正文，覆盖不会丢内容。
 */
export function shouldBackfillPrefix(prefix: string, current: string): boolean {
  if (!prefix || current === prefix) return false;
  return !(current.length > prefix.length && current.startsWith(prefix));
}
