import { describe, expect, it } from "vitest";
import {
  CommandBoundaryParser,
  INJECTED_LINES,
  MARKER_C_LINE,
  MARKER_D_LINE,
} from "../command-boundary";

const OSC_C = "\x1b]133;C\x07";
const OSC_D = (code = 0) => `\x1b]133;D;${code}\x07`;

describe("CommandBoundaryParser", () => {
  it("解析输出开始 / 结束 / 退出码，并把标记从可见文本里剔除", () => {
    const parser = new CommandBoundaryParser();
    parser.expect(INJECTED_LINES);
    const first = parser.feed(`${OSC_C}Filesystem  Size\n`);
    expect(first.events).toEqual([{ type: "output_start" }]);
    expect(first.text).toBe("Filesystem  Size\n");

    const second = parser.feed(`/dev/sda1  50G\n${OSC_D()}`);
    expect(second.text).toBe("/dev/sda1  50G\n");
    expect(second.events).toEqual([{ type: "output_end", exitCode: 0 }]);
  });

  it("携带真实退出码（非零也要传出来）", () => {
    const parser = new CommandBoundaryParser();
    parser.expect(INJECTED_LINES);
    const { events } = parser.feed(OSC_D(127));
    expect(events).toEqual([{ type: "output_end", exitCode: 127 }]);
  });

  it("剔除注入行的回显（含前导空格与换行）", () => {
    const parser = new CommandBoundaryParser();
    parser.expect(INJECTED_LINES);
    // 真实流：三条回显连着来（含 \r\n），中间夹着标记输出。
    const { text } = parser.feed(
      ` ${MARKER_C_LINE}\r\ndf -h\r\n ${MARKER_D_LINE}\r\n${OSC_C}Filesystem\n`,
    );
    expect(text).toBe("df -h\r\nFilesystem\n");
  });

  it("标记被切成两块时不会漏给用户，也不会丢事件", () => {
    const parser = new CommandBoundaryParser();
    parser.expect(INJECTED_LINES);
    const marker = OSC_D(2);
    const cut = Math.floor(marker.length / 2);
    const first = parser.feed(`out\n${marker.slice(0, cut)}`);
    // 半截标记必须留在缓冲区，等下一块。
    expect(first.text).toBe("out\n");
    expect(first.events).toHaveLength(0);

    const second = parser.feed(marker.slice(cut));
    expect(second.text).toBe("");
    expect(second.events).toEqual([{ type: "output_end", exitCode: 2 }]);
  });

  it("注入行回显被切成两块时同样能剔除", () => {
    const parser = new CommandBoundaryParser();
    parser.expect(INJECTED_LINES);
    const cut = 10;
    const first = parser.feed(`x\n${MARKER_D_LINE.slice(0, cut)}`);
    expect(first.text).toBe("x\n");
    const second = parser.feed(`${MARKER_D_LINE.slice(cut)}\r\nok\n`);
    expect(second.text).toBe("ok\n");
  });

  it("未注入标记时原样透传（不误删正文）", () => {
    const parser = new CommandBoundaryParser();
    parser.expect([]);
    const body = `printf '\\033]133;C\\007' 只是普通文本\n`;
    expect(parser.feed(body).text).toBe(body);
  });

  it("flush 会吐出残留的半截标记（断开连接时不丢字）", () => {
    const parser = new CommandBoundaryParser();
    parser.expect(INJECTED_LINES);
    expect(parser.feed("\x1b]133;D;1").text).toBe("");
    expect(parser.flush().text).toBe("\x1b]133;D;1");
  });

  it("普通输出里不含任何标记时零改动", () => {
    const parser = new CommandBoundaryParser();
    parser.expect(INJECTED_LINES);
    const body = "hello 世界\n第二行\t带 Tab\n";
    expect(parser.feed(body).text).toBe(body);
  });

  it("parts 把结束标记切成独立事件段（D 之后的内容另起一段）", () => {
    const parser = new CommandBoundaryParser();
    parser.expect(INJECTED_LINES);
    // D 之后还有内容（例如 D 标记行执行完 shell 再打的提示符）—— 必须落在
    // 事件段之后，快照才能只取事件前的部分。
    const { parts } = parser.feed(`out1\n${OSC_D(0)}tail\n`);
    expect(parts).toEqual([
      { kind: "text", text: "out1\n" },
      { kind: "event", event: { type: "output_end", exitCode: 0 } },
      { kind: "text", text: "tail\n" },
    ]);
  });

  it("text/events 是 parts 的等价投影（连续事件不吞文本）", () => {
    const parser = new CommandBoundaryParser();
    parser.expect(INJECTED_LINES);
    const { text, events, parts } = parser.feed(`head\n${OSC_C}mid\n${OSC_D(3)}`);
    expect(parts).toEqual([
      { kind: "text", text: "head\n" },
      { kind: "event", event: { type: "output_start" } },
      { kind: "text", text: "mid\n" },
      { kind: "event", event: { type: "output_end", exitCode: 3 } },
    ]);
    expect(text).toBe("head\nmid\n");
    expect(events).toEqual([
      { type: "output_start" },
      { type: "output_end", exitCode: 3 },
    ]);
  });
});
