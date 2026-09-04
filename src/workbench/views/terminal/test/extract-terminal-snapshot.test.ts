import { describe, expect, it } from "vitest";
import {
  extractTerminalSnapshot,
  type SnapshotBuffer,
  type SnapshotBufferLine,
} from "./extract-terminal-snapshot";

function line(text: string, isWrapped = false): SnapshotBufferLine {
  // 模拟 xterm：translateToString(true) 会裁掉行尾空白（未写入的单元格）。
  return {
    isWrapped,
    translateToString: (trimRight = false) =>
      trimRight ? text.replace(/\s+$/, "") : text,
  };
}

function buffer(lines: SnapshotBufferLine[]): SnapshotBuffer {
  return {
    length: lines.length,
    getLine: (index) => lines[index] ?? null,
  };
}

describe("extractTerminalSnapshot", () => {
  it("普通多行输出按行还原，行尾空白被裁掉", () => {
    const text = extractTerminalSnapshot({
      buffer: buffer([
        line("Filesystem  Size"),
        line(""),
        line("/dev/sda1  50G  "),
      ]),
      startLine: 0,
    });
    expect(text).toBe("Filesystem  Size\n\n/dev/sda1  50G");
  });

  it("软换行（isWrapped）合并成一条逻辑行 —— 超长镜像名不再断行", () => {
    const text = extractTerminalSnapshot({
      // docker ps 里一行超宽被 PTY 折成两段（第二段 isWrapped=true）。
      buffer: buffer([
        line("docker.m.daocloud.io/library/nginx:1.27-alpine"),
        line("65645c7bb6a0   nginx:1.27-alpine", true),
        line("0.0.0.0:80->80/tcp   nginx"),
      ]),
      startLine: 0,
    });
    expect(text).toBe(
      "docker.m.daocloud.io/library/nginx:1.27-alpine65645c7bb6a0   nginx:1.27-alpine\n" +
        "0.0.0.0:80->80/tcp   nginx",
    );
  });

  it("多段软换行连续合并；真实换行仍保留", () => {
    const text = extractTerminalSnapshot({
      buffer: buffer([
        line("first-part"),
        line("second-part", true),
        line("third-part", true),
        line("next real line"),
      ]),
      startLine: 0,
    });
    expect(text).toBe("first-partsecond-partthird-part\nnext real line");
  });

  it("区域内部的空行保留，两端的空白行被裁掉", () => {
    const text = extractTerminalSnapshot({
      buffer: buffer([
        line("  "), // 上边缘（可能是 marker 的余行）
        line("a"),
        line(""),
        line("b"),
        line("   "), // 下边缘（D 标记产生的空行）
      ]),
      startLine: 0,
    });
    expect(text).toBe("a\n\nb");
  });

  it("只提取 [startLine, endLine) 区域", () => {
    const text = extractTerminalSnapshot({
      buffer: buffer([line("skip"), line("keep1"), line("keep2"), line("skip2")]),
      startLine: 1,
      endLine: 3,
    });
    expect(text).toBe("keep1\nkeep2");
  });

  it("区域起点落在软换行的中间段也能安全拼接（不丢已给的内容）", () => {
    const text = extractTerminalSnapshot({
      buffer: buffer([line("head", false), line("tail-cont", true)]),
      startLine: 1,
    });
    expect(text).toBe("tail-cont");
  });

  it("越界 / 空区域返回空串", () => {
    const empty: SnapshotBufferLine[] = [];
    expect(
      extractTerminalSnapshot({ buffer: buffer(empty), startLine: 0 }),
    ).toBe("");
    expect(
      extractTerminalSnapshot({
        buffer: buffer([line("x")]),
        startLine: 5,
      }),
    ).toBe("");
    expect(
      extractTerminalSnapshot({
        buffer: buffer([line("x"), line("y")]),
        startLine: 2,
        endLine: 4,
      }),
    ).toBe("");
  });

  it("全是空白行 → 空串（不是一坨空格）", () => {
    expect(
      extractTerminalSnapshot({
        buffer: buffer([line("  "), line("\t"), line("")]),
        startLine: 0,
      }),
    ).toBe("");
  });
});
