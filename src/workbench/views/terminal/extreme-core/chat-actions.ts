/**
 * 聊天里的**动作标记**：模型用它在回复中请求执行，前端校验后调用现有执行器。
 *
 * 为什么需要这一层：删掉所有任务按钮之后，用户只说话，界面不能再靠点击推进。
 * 但"模型的自由文本不能直接执行"这条边界仍然要守 —— 所以模型只能输出**受限
 * 标记**，由前端白名单解析、映射到已有能力，绝不把文本当命令跑。
 *
 * 格式（可出现在正文任何位置，解析后从正文删除）：
 * ```
 * [[upload]]        上传附件到服务器临时目录
 * [[plan:ops]]      为目标服务生成更新计划（只生成，不执行）
 * [[start]]         执行已展示的计划
 * ```
 *
 * 站点定位、日志排查这类**只读**动作不在这里 —— 它们走工具循环
 * （`ai_chat_agent` 的 `ports` / `nginx` / `logs`），不需要额外通道。
 */

import { stripPanelAction } from "./panel-target";

export type ChatAction =
  | { kind: "upload" }
  | { kind: "plan"; service?: string }
  | { kind: "start" }
  /** 把一条长驻监听命令写进右侧真实终端（不等待返回）。 */
  | { kind: "terminal"; command: string };

/** 动作名白名单。不在这张表里的标记原样保留，避免误伤正常文本。 */
const PATTERN = /\[\[(upload|plan|start|terminal)(?::([^\]\n]*))?\]\]/gi;

/** 服务名只保留字母数字与 `- _ .`。 */
function cleanService(raw: string | undefined): string {
  const value = (raw ?? "").trim();
  return /^[a-zA-Z0-9._-]{1,64}$/.test(value) ? value : "";
}

/** 终端命令：单行、无控制字符、长度受限（写进 PTY 前再兜一层）。 */
function cleanCommand(raw: string | undefined): string {
  const value = (raw ?? "").trim();
  if (!value || value.length > 2000) return "";
  if (value.includes("\u0000") || /[\r\n]/.test(value)) return "";
  return value;
}

export function parseActions(text: string): { clean: string; actions: ChatAction[] } {
  const actions: ChatAction[] = [];
  const clean = text.replace(PATTERN, (_match, name: string, payload?: string) => {
    switch (name.toLowerCase()) {
      case "upload":
        actions.push({ kind: "upload" });
        break;
      case "plan": {
        const service = cleanService(payload);
        actions.push(service ? { kind: "plan", service } : { kind: "plan" });
        break;
      }
      case "start":
        actions.push({ kind: "start" });
        break;
      case "terminal": {
        const command = cleanCommand(payload);
        if (command) actions.push({ kind: "terminal", command });
        break;
      }
    }
    return "";
  });
  return { clean: clean.replace(/\n{3,}/g, "\n\n").trim(), actions };
}

/**
 * 流式增量**上屏前的可见文本**。
 *
 * 平台指令（`[[upload]]` / `[[plan:…]]` / `[[start]]` / `[[panel:…]]`）不能
 * 在气泡里闪一下再被删掉；流还没吐完时末尾可能是半个 `[[up`，这时先把这段
 * 尾巴压住不显示，等 `]]` 到了再决定它是标记还是普通文字。
 */
export function visibleStream(raw: string): string {
  // 兼容模式会把工具参数放进正文本身。整段工具请求只在操作链里展示。
  const text = raw
    .replace(/<tool\b[^>]*>[\s\S]*?<\/tool>/gi, "")
    .replace(/(?:<tool\b|<\||invoke name=)[\s\S]*$/i, "")
    .replace(/(?:<t(?:o(?:o)?)?|<|invoke name)\s*$/i, "");
  const lastOpen = text.lastIndexOf("[[");
  const head =
    lastOpen >= 0 && !text.slice(lastOpen).includes("]]") ? text.slice(0, lastOpen) : text;
  return stripPanelAction(parseActions(head).clean);
}

/* ------------------------------------------------------------------------- *
 * 流式增量过滤
 * ------------------------------------------------------------------------- */

/** 一段流式正文的**增量**过滤器（由 `createStreamFilter` 产出）。 */
export interface StreamFilter {
  /** 喂一片新到的原文，返回**这次新增**的可上屏文本（可能为空串）。 */
  push(chunk: string): string;
  /** 流结束：吐出还压着的尾巴（仍是半个标记的部分丢弃）。 */
  finish(): string;
}

/** 完整工具块：整段不上屏（与 `visibleStream` 的第一条规则一致）。 */
const TOOL_BLOCK = /<tool\b[^>]*>[\s\S]*?<\/tool>/gi;
/** 未闭合的工具开标记：从它到结尾都不上屏。 */
const TOOL_OPEN = /<tool\b|<\||invoke name=/i;
/** 末尾的半个标记（`<t` / `<` / `invoke name`）：先压住，等下一片。 */
const TOOL_TAIL = /(?:<t(?:o(?:o)?)?|<|invoke name)\s*$/i;
/** 平台动作标记（与 `parseActions` 用同一张白名单表）。 */
const ACTION_MARKER = /\[\[(upload|plan|start|terminal)(?::([^\]\n]*))?\]\]/gi;
/** 面板动作标记（与 `stripPanelAction` 同一条规则）。 */
const PANEL_MARKER = /\[\[panel:[^\]\n]+\]\]/g;

/**
 * 可能长成标记的开头。
 *
 * 它们出现在**末尾**时，后面再来一个字符就可能变成标记 —— 此时提前上屏，等于
 * 吐出一段本来要被吞掉的文字（`invoke nam` 后面来一个 `e` 就会整段消失）。
 * 前缀匹配已经把 `<` / `<t` / `<to` / `<too` / `[` 都覆盖了。
 */
const MARKER_PREFIXES = ["<tool", "<|", "invoke name", "[["];

/** 未决尾巴最多留这么长：再长就按普通文本吐出，防止半个标记把内存拖住。 */
const MAX_PENDING = 512;

/** 强制吐出时留的尾巴：够判断下一个字符是不是标记的一部分。 */
const FORCED_TAIL = 32;

/**
 * 已定稿的一段原文 → 可上屏文本（等价于对整段跑 `visibleStream`，但不做首尾 trim）。
 *
 * `plain` 用于"半个标记超长、按普通文本吐出"的兜底：这时不再把它当标记切掉。
 */
function chunkVisible(text: string, plain = false): string {
  let out = text.replace(TOOL_BLOCK, "");
  const open = TOOL_OPEN.exec(out);
  if (open) out = out.slice(0, open.index);
  out = out.replace(TOOL_TAIL, "");
  if (!plain) {
    const lastOpen = out.lastIndexOf("[[");
    if (lastOpen >= 0 && out.indexOf("]]", lastOpen) < 0) out = out.slice(0, lastOpen);
  }
  // 与 `parseActions` → `stripPanelAction` 的顺序一致：先动作、再折行、最后面板。
  return out
    .replace(ACTION_MARKER, "")
    .replace(/\n{3,}/g, "\n\n")
    .replace(PANEL_MARKER, "");
}

/** 文本末尾那截可能长成标记的起点（没有就是末尾）。 */
function markerSuffixStart(text: string): number {
  const window = Math.min(text.length, 16);
  for (let index = text.length - window; index < text.length; index += 1) {
    const suffix = text.slice(index);
    if (MARKER_PREFIXES.some((marker) => marker.startsWith(suffix))) return index;
  }
  return text.length;
}

/**
 * 跨片折行：`\n{3,}` → `\n\n` 是全段规则，不是单条增量的规则。
 *
 * 一片的结尾与下一片的开头可能各自只有一两个换行，拼起来才是三个以上
 * （工具块被删掉时最容易出现）。所以记住已上屏的末尾连着几个换行，
 * 下一片开头的换行按剩余额度保留。
 */
function clampNewlines(out: string, tail: number): { text: string; tail: number } {
  let lead = 0;
  while (lead < out.length && out[lead] === "\n") lead += 1;
  const keep = Math.max(0, 2 - tail);
  const text = lead > keep ? "\n".repeat(keep) + out.slice(lead) : out;
  let end = 0;
  while (end < text.length && text[text.length - 1 - end] === "\n") end += 1;
  return { text, tail: end };
}

/** 不许把已闭合的 `[[…]]` 或工具块切成两半：退到它的起点。 */
function snapOutside(text: string, cut: number): number {
  if (cut <= 0 || cut >= text.length) return cut;
  let index = text.indexOf("[[");
  while (index >= 0 && index < cut) {
    const close = text.indexOf("]]", index + 2);
    if (close < 0) break;
    if (close + 2 > cut) return index;
    index = text.indexOf("[[", index + 2);
  }
  for (const match of text.matchAll(TOOL_BLOCK)) {
    const start = match.index ?? 0;
    if (start < cut && cut < start + match[0].length) return start;
  }
  return cut;
}

/**
 * `pending` 里可以定稿的长度。
 *
 * 判据只有一条：**后面再来的字符能不能改写这一段**。工具开标记、未闭合的
 * `[[`、末尾半个标记与末尾空白都会改写结尾，所以全都落在切点之后。
 *
 * `relaxed` 只保留"`<tool>` 绝不能漏进气泡"这条硬底线，用来兜住一直不闭合的
 * 半个标记（超长时按普通文本吐出）。
 */
function stableLength(pending: string, relaxed: boolean): number {
  // 已闭合的工具块先占位成等长非空白字符：它不影响切点，但也不能被切开。
  const masked = pending.replace(TOOL_BLOCK, (block) => "\u0000".repeat(block.length));
  let cut = pending.length;
  const open = TOOL_OPEN.exec(masked);
  if (open) cut = open.index;
  if (relaxed) return snapOutside(pending, cut);

  const bracket = masked.lastIndexOf("[[");
  if (bracket >= 0 && masked.indexOf("]]", bracket) < 0) cut = Math.min(cut, bracket);

  /*
   * 定稿段的结尾不能是空白，也不能落在半个标记上（`<t` / `invoke nam`）：
   * 那两样都会被整段结束时的 trim / 标记规则改写，提前吐出就等于多给了字符。
   * 去掉一截可能又暴露出空白，所以循环到不再变化。
   */
  for (;;) {
    let next = cut;
    while (next > 0 && /\s/.test(pending[next - 1])) next -= 1;
    next = Math.min(next, markerSuffixStart(pending.slice(0, next)));
    if (next === cut) break;
    cut = next;
    if (cut === 0) break;
  }
  return snapOutside(pending, cut);
}

/**
 * 流式增量过滤器：**只处理"上次未决的尾巴 + 这次新的一片"**。
 *
 * 为什么需要它：`visibleStream()` 每条增量都对整段累积文本重跑正则 +
 * `parseActions`，n 个 token 就是 O(n²)，而且跑在 UI 线程的事件回调里。
 * 这里把已定稿的前缀直接丢掉（不再保留），未决尾巴最多 `MAX_PENDING` 字符。
 *
 * 正确性由差分测试保证：任意切片喂进来，`push` 输出拼上 `finish()` 必须等于
 * `visibleStream(全文)` —— 终态仍然只信 `visibleStream`。
 */
export function createStreamFilter(): StreamFilter {
  let pending = "";
  let started = false;
  /** 已上屏文本末尾的连续换行数：`\n{3,}` → `\n\n` 必须跨片生效。 */
  let tailNewlines = 0;

  const commit = (length: number, plain = false): string => {
    const stable = pending.slice(0, length);
    pending = pending.slice(length);
    let out = chunkVisible(stable, plain);
    if (!started) {
      out = out.replace(/^\s+/, "");
      if (!out) return "";
      started = true;
    }
    const merged = clampNewlines(out, tailNewlines);
    tailNewlines = merged.tail;
    return merged.text;
  };

  return {
    push(chunk) {
      pending += chunk;
      let length = stableLength(pending, false);
      let plain = false;
      if (pending.length > MAX_PENDING) {
        // 极端情况：半个标记 / 超长空白一直不闭合 —— 按普通文本吐出，防止无限缓存。
        const forced = Math.min(stableLength(pending, true), pending.length - FORCED_TAIL);
        if (forced > length) {
          length = snapOutside(pending, forced);
          plain = true;
        }
      }
      return length > 0 ? commit(length, plain) : "";
    },
    finish() {
      const rest = pending;
      pending = "";
      let out = chunkVisible(rest);
      if (!started) {
        out = out.replace(/^\s+/, "");
        started = true;
      }
      // 与已上屏的末尾一起折行，再收掉末尾空白（整段结束时的 trim）。
      return clampNewlines(out, tailNewlines).text.replace(/\s+$/, "");
    },
  };
}

/** 动作 → 一行回执（写进对话，说明平台究竟做了什么）。 */
export function describeAction(action: ChatAction): string {
  switch (action.kind) {
    case "upload":
      return "上传附件到服务器临时目录";
    case "plan":
      return action.service ? `生成更新计划：${action.service}` : "生成部署计划";
    case "start":
      return "执行计划";
    case "terminal":
      return `在右侧真实终端执行：${action.command}`;
  }
}
