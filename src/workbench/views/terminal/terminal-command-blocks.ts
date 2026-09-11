/**
 * 终端命令块 —— 把"一次提交"在终端里留下的痕迹（命令回显行 + 输出区）标成
 * 一个可交互的整体：悬浮高亮、一键复制命令 / 复制输出，报错块同样可用。
 *
 * # 数据从哪来（全部是受控边界，不是猜的）
 *
 * - 起点：命令提交时（`use-terminal-results.execute`）在当前光标行注册的
 *   xterm `IMarker` —— 与快照起点同一个行；
 * - 终点：结果产出时（`onResult`，OSC 133 D 已写完输出、提示符尚未回写）
 *   再注册一个 marker；
 * - 文本与退出码：`CapturedResult`（`renderedText` / `boundary.exitCode`）。
 *
 * # 为什么存 marker 而不是行号数值
 *
 * xterm 回滚缓冲有上限：旧行被 trim 后，**所有**保留行的绝对行号整体前移。
 * 数值快照会静默指向错误的行；marker 由 xterm 内部跟随 trim 调整，行被
 * 淘汰后 `line` 变为 -1（块随之隐藏，绝不高亮错位置）。
 *
 * 本模块是纯函数（marker 用最小结构类型），方便单测；dispose 等 DOM 副作用
 * 留给调用方（`use-terminal-results`）。
 */

/** 一枚 xterm marker 的最小形状（`IMarker` 的结构子集）。 */
export interface BlockMarker {
  /** Buffer 绝对行号；该行滚出回滚缓冲被淘汰后为 -1。 */
  readonly line: number;
  dispose(): void;
}

export interface CommandBlock {
  /** 仅作 React key 用。 */
  id: string;
  /** 用户实际执行的命令原文（展示与复制命令用）。 */
  command: string;
  /** 命令回显所在行。 */
  startMarker: BlockMarker;
  /** 输出结束行；`null` = 未能注册（快照降级路径），命中退化为单行。 */
  endMarker: BlockMarker | null;
  /** 真实退出码；`null` = 未知（被新命令作废 / 标记缺失）。 */
  exitCode: number | null;
  /** 已渲染输出文本（与结果抽屉一致）；`null` = 无可用快照。 */
  renderedText: string | null;
  /** `false` = 进行中（输出还没结束）；被新命令作废时置 true。 */
  finished: boolean;
}

/** 块数量上限（每块两枚 marker，防长会话无限增长）。 */
export const MAX_COMMAND_BLOCKS = 200;

/** begin/finish 的统一返回：新列表 + 被挤出的块（调用方负责 dispose）。 */
export interface BlocksMutation {
  blocks: CommandBlock[];
  evicted: CommandBlock[];
}

function disposeMark(block: CommandBlock): void {
  block.startMarker.dispose();
  block.endMarker?.dispose();
}

/** 由调用方（在 setState 之外）调用：释放被移除块的 marker。 */
export function disposeBlocks(blocks: CommandBlock[]): void {
  for (const block of blocks) disposeMark(block);
}

/**
 * 提交一条命令：作废遗留的未完成块（新命令提交会让上一条的输出永远
 * 对不上号 —— 与 `TerminalCommandCoordinator.cancel` 同一语义），再追加
 * 新块。超过上限时挤掉最老的块。
 */
export function beginBlock(
  blocks: CommandBlock[],
  id: string,
  command: string,
  startMarker: BlockMarker,
  max: number = MAX_COMMAND_BLOCKS,
): BlocksMutation {
  const closed = blocks.map((block) => (block.finished ? block : { ...block, finished: true }));
  const next = [...closed, { id, command, startMarker, endMarker: null, exitCode: null, renderedText: null, finished: false }];
  // 超限时挤出**最老**的块。不能用 `slice(length - max)`：长度小于 max 时
  // 它是负索引（从尾部取），会把没超限的列表也截短。
  const overflow = next.length - max;
  if (overflow <= 0) return { blocks: next, evicted: [] };
  return { blocks: next.slice(overflow), evicted: next.slice(0, overflow) };
}

/**
 * 输出结束：封口**最后一个**未完成块（协调器同一时刻只跟踪一条命令，
 * 块队列顺序与结果顺序一致）。没有未完成块时原样返回。
 */
export function finishBlock(
  blocks: CommandBlock[],
  exitCode: number | null,
  endMarker: BlockMarker | null,
  renderedText: string | null,
): BlocksMutation {
  for (let index = blocks.length - 1; index >= 0; index -= 1) {
    const block = blocks[index];
    if (block.finished) continue;
    const next = blocks.slice();
    next[index] = { ...block, endMarker, exitCode, renderedText, finished: true };
    return { blocks: next, evicted: [] };
  }
  return { blocks, evicted: [] };
}

/** buffer 绝对行 → 命中的块（重叠时**最新**的优先）。已淘汰（line<0）不命中。 */
export function blockAtLine(blocks: CommandBlock[], line: number): CommandBlock | null {
  for (let index = blocks.length - 1; index >= 0; index -= 1) {
    const block = blocks[index];
    const start = block.startMarker.line;
    if (start < 0) continue;
    const end = Math.max(start, block.endMarker?.line ?? start);
    if (line >= start && line <= end) return block;
  }
  return null;
}

/** 命中检测的几何参数（由 overlay 组件测量后传入纯函数）。 */
export interface BlockGeometry {
  /** 视口顶部对应的 buffer 绝对行（`buffer.active.viewportY`）。 */
  viewportY: number;
  /** 一行物理行高（px）。 */
  cellHeightPx: number;
  /** 行区相对定位容器的纵向偏移（px；容器 padding 就在这里体现）。 */
  rowsTopPx: number;
  /**
   * 行区高度（px）= 视口可见高度；高亮超出这个范围的部分要裁掉。
   *
   * **可选**：拿不到就按"不裁剪"处理（宁可多画，也不能让高亮整个消失）。
   */
  viewportHeightPx?: number;
}

/** 行区底边（px）；`viewportHeightPx` 缺失/非法时为正无穷 = 不裁剪。 */
function viewBottomPx(geometry: BlockGeometry): number {
  const height = geometry.viewportHeightPx;
  return height !== undefined && height > 0 ? geometry.rowsTopPx + height : Number.POSITIVE_INFINITY;
}

/** 屏幕坐标（相对定位容器的 px）→ buffer 绝对行；不在行区内返回 null。 */
export function bufferLineAtY(localY: number, geometry: BlockGeometry): number | null {
  const { viewportY, cellHeightPx, rowsTopPx } = geometry;
  if (!(cellHeightPx > 0) || localY < rowsTopPx) return null;
  // 行区以下（容器底部 padding / 抽屉区）不属于终端行，不参与命中。
  if (localY >= viewBottomPx(geometry)) return null;
  return viewportY + Math.floor((localY - rowsTopPx) / cellHeightPx);
}

/**
 * 块在视口里的高亮矩形（相对定位容器的 px），**已按可视区裁剪**：
 * 块滚出视口上/下的部分不画（背景色绝不会溢出终端行区）。
 *
 * 返回 `null` 的情况：任一端被淘汰（line<0），或整块都在可视区之外
 * （已完全滚出屏幕 —— 用户要的"超出自动隐藏"）。
 */
export function blockRectPx(
  block: CommandBlock,
  geometry: BlockGeometry,
): { top: number; height: number } | null {
  const start = block.startMarker.line;
  if (start < 0) return null;
  const end = block.endMarker === null ? start : block.endMarker.line;
  if (end < 0) return null;
  const first = Math.min(start, end);
  const last = Math.max(start, end);
  const rawTop = geometry.rowsTopPx + (first - geometry.viewportY) * geometry.cellHeightPx;
  const rawBottom = geometry.rowsTopPx + (last + 1 - geometry.viewportY) * geometry.cellHeightPx;

  const viewTop = geometry.rowsTopPx;
  const viewBottom = viewBottomPx(geometry);
  const top = Math.max(rawTop, viewTop);
  const bottom = Math.min(rawBottom, viewBottom);
  // 只在确实无交集时才放弃高亮（整块滚出可视区）。
  if (!(bottom > top)) return null;
  return { top, height: bottom - top };
}

/** 报错块（退出码非 0 且已知）。 */
export function isFailedBlock(block: CommandBlock): boolean {
  return block.exitCode !== null && block.exitCode !== 0;
}
