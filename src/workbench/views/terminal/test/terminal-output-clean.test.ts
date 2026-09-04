import { describe, expect, it } from "vitest";
import {
  applyBackspaces,
  applyCarriageReturns,
  canonicalCommand,
  hasPipeline,
  normalizeForParsing,
  stripAnsi,
  stripCommandEcho,
  stripTrailingPrompt,
} from "./terminal-output-clean";

describe("ANSI 控制序列清理", () => {
  it("去掉颜色码但保留文本", () => {
    expect(stripAnsi("\x1b[31mERROR\x1b[0m: disk full")).toBe("ERROR: disk full");
  });

  it("去掉光标移动与清屏序列", () => {
    expect(stripAnsi("\x1b[2J\x1b[Htotal 12\n")).toBe("total 12\n");
    expect(stripAnsi("\x1b[1;2Hmoved")).toBe("moved");
  });

  it("去掉 OSC 序列（标题设置等）", () => {
    expect(stripAnsi("\x1b]0;title\x07text")).toBe("text");
  });

  it("保留换行与制表符", () => {
    expect(stripAnsi("a\tb\nc")).toBe("a\tb\nc");
  });
});

describe("回车覆盖（进度条）", () => {
  it("只保留最后一次覆盖的内容", () => {
    expect(applyCarriageReturns("[===>    ] 40%\r[======> ] 70%\r[========] 100%")).toBe(
      "[========] 100%",
    );
  });

  it("不影响正常的 \\r\\n 换行", () => {
    expect(applyCarriageReturns("line1\r\nline2")).toBe("line1\r\nline2");
  });

  it("多行各自独立处理", () => {
    expect(applyCarriageReturns("a\rbb\nc\rdd")).toBe("bb\ndd");
  });
});

describe("退格处理", () => {
  it("退格删除前一个字符", () => {
    expect(applyBackspaces("abc\b\bd")).toBe("ad");
  });
});

describe("命令回显去除", () => {
  it("第一行正好是命令时移除", () => {
    expect(stripCommandEcho("df -hP\nFilesystem Size\n/dev 50G", "df -hP")).toBe(
      "Filesystem Size\n/dev 50G",
    );
  });

  it("第一行不是命令时不误删数据", () => {
    const text = "Filesystem Size\n/dev 50G";
    expect(stripCommandEcho(text, "df -hP")).toBe(text);
  });
});

describe("尾部提示符去除", () => {
  it("去掉尾部 $ 提示符", () => {
    expect(stripTrailingPrompt("total 12\nroot@web:~# ")).toBe("total 12");
    expect(stripTrailingPrompt("total 12\n$ ")).toBe("total 12");
  });

  it("数据行不以提示符结尾时不误删", () => {
    expect(stripTrailingPrompt("nginx:1.24\nmysql:8.0")).toBe("nginx:1.24\nmysql:8.0");
  });
});

describe("完整清洗流程", () => {
  it("ANSI + 回显 + 提示符一次清干净", () => {
    const raw = "\x1b[?2004hdf -hP\r\nFilesystem Size\r\ndev 50G\r\nroot@web:~# ";
    const out = normalizeForParsing(raw, "df -hP");
    expect(out).toBe("Filesystem Size\ndev 50G");
    // 解析输入里绝不允许残留控制字符或占位行。
    expect(out).not.toMatch(/\x1b/);
    expect(out).not.toContain("df -hP");
    expect(out).not.toContain("root@web");
  });
});

describe("命令标准化（匹配用）", () => {
  it("去掉前导 sudo", () => {
    expect(canonicalCommand("sudo df -hP")).toBe("df -hP");
    expect(canonicalCommand("sudo sudo df")).toBe("df");
  });

  it("截断管道之后的部分（输出结构已被改变）", () => {
    expect(canonicalCommand("df -hP | grep /dev")).toBe("df -hP");
    expect(canonicalCommand("docker ps && docker images")).toBe("docker ps");
  });

  it("压缩多余空白", () => {
    expect(canonicalCommand("  docker   ps  -a ")).toBe("docker ps -a");
  });

  it("空输入 / 纯管道返回 null", () => {
    expect(canonicalCommand("   ")).toBeNull();
    expect(canonicalCommand("| grep x")).toBeNull();
  });

  it("hasPipeline 识别管道与链式", () => {
    expect(hasPipeline("df -h | grep")).toBe(true);
    expect(hasPipeline("docker ps && docker images")).toBe(true);
    expect(hasPipeline("df -hP")).toBe(false);
  });
});
