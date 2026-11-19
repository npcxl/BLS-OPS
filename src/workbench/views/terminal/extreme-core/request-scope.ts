/**
 * 一次"要过服务器才出结果"的请求属于**哪条对话**。
 *
 * # 为什么需要它
 *
 * 同一台服务器上的几条对话共用一条 SSH 连接 —— `sessionId` 分不出是谁发的。
 * 探测（找日志来源、核对面板目标）又是异步的：回来时用户很可能已经在另一条
 * 对话里打字。没有归属判断，A 的结果就会打开 B 的右栏、覆盖 B 的候选。
 *
 * 所以请求发出时记下三样：**哪条对话**、**哪次连接**、**第几号请求**；结果
 * 回来时三样都对得上才允许动界面。同一条对话里连发两次时只认最后一次。
 */
export interface RequestScope {
  workspaceId: string;
  sessionId: string;
  /** 单调递增的请求号：同一条对话里"后发"的那次取代前一次。 */
  requestId: number;
}

export interface ScopeTracker {
  /** 发一个新请求：返回这次请求的归属。 */
  begin: (workspaceId: string, sessionId: string) => RequestScope;
  /**
   * 结果还能不能用：对话没换、连接没变、也没有被同一条对话的新请求取代。
   *
   * `current` 由调用方从 store 现读（不要用渲染闭包里的旧值）。
   */
  accept: (scope: RequestScope, current: { workspaceId: string | null; sessionId: string | null }) => boolean;
  /** 最近一次请求的归属（没有请求时为空）。 */
  latest: () => RequestScope | null;
}

export function createScopeTracker(): ScopeTracker {
  let seq = 0;
  let latest: RequestScope | null = null;
  return {
    begin(workspaceId, sessionId) {
      seq += 1;
      latest = { workspaceId, sessionId, requestId: seq };
      return latest;
    },
    accept(scope, current) {
      if (!latest || scope.requestId !== latest.requestId) return false;
      return current.workspaceId === scope.workspaceId && current.sessionId === scope.sessionId;
    },
    latest: () => latest,
  };
}
