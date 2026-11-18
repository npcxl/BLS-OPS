/**
 * 流式 Markdown 的**切分**：已定稿的块 + 正在长的那一段。
 *
 * 为什么需要它：流式回答如果每来一个字就把整篇重新解析一遍，20 KB 的回复
 * 等于每秒做几十次全文解析（外加一遍 DOMPurify），主线程直接被占满。切在大
 * 块边界上之后，前面那一整块只在**越过边界时**才重解析一次，逐字变化的只剩
 * 末尾那一段纯文本。
 *
 * 切点只有两种：空行（段落 / 列表 / 标题块的边界）与**已闭合**的代码围栏。
 * 越过未闭合的围栏一定不行 —— 那会把半个代码块交给 Markdown，渲染出满屏
 * 乱七八糟的高亮。
 */

interface Fence {
  /** 起始行第一个字符的位置。 */
  start: number;
  /** 结束位置（闭合围栏 = 闭合行末尾；未闭合 = 全文末尾）。 */
  end: number;
  closed: boolean;
}

/** 逐行扫代码围栏（``` / ~~~），给出每段的字符区间。 */
function scanFences(text: string): Fence[] {
  const fences: Fence[] = [];
  // 绝大多数回复没有代码块：省掉每帧一次整篇逐行扫描。
  if (!text.includes("```") && !text.includes("~~~")) return fences;
  const line = /^[ \t]{0,3}(`{3,}|~{3,})([^\n]*)$/gm;
  let open: { start: number; marker: string } | null = null;
  for (const match of text.matchAll(line)) {
    const marker = match[1];
    const rest = match[2] ?? "";
    const start = match.index ?? 0;
    if (!open) {
      open = { start, marker };
      continue;
    }
    // 闭合行只有标记本身（语言名是开围栏的事）：```js 在围栏里算正文。
    const closes = marker[0] === open.marker[0] && marker.length >= open.marker.length && rest.trim() === "";
    if (!closes) continue;
    fences.push({ start: open.start, end: start + match[0].length, closed: true });
    open = null;
  }
  if (open) fences.push({ start: open.start, end: text.length, closed: false });
  return fences;
}

/** 可以定稿的长度（0 = 一个完整的块都还没有）。 */
function stableCut(text: string): number {
  const fences = scanFences(text);
  const unclosed = fences.find((fence) => !fence.closed);
  // 未闭合的围栏整段留在 tail：只有围栏**之前**的正文才算定稿。
  const limit = unclosed ? unclosed.start : text.length;

  let cut = 0;
  for (const fence of fences) {
    if (fence.closed && fence.end <= limit) cut = Math.max(cut, fence.end);
  }

  // 空行是段落块边界；落在已闭合围栏里的空行不算（会把代码块切成两半）。
  const head = text.slice(0, limit);
  let boundary = head.lastIndexOf("\n\n");
  while (
    boundary > 0 &&
    fences.some((fence) => fence.closed && fence.start < boundary && boundary < fence.end)
  ) {
    boundary = head.lastIndexOf("\n\n", boundary - 1);
  }
  if (boundary > 0) cut = Math.max(cut, boundary + 2);
  return Math.min(cut, limit);
}

/**
 * 切成 `stable`（可交给 Markdown 定稿渲染）与 `tail`（还在长，按纯文本显示）。
 *
 * 恒等式：`stable + tail === text`。一个完整的块都没有时 `stable` 为空串。
 */
export function splitStreamingMarkdown(text: string): { stable: string; tail: string } {
  const cut = stableCut(text);
  if (cut <= 0) return { stable: "", tail: text };
  const stable = text.slice(0, cut);
  // 只有空白（例如开头就连着两个空行）不算定稿块：整段继续按纯文本长。
  if (stable.trim() === "") return { stable: "", tail: text };
  return { stable, tail: text.slice(cut) };
}
