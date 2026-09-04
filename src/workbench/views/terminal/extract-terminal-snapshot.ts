/**
 * 终端快照提取 —— 从**已渲染**的 xterm Buffer 里还原"用户看到的那块输出"。
 *
 * 为什么不用原始字节流：PTY 会把超长行按终端宽度**软换行**（如超长镜像名
 * `docker.m.daocloud.io/library/nginx:1.27-alpine…`），字节流里只有"已经
 * 换行后的字符"，无法区分这是真实换行还是终端宽度造成的折行。而 xterm
 * Buffer 的每一行保存了 `isWrapped`（该行是否是上一物理行的延续），因此：
 *
 * ```text
 * SSH 原始流 → xterm 完整解析 → translateToString(true) 取行
 *             → 按 line.isWrapped 合并软换行 → renderedText（逻辑行）
 * ```
 *
 * 提取出的文本以 `<pre>`、等宽字体、`w-max whitespace-pre` + 横向滚动展示，
 * 不再二次折行 —— 每条逻辑记录一行，长行可横向看全。
 *
 * 本模块是纯函数，通过极小的结构类型工作，方便单测与替换 buffer 实现。
 */

/** 一条 xterm Buffer 行所需的最小形状（`IBufferLine` 的结构超集）。 */
export interface SnapshotBufferLine {
  /**
   * 提取该行的可见文本。`trimRight = true` 去掉行尾空白 —— xterm 把未写入
   * 的单元格视为空格，不清掉会让每条记录拖着一整行宽度。
   */
  translateToString(trimRight?: boolean): string;
  /** 该行是否是**上一物理行**的软换行延续（终端宽度折行的第二段及以上）。 */
  isWrapped: boolean;
}

/** 一块 xterm 缓冲（normal buffer 的 `IBuffer`）的最小形状。 */
export interface SnapshotBuffer {
  /** 缓冲里的物理行总数（含回滚区）。 */
  length: number;
  getLine(index: number): SnapshotBufferLine | null;
}

export interface ExtractOptions {
  buffer: SnapshotBuffer;
  /** 起始物理行（含）。通常是注册的 xterm Marker 所在行。 */
  startLine: number;
  /** 结束物理行（不含）；缺省 = buffer 末尾。 */
  endLine?: number;
}

/**
 * 把 `[startLine, endLine)` 的物理行还原成逻辑行文本。
 *
 * - 每行先 `translateToString(true)`（去行尾空白）；
 * - `isWrapped === true` 的行与前一行**无缝合并**（不插入换行）；
 * - 区域两端的空白逻辑行被裁掉，区域**内部**的空行保留（那是输出本身）。
 *
 * `startLine` 越界 / 区域为空时返回空串。返回 null 由调用方决定（无需区分
 * 空输出与不可用 —— 空输出本来就是合法结果，见空输出有效不回落）。
 */
export function extractTerminalSnapshot({
  buffer,
  startLine,
  endLine,
}: ExtractOptions): string {
  const from = Math.max(0, startLine);
  const to = Math.min(endLine ?? buffer.length, buffer.length);
  if (from >= to || from >= buffer.length) return "";

  const logical: string[] = [];
  for (let index = from; index < to; index += 1) {
    const line = buffer.getLine(index);
    if (!line) break;
    const text = line.translateToString(true);
    if (index > from && line.isWrapped && logical.length > 0) {
      // 上一物理行的延续：拼到当前逻辑行末尾（不换行）。
      logical[logical.length - 1] += text;
    } else {
      logical.push(text);
    }
  }

  return trimBlankEdges(logical);
}

/** 裁掉逻辑行序列两端的空白行（内部的空白行是输出的一部分，保留）。 */
function trimBlankEdges(lines: string[]): string {
  let start = 0;
  let end = lines.length;
  while (start < end && lines[start].trim() === "") start += 1;
  while (end > start && lines[end - 1].trim() === "") end -= 1;
  return lines.slice(start, end).join("\n");
}
