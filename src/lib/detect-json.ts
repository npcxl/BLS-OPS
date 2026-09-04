/**
 * 严格 JSON / JSON Lines 检测 —— 终端 JSON Tab 与 JSON 查看器的唯一入口。
 *
 * 数据完整原则（用户裁决）：
 * - 整段 trim 后整体 `JSON.parse` 成功 → `json`；
 * - 否则按非空行逐行解析，**任意一行失败即整体失败**，绝不丢弃坏行之后
 *   “部分解析成功”；
 * - 失败一律返回 `null`，调用方（终端 JSON Tab）直接不出现；
 * - 终端输出本身永远是完整保留的，检测只决定“多不多一个 JSON Tab”。
 */

export type DetectedJson =
  | { kind: "json"; value: unknown }
  | { kind: "jsonl"; value: unknown[] };

/** 超过该长度不做解析（与终端捕获上限同量级，避免解析超大文本卡 UI）。 */
export const MAX_JSON_DETECT_CHARS = 1_000_000;

export function detectJson(text: string): DetectedJson | null {
  const trimmed = text.trim();
  if (!trimmed || trimmed.length > MAX_JSON_DETECT_CHARS) {
    return null;
  }

  try {
    return { kind: "json", value: JSON.parse(trimmed) };
  } catch {
    // 不是整段 JSON，继续尝试 JSON Lines
  }

  const lines = trimmed
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  if (lines.length < 2) {
    return null;
  }

  const value: unknown[] = [];
  for (const line of lines) {
    try {
      value.push(JSON.parse(line));
    } catch {
      // 有一行不是合法 JSON → 整体不识别。禁止“跳过坏行保留好行”。
      return null;
    }
  }
  return { kind: "jsonl", value };
}

/**
 * 终端专用：快照文本的第一行通常是 `prompt + 命令回显`（快照从提交时
 * 的光标行开始取），先剥离该行再做严格检测。
 *
 * 剥离**只影响“JSON Tab 是否出现”**，绝不改动终端输出本身的任何字节。
 * 降级（degraded）路径已经清洗过回显，此处自然不命中，可安全复用。
 */
export function detectJsonOutput(text: string, command?: string): DetectedJson | null {
  if (!text) return null;
  if (!command || command.trim() === "") return detectJson(text);

  const trimmedCommand = command.trim();
  const newlineIndex = text.indexOf("\n");
  const firstLine = newlineIndex === -1 ? text : text.slice(0, newlineIndex);
  if (firstLine.trimEnd().endsWith(trimmedCommand)) {
    const rest = newlineIndex === -1 ? "" : text.slice(newlineIndex + 1);
    return detectJson(rest);
  }
  return detectJson(text);
}
