import type { CommandParams, CommandSearchHit } from "@/api/ops-api";

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
 * 从命中的展示语法里提取默认值提示（`docker logs --tail 200 <容器>` →
 * 占位符"容器名"）。不做语法解析 —— 只取 `<...>` 内文本作占位。
 */
export function placeholderFor(hit: CommandSearchHit, name: string): string {
  const match = hit.syntax.match(new RegExp(`<([^>]+)>`, "g"));
  const placeholders = match?.map((token) => token.slice(1, -1)) ?? [];
  return placeholders.find((text) => text.includes(name)) ?? paramLabel(name);
}

/** 直接执行（无需参数）时组装空参数。 */
export function buildArgs(_hit: CommandSearchHit): CommandParams {
  return {};
}
