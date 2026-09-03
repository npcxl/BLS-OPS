import type { CommandParams, CommandSearchHit } from "@/api/ops-api";

/**
 * 终端内联补全：把知识库命令写进**远程 shell 的当前行**。
 *
 * 远程 shell 才是真正的行编辑器 —— 这里只能发送按键序列让它改自己的行，
 * 不能假设我们知道它的缓冲内容（我们只跟踪用户键入的草稿）。
 */

/** readline 的 unix-line-discard：清空整行，不受多字节字符宽度影响。 */
const CTRL_U = "\x15";

/**
 * 计算要写入终端的按键序列。
 *
 * - 目标是当前草稿的延续（`docker p` → `docker ps`）：只补差异，最小侵入；
 * - 不是前缀关系（中文查询"查看所有容器" → `docker ps -a`）：先 Ctrl+U
 *   清行再整条写入。用退格逐个删在多字节输入下会算错删除次数。
 */
export function completionKeys(draft: string, syntax: string): string {
  if (draft.length > 0 && syntax.startsWith(draft)) {
    return syntax.slice(draft.length);
  }
  if (draft.length === 0) return syntax;
  return CTRL_U + syntax;
}

/** 是否需要用户先填参数（后端 required_params 是唯一事实来源）。 */
export function needsParams(hit: CommandSearchHit): boolean {
  return hit.can_execute && hit.required_params.length > 0;
}

const PARAM_LABELS: Record<string, string> = {
  container: "容器名",
  unit: "服务单元名",
  path: "绝对路径",
};

/** 参数输入框的展示名。 */
export function paramLabel(name: string): string {
  return PARAM_LABELS[name] ?? name;
}

/**
 * 从展示语法里取占位提示（`docker logs --tail 200 <容器>` → "容器"）。
 * 不做语法解析，只取 `<...>` 内文本。
 */
export function placeholderFor(hit: CommandSearchHit, name: string): string {
  const match = hit.syntax.match(/<([^>]+)>/g);
  const placeholders = match?.map((token) => token.slice(1, -1)) ?? [];
  return placeholders.find((text) => text.includes(name)) ?? paramLabel(name);
}

/** 直接执行（无需参数）时的空参数。 */
export function buildArgs(_hit: CommandSearchHit): CommandParams {
  return {};
}
