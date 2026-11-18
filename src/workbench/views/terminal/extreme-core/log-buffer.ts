/**
 * 日志缓冲的纯逻辑：追加、截断、过滤。
 *
 * 抽出来是为了能直接测"跨块拆行 / 上限丢弃 / 过滤"，不必把 SSH 与 DOM 拖进来。
 */

/** 单条流最多保留多少行（再多的部分丢弃并计数，界面要能说明）。 */
export const LOG_LINE_CAP = 5000;

export interface LogBuffer {
  lines: string[];
  /** 因为超过上限被丢掉的行数。 */
  dropped: number;
  /** 最后一段没有换行的半行（下次追加时接上）。 */
  partial: string;
}

export function emptyBuffer(): LogBuffer {
  return { lines: [], dropped: 0, partial: "" };
}

/**
 * 追加一段原始输出。
 *
 * SSH 的块边界与行边界无关：一个汉字、甚至一行都可能被劈成两半。这里保留
 * `partial`，下一次追加再接上，避免出现半行或乱码。
 */
export function appendChunk(buffer: LogBuffer, chunk: string, cap = LOG_LINE_CAP): LogBuffer {
  if (!chunk) return buffer;
  const text = buffer.partial + chunk;
  const pieces = text.split("\n");
  // 最后一段可能是半行。
  const partial = pieces.pop() ?? "";
  let lines = pieces.length > 0 ? [...buffer.lines, ...pieces] : buffer.lines;
  let dropped = buffer.dropped;
  if (lines.length > cap) {
    dropped += lines.length - cap;
    lines = lines.slice(lines.length - cap);
  }
  return { lines, dropped, partial };
}

/** 正在跟随时的最大行数（面板只渲染尾部，避免切回时卡住）。 */
export function visibleLines(lines: string[], limit = 2000): string[] {
  return lines.length <= limit ? lines : lines.slice(lines.length - limit);
}

/** 过滤：大小写不敏感，空查询返回全部。 */
export function filterLines(lines: string[], query: string): string[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return lines;
  return lines.filter((line) => line.toLowerCase().includes(needle));
}
