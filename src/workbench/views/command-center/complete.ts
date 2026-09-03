import type { CommandParams, CommandSearchHit } from "@/api/ops-api";

/**
 * 终端内联补全：把知识库命令写进**远程 shell 的当前行**。
 *
 * 远程 shell 才是真正的行编辑器 —— 这里只能发送按键序列让它改自己的行，
 * 不能假设我们知道它的缓冲内容（我们只跟踪用户键入的草稿）。
 *
 * # 铁律：占位符绝不能进 shell
 *
 * 知识库的 `syntax` 是**展示语法**：`journalctl -u <unit> -n 200 --no-pager`
 * 里的 `<unit>` 是"这里要换成具体服务名"。原样写进终端会被 bash 当成
 * "从名为 unit 的文件读输入"，报 `-bash: unit: No such file or directory`。
 * 所以任何含未解析 `<...>` 的文本都禁止写入（见 [`completionKeys`] 与
 * [`hasUnresolvedPlaceholder`]），必须先经二级参数选择替换成真值。
 */

/** readline 的 unix-line-discard：清空整行，不受多字节字符宽度影响。 */
const CTRL_U = "\x15";

/** 占位符文本：`<unit>` / `<容器>` / `<路径>`。 */
const PLACEHOLDER = /<([^<>]+)>/g;

/**
 * 可动态取值的参数种类 —— 决定二级选择器去哪儿拉真实数据：
 * - `unit`：systemd 服务列表（`systemctl list-units --type=service --all`）
 * - `container`：Docker 容器列表
 * - `path`：远程文件目录
 */
export type ParamKind = "unit" | "container" | "path";

/** 占位符文本 → 参数种类。认不出来的返回 `null`（无法自动补全，只能人工填）。 */
const PLACEHOLDER_KINDS: Record<string, ParamKind> = {
  unit: "unit",
  单元: "unit",
  服务: "unit",
  服务名: "unit",
  服务单元: "unit",
  service: "unit",
  container: "container",
  容器: "container",
  容器名: "container",
  path: "path",
  路径: "path",
  目录: "path",
  文件: "path",
  绝对路径: "path",
};

export interface SyntaxPlaceholder {
  /** 原文（含尖括号），用于替换定位。 */
  token: string;
  /** 尖括号内的文本。 */
  name: string;
  /** 归一化后的参数种类；`null` = 无自动数据源，只能人工输入。 */
  kind: ParamKind | null;
}

/** 归一化：去首尾空白与常见修饰（`<容器名>` → 容器名）。 */
function normalizeName(raw: string): string {
  return raw.trim();
}

/**
 * 按出现顺序抽出语法里的全部占位符。
 *
 * 例：`journalctl -u <unit> --since <时间>` → [unit(unit), 时间(null)]
 */
export function placeholdersIn(syntax: string): SyntaxPlaceholder[] {
  const out: SyntaxPlaceholder[] = [];
  for (const match of syntax.matchAll(PLACEHOLDER)) {
    const token = match[0];
    const name = normalizeName(match[1]);
    if (!name) continue;
    out.push({ token, name, kind: PLACEHOLDER_KINDS[name] ?? null });
  }
  return out;
}

/** 是否还残留未替换的占位符 —— **发送 SSH 之前的最后一道拦截**。 */
export function hasUnresolvedPlaceholder(text: string): boolean {
  return /<[^<>]+>/.test(text);
}

/**
 * 能否自动补全：所有占位符都必须认得出种类。
 * 认不出的（如 `<时间>`、`<端口>`）没有数据源，不能开选择器 —— 只能由用户手填。
 */
export function canAutoFill(syntax: string): boolean {
  const found = placeholdersIn(syntax);
  return found.length > 0 && found.every((item) => item.kind !== null);
}

/**
 * 把第一个 `token` 占位符替换成 `value`；其余占位符原样保留（供下一轮继续填）。
 *
 * `value` 为空或含空白时不做替换 —— 服务名/容器名/路径都不该带空格，
 * 空值多半是选择器被取消。
 */
export function fillPlaceholder(syntax: string, token: string, value: string): string {
  const trimmed = value.trim();
  if (!trimmed || /\s/.test(trimmed)) return syntax;
  // 函数式替换：值里的 `$&` 等不会被当成替换模式。
  return syntax.replace(token, () => trimmed);
}

/**
 * 计算要写入终端的按键序列；**无法安全写入时返回 `null`**。
 *
 * - 目标文本仍含占位符 → `null`（调用方必须改走参数选择流程）；
 * - 是草稿的延续（`docker p` → `docker ps`）→ 只补差异，最小侵入；
 * - 非前缀关系（中文查询 → `docker ps -a`）→ 先 Ctrl+U 清行再整条写入。
 *   用退格逐个删在多字节输入下会算错删除次数。
 */
export function completionKeys(draft: string, syntax: string): string | null {
  if (hasUnresolvedPlaceholder(syntax)) return null;
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
