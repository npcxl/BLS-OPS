import { describe, expect, it } from "vitest";
import {
  beginBlock,
  blockAtLine,
  blockRectPx,
  bufferLineAtY,
  disposeBlocks,
  finishBlock,
  isFailedBlock,
  MAX_COMMAND_BLOCKS,
  type BlockGeometry,
  type BlockMarker,
  type CommandBlock,
} from "../terminal-command-blocks";

/** 测试用 marker：可变行号（模拟 xterm trim 调整），记录 dispose 次数。 */
function fakeMarker(line: number): BlockMarker & { disposed: () => number } {
  const state = { line, count: 0 };
  return {
    get line() {
      return state.line;
    },
    dispose() {
      state.count += 1;
    },
    disposed: () => state.count,
  };
}

function begin(blocks: CommandBlock[], id: string, startLine: number): CommandBlock {
  const { blocks: next } = beginBlock(blocks, id, `cmd-${id}`, fakeMarker(startLine));
  return next[next.length - 1];
}

/** 20 行 × 20px 的可视区：行区 8..408（相对容器）。 */
const GEOMETRY: BlockGeometry = {
  viewportY: 100,
  cellHeightPx: 20,
  rowsTopPx: 8,
  viewportHeightPx: 400,
};

describe("beginBlock", () => {
  it("追加新块并把遗留的未完成块作废", () => {
    const first = begin([], "a", 10);
    expect(first.finished).toBe(false);

    const { blocks } = beginBlock([first], "b", "cmd-b", fakeMarker(20));
    expect(blocks).toHaveLength(2);
    expect(blocks[0].finished).toBe(true); // a 被新命令作废
    expect(blocks[1].id).toBe("b");
    expect(blocks[1].finished).toBe(false);
  });

  it("超过上限时挤掉最老的块", () => {
    let blocks: CommandBlock[] = [];
    for (let index = 0; index < MAX_COMMAND_BLOCKS + 3; index += 1) {
      blocks = beginBlock(blocks, `b${index}`, `cmd-b${index}`, fakeMarker(index)).blocks;
    }
    expect(blocks).toHaveLength(MAX_COMMAND_BLOCKS);
    expect(blocks[0].id).toBe("b3"); // 最老的三块被挤掉
    expect(blocks[blocks.length - 1].id).toBe(`b${MAX_COMMAND_BLOCKS + 2}`);
  });

  it("返回被挤出的块供调用方 dispose（marker 各释放一次）", () => {
    const markerA = fakeMarker(1);
    const { blocks: one } = beginBlock([], "a", "cmd-a", markerA);
    const { blocks: two } = beginBlock(one, "b", "cmd-b", fakeMarker(2));
    const { blocks: next, evicted } = beginBlock(two, "c", "cmd-c", fakeMarker(3), 2);
    expect(next.map((block) => block.id)).toEqual(["b", "c"]);
    expect(evicted.map((block) => block.id)).toEqual(["a"]);
    disposeBlocks(evicted);
    expect(markerA.disposed()).toBe(1);
  });
});

describe("finishBlock", () => {
  it("封口最后一个未完成块（退出码 + 终点 + 文本）", () => {
    const a = begin([], "a", 10);
    const { blocks: both } = beginBlock([a], "b", "cmd-b", fakeMarker(20));
    const end = fakeMarker(25);
    const { blocks } = finishBlock(both, 1, end, "out");
    expect(blocks[0].finished).toBe(true); // a 保持作废态
    expect(blocks[1].endMarker).toBe(end);
    expect(blocks[1].exitCode).toBe(1);
    expect(blocks[1].renderedText).toBe("out");
    expect(blocks[1].finished).toBe(true);
  });

  it("没有未完成块时原样返回", () => {
    const done = begin([], "a", 10);
    const { blocks, evicted } = finishBlock([{ ...done, finished: true }], 0, fakeMarker(12), "x");
    expect(blocks).toHaveLength(1);
    expect(evicted).toHaveLength(0);
  });
});

describe("blockAtLine", () => {
  function finishedBlock(id: string, start: number, end: number): CommandBlock {
    return {
      id,
      command: id,
      startMarker: fakeMarker(start),
      endMarker: end === start ? null : fakeMarker(end),
      exitCode: 0,
      renderedText: "out",
      finished: true,
    };
  }

  it("命中 [start, end] 闭区间", () => {
    const block = finishedBlock("a", 10, 20);
    expect(blockAtLine([block], 10)?.id).toBe("a");
    expect(blockAtLine([block], 20)?.id).toBe("a");
    expect(blockAtLine([block], 15)?.id).toBe("a");
    expect(blockAtLine([block], 9)).toBeNull();
    expect(blockAtLine([block], 21)).toBeNull();
  });

  it("重叠时最新的块优先；起点被淘汰（-1）的块跳过", () => {
    const old = finishedBlock("old", 5, 30);
    const newer = finishedBlock("new", 25, 40);
    expect(blockAtLine([old, newer], 27)?.id).toBe("new");
    expect(blockAtLine([old, newer], 12)?.id).toBe("old");

    const evicted = finishedBlock("gone", -1, -1);
    expect(blockAtLine([evicted, newer], 27)?.id).toBe("new");
    expect(blockAtLine([evicted], 0)).toBeNull();
  });

  it("endMarker 为 null 时退化为单行命中", () => {
    const block = finishedBlock("a", 10, 10);
    expect(blockAtLine([block], 10)?.id).toBe("a");
    expect(blockAtLine([block], 11)).toBeNull();
  });
});

describe("bufferLineAtY", () => {
  it("像素 → 视口绝对行", () => {
    // rowsTopPx=8, cell=20：localY=8..27 是视口第 0 行 → 绝对 100。
    expect(bufferLineAtY(8, GEOMETRY)).toBe(100);
    expect(bufferLineAtY(27, GEOMETRY)).toBe(100);
    expect(bufferLineAtY(48, GEOMETRY)).toBe(102);
  });

  it("行区以上（容器 padding）与非法几何返回 null", () => {
    expect(bufferLineAtY(7, GEOMETRY)).toBeNull();
    expect(bufferLineAtY(10, { ...GEOMETRY, cellHeightPx: 0 })).toBeNull();
  });

  it("行区以下（容器底部 padding / 抽屉区）不参与命中", () => {
    // 行区底 = 8 + 400 = 408。
    expect(bufferLineAtY(407, GEOMETRY)).toBe(119);
    expect(bufferLineAtY(408, GEOMETRY)).toBeNull();
  });
});

describe("blockRectPx", () => {
  it("换算为相对容器的高亮矩形", () => {
    const rect = blockRectPx(
      { id: "a", command: "a", startMarker: fakeMarker(102), endMarker: fakeMarker(104), exitCode: 0, renderedText: null, finished: true },
      GEOMETRY,
    );
    // 视口顶=100：102 行 → top = 8 + 2*20 = 48；高度 = (104-102+1)*20 = 60。
    expect(rect).toEqual({ top: 48, height: 60 });
  });

  it("任一端被淘汰返回 null（绝不高亮错位置）", () => {
    const startGone = { id: "a", command: "a", startMarker: fakeMarker(-1), endMarker: fakeMarker(10), exitCode: 0, renderedText: null, finished: true };
    const endGone = { id: "b", command: "b", startMarker: fakeMarker(10), endMarker: fakeMarker(-1), exitCode: 0, renderedText: null, finished: true };
    expect(blockRectPx(startGone, GEOMETRY)).toBeNull();
    expect(blockRectPx(endGone, GEOMETRY)).toBeNull();
  });

  it("endMarker 为 null 时按单行计算", () => {
    const rect = blockRectPx(
      { id: "a", command: "a", startMarker: fakeMarker(102), endMarker: null, exitCode: 0, renderedText: null, finished: true },
      GEOMETRY,
    );
    expect(rect).toEqual({ top: 48, height: 20 });
  });

  describe("超出可视区自动裁剪（背景色不溢出）", () => {
    function block(start: number, end: number): CommandBlock {
      return {
        id: "a",
        command: "a",
        startMarker: fakeMarker(start),
        endMarker: end === start ? null : fakeMarker(end),
        exitCode: 0,
        renderedText: null,
        finished: true,
      };
    }

    it("块上半部分滚出视口上方 → 只画可视部分", () => {
      // 视口顶=100。块 95..120：95 行在视口上方，裁到行区顶 8。
      expect(blockRectPx(block(95, 120), GEOMETRY)).toEqual({ top: 8, height: 400 });
    });

    it("块下半部分超出视口下方 → 裁到行区底", () => {
      // 视口有 20 行（100..119）。块 115..200 → 可见 115..119。
      const rect = blockRectPx(block(115, 200), GEOMETRY);
      expect(rect).toEqual({ top: 8 + 15 * 20, height: 5 * 20 });
      expect(rect!.top + rect!.height).toBe(408); // 正好贴行区底
    });

    it("整块都滚出视口上方 → 不高亮（返回 null）", () => {
      expect(blockRectPx(block(50, 80), GEOMETRY)).toBeNull();
    });

    it("整块都在视口下方（还没滚到）→ 不高亮（返回 null）", () => {
      expect(blockRectPx(block(200, 210), GEOMETRY)).toBeNull();
    });

    it("块顶正好贴视口底边之外一格 → null（零高度不算可见）", () => {
      // 视口行 100..119，120 行正好是视口下方第一行。
      expect(blockRectPx(block(120, 130), GEOMETRY)).toBeNull();
    });

    it("完全在视口内的块不受裁剪影响", () => {
      expect(blockRectPx(block(105, 110), GEOMETRY)).toEqual({ top: 108, height: 120 });
    });

    it("viewportHeightPx 缺失/非法 → 退化为不裁剪（高亮绝不能整个消失）", () => {
      // 热更新版本错配时就会走到这条路径：宁可多画也不能没有高亮。
      const noHeight: BlockGeometry = { viewportY: 100, cellHeightPx: 20, rowsTopPx: 8 };
      expect(blockRectPx(block(105, 110), noHeight)).toEqual({ top: 108, height: 120 });
      expect(blockRectPx(block(115, 200), noHeight)).toEqual({ top: 308, height: 1720 });
      expect(blockRectPx(block(105, 110), { ...GEOMETRY, viewportHeightPx: 0 })).toEqual({
        top: 108,
        height: 120,
      });
      expect(bufferLineAtY(500, noHeight)).toBe(124);
    });
  });
});

describe("isFailedBlock", () => {
  it("非零退出码为失败；未知（null）不算失败", () => {
    const base = { id: "a", command: "a", startMarker: fakeMarker(1), endMarker: null, renderedText: null, finished: true };
    expect(isFailedBlock({ ...base, exitCode: 1 })).toBe(true);
    expect(isFailedBlock({ ...base, exitCode: 0 })).toBe(false);
    expect(isFailedBlock({ ...base, exitCode: null })).toBe(false);
  });
});
