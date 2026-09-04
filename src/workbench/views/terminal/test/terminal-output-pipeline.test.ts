import { describe, expect, it } from "vitest";
import { splitAtOutputEnd, writeOutputParts, type OutputWriteDeps } from "../terminal-output-pipeline";
import type { BoundaryPart } from "../command-boundary";

/**
 * 假的 xterm：write 是**异步**的（对应 `instance.write(data, callback)` 的
 * callback 在下一轮微任务/定时器才触发），buffer 就是终端里已渲染的内容。
 */
function fakeTerminal() {
  const rendered: string[] = [];
  let queue: Promise<void> = Promise.resolve();
  const write = (text: string): Promise<void> => {
    if (!text) return queue;
    const done = new Promise<void>((resolve) => {
      // 模拟 xterm 异步解析渲染：callback 晚于 write 调用。
      setTimeout(() => {
        rendered.push(text);
        resolve();
      }, 0);
    });
    queue = queue.catch(() => undefined).then(() => done);
    return done;
  };
  return { rendered, write, flush: () => queue.catch(() => undefined) };
}

function harness(terminal: ReturnType<typeof fakeTerminal>) {
  const snapshots: string[] = [];
  const deps: OutputWriteDeps = {
    write: terminal.write,
    flush: terminal.flush,
    capture: () => snapshots.push(terminal.rendered.join("")),
  };
  return { deps, snapshots };
}

const text = (value: string): BoundaryPart => ({ kind: "text", text: value });
const end = (exitCode: number | null = 0): BoundaryPart => ({
  kind: "event",
  event: { type: "output_end", exitCode },
});

describe("splitAtOutputEnd", () => {
  it("按 output_end 切成前后两段", () => {
    expect(splitAtOutputEnd([text("a"), end(), text("b")])).toEqual({
      before: "a",
      after: "b",
      sawEnd: true,
    });
  });

  it("没有结束标记时全部算 before", () => {
    expect(splitAtOutputEnd([text("a"), text("b")])).toEqual({
      before: "ab",
      after: "",
      sawEnd: false,
    });
  });
});

describe("writeOutputParts —— 快照时机（真实写出顺序）", () => {
  it("D 之后的提示符**不进快照**：先写 before → 渲染完 → 抓快照 → 才写 after", async () => {
    const terminal = fakeTerminal();
    const { deps, snapshots } = harness(terminal);
    await writeOutputParts([text("Filesystem  Size\n"), end(0), text("user@host:~$ ")], deps);

    expect(snapshots).toHaveLength(1);
    // 快照停在输出结束处，跟在 D 后面的提示符还没写进终端。
    expect(snapshots[0]).toBe("Filesystem  Size\n");
    // 但终端里最终什么都有（原始体验不受影响）。
    expect(terminal.rendered.join("")).toBe("Filesystem  Size\nuser@host:~$ ");
  });

  it("没有结束标记 → 只写文本、不抓快照（命令还在输出）", async () => {
    const terminal = fakeTerminal();
    const { deps, snapshots } = harness(terminal);
    await writeOutputParts([text("downloading 10%\n")], deps);
    expect(snapshots).toHaveLength(0);
    expect(terminal.rendered.join("")).toBe("downloading 10%\n");
  });

  it("慢命令分两批：第一批不抓快照，第二批才抓，且快照包含全部输出", async () => {
    const terminal = fakeTerminal();
    const { deps, snapshots } = harness(terminal);
    // 第一批：慢命令的中间输出（没有 D）
    await writeOutputParts([text("step 1/2\n")], deps);
    expect(snapshots).toHaveLength(0);
    // 第二批：剩余输出 + D + 提示符
    await writeOutputParts([text("step 2/2\n"), end(0), text("user@host:~$ ")], deps);
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]).toBe("step 1/2\nstep 2/2\n");
  });

  it("结束标记单独成块（本次没有可写文本）→ 先 flush 再抓快照", async () => {
    const terminal = fakeTerminal();
    const { deps, snapshots } = harness(terminal);
    // 先排队一次写入但不等它完成（模拟输出密集时 D 紧随其后到达）
    const pending = terminal.write("late output\n");
    await writeOutputParts([end(0), text("user@host:~$ ")], deps);
    await pending;
    expect(snapshots[0]).toBe("late output\n");
  });

  it("空 before 也能安全抓快照（不写东西也要 flush）", async () => {
    const terminal = fakeTerminal();
    const { deps, snapshots } = harness(terminal);
    await writeOutputParts([end(0), text("user@host:~$ ")], deps);
    expect(snapshots).toEqual([""]);
  });
});
