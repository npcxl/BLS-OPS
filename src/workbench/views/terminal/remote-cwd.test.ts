import { describe, expect, it } from "vitest";

import {
  CWD_PROBE_LINE,
  Osc7Scanner,
  RemoteCwdTracker,
  decodeOsc7Path,
  parseCdArgument,
  parseOsc7,
  resolveCd,
  unquoteArgument,
} from "./remote-cwd";

/**
 * cwd 是"补全在哪儿列目录"的依据 —— 错了整份候选就错了，所以：
 * - 只认可信来源（OSC 7 > 成功的 cd > 受控探测 > 登录目录），**绝不从
 *   `root@host:~#` 之类的提示符猜**；
 * - `cd` 失败时目录不变；
 * - 每个 SSH 会话各自一份，切 Tab 互不干扰。
 */

describe("OSC 7 parsing", () => {
  it("reads a BEL-terminated sequence", () => {
    const text = `before\x1b]7;file://myhost/srv/app\x07after`;
    expect(parseOsc7(text)).toBe("/srv/app");
  });

  it("reads an ST-terminated sequence", () => {
    expect(parseOsc7("\x1b]7;file://host/var/log\x1b\\")).toBe("/var/log");
  });

  it("decodes percent-encoded paths (spaces, CJK)", () => {
    expect(decodeOsc7Path("file://host/srv/my%20app")).toBe("/srv/my app");
    expect(decodeOsc7Path("file://host/%E6%9C%8D%E5%8A%A1")).toBe("/服务");
  });

  it("supports the local file URI form", () => {
    expect(decodeOsc7Path("file:///root")).toBe("/root");
  });

  it("returns null when there is no path", () => {
    expect(decodeOsc7Path("file://host")).toBeNull();
    expect(decodeOsc7Path("")).toBeNull();
  });

  it("survives a malformed encoding instead of throwing", () => {
    expect(decodeOsc7Path("file://host/srv/100%")).toBe("/srv/100%");
  });
});

describe("Osc7Scanner", () => {
  it("joins sequences split across chunks", () => {
    const scanner = new Osc7Scanner();
    expect(scanner.feed("prefix\x1b]7;file://host/srv/ap")).toEqual([]);
    expect(scanner.feed("p\x07tail")).toEqual(["/srv/app"]);
  });

  it("reports several sequences in one chunk", () => {
    const scanner = new Osc7Scanner();
    const found = scanner.feed("\x1b]7;file://h/a\x07noise\x1b]7;file://h/b\x1b\\");
    expect(found).toEqual(["/a", "/b"]);
  });

  it("does not rescan text that was already consumed", () => {
    const scanner = new Osc7Scanner();
    scanner.feed("\x1b]7;file://h/a\x07");
    expect(scanner.feed("more output")).toEqual([]);
  });
});

describe("parseCdArgument", () => {
  it("recognizes a bare cd as 'go home'", () => {
    expect(parseCdArgument("cd")).toBe("");
    expect(parseCdArgument("cd   ")).toBe("");
  });

  it("keeps the argument as typed", () => {
    expect(parseCdArgument("cd /var/log")).toBe("/var/log");
    expect(parseCdArgument("cd ..")).toBe("..");
    expect(parseCdArgument("cd -")).toBe("-");
  });

  it("strips one layer of quotes", () => {
    expect(parseCdArgument('cd "path with spaces"')).toBe("path with spaces");
    expect(parseCdArgument("cd 'path with spaces'")).toBe("path with spaces");
  });

  it("rejects compound commands — their exit code does not prove cd succeeded", () => {
    expect(parseCdArgument("cd /tmp && ls")).toBeNull();
    expect(parseCdArgument("cd /tmp; pwd")).toBeNull();
  });

  it("rejects other commands", () => {
    expect(parseCdArgument("ls -l")).toBeNull();
  });
});

describe("unquoteArgument", () => {
  it("unescapes backslashes inside double quotes", () => {
    expect(unquoteArgument('"my\\ dir"')).toBe("my dir");
  });

  it("keeps single-quoted text verbatim", () => {
    expect(unquoteArgument("'a\\b'")).toBe("a\\b");
  });
});

describe("resolveCd", () => {
  const home = "/root";

  it("resolves a bare cd and ~ to the home directory", () => {
    expect(resolveCd("/srv", "", home, null)).toBe("/root");
    expect(resolveCd("/srv", "~", home, null)).toBe("/root");
  });

  it("resolves `cd -` to the previous directory", () => {
    expect(resolveCd("/srv", "-", home, "/var/log")).toBe("/var/log");
  });

  it("resolves relative paths against the current directory", () => {
    expect(resolveCd("/srv/app", "logs", home, null)).toBe("/srv/app/logs");
    expect(resolveCd("/srv/app", "..", home, null)).toBe("/srv");
    expect(resolveCd("/srv/app", "../..", home, null)).toBe("/");
  });

  it("resolves absolute paths", () => {
    expect(resolveCd("/srv/app", "/var/log", home, null)).toBe("/var/log");
  });

  it("resolves ~/sub", () => {
    expect(resolveCd("/srv", "~/sites", home, null)).toBe("/root/sites");
  });

  it("refuses to invent a home directory", () => {
    expect(resolveCd("/srv", "~/sites", null, null)).toBeNull();
    expect(resolveCd("/srv", "", null, null)).toBeNull();
  });

  it("refuses to guess a relative path without a cwd", () => {
    expect(resolveCd(null, "logs", home, null)).toBeNull();
  });
});

describe("RemoteCwdTracker", () => {
  it("takes OSC 7 as the most trusted source", () => {
    const tracker = new RemoteCwdTracker();
    tracker.setHome("s1", "/root");
    expect(tracker.get("s1")).toBe("/root");

    tracker.setFromOsc7("s1", "/srv/app");
    expect(tracker.get("s1")).toBe("/srv/app");
    expect(tracker.stateOf("s1").source).toBe("osc7");
  });

  it("picks cwd up from streamed output", () => {
    const tracker = new RemoteCwdTracker();
    const found = tracker.feedOutput("s1", `\x1b]7;file://host/opt/app\x07`);
    expect(found).toBe("/opt/app");
    expect(tracker.get("s1")).toBe("/opt/app");
  });

  it("only applies a cd after the command really succeeded", () => {
    const tracker = new RemoteCwdTracker();
    tracker.setHome("s1", "/root");
    tracker.noteCd("s1", "cd /opt/app");
    // 还没结束 → 目录没变（pending）。
    expect(tracker.get("s1")).toBe("/root");

    tracker.onCommandEnd("s1", 0);
    expect(tracker.get("s1")).toBe("/opt/app");
    expect(tracker.stateOf("s1").source).toBe("tracked");
  });

  it("does not update the cwd when cd fails", () => {
    const tracker = new RemoteCwdTracker();
    tracker.setHome("s1", "/root");
    tracker.noteCd("s1", "cd /does/not/exist");
    tracker.onCommandEnd("s1", 1);
    expect(tracker.get("s1")).toBe("/root");
  });

  it("does not update when the exit code is unknown", () => {
    const tracker = new RemoteCwdTracker();
    tracker.setHome("s1", "/root");
    tracker.noteCd("s1", "cd /opt");
    tracker.onCommandEnd("s1", null);
    expect(tracker.get("s1")).toBe("/root");
  });

  it("keeps a cd - memory of the previous directory", () => {
    const tracker = new RemoteCwdTracker();
    tracker.setHome("s1", "/root");
    tracker.noteCd("s1", "cd /opt");
    tracker.onCommandEnd("s1", 0);
    tracker.noteCd("s1", "cd -");
    tracker.onCommandEnd("s1", 0);
    expect(tracker.get("s1")).toBe("/root");
  });

  it("ignores compound commands", () => {
    const tracker = new RemoteCwdTracker();
    tracker.setHome("s1", "/root");
    tracker.noteCd("s1", "cd /tmp && ls");
    tracker.onCommandEnd("s1", 0);
    expect(tracker.get("s1")).toBe("/root");
  });

  it("lets OSC 7 override a pending cd", () => {
    const tracker = new RemoteCwdTracker();
    tracker.noteCd("s1", "cd /opt");
    tracker.setFromOsc7("s1", "/var/www");
    tracker.onCommandEnd("s1", 0);
    // OSC 7 是权威结果：即使 cd 报成功也不覆盖它。
    expect(tracker.get("s1")).toBe("/var/www");
  });

  it("keeps sessions isolated — switching tabs does not leak cwd", () => {
    const tracker = new RemoteCwdTracker();
    tracker.setHome("s1", "/root");
    tracker.setHome("s2", "/home/deploy");
    tracker.noteCd("s1", "cd /opt/app");
    tracker.onCommandEnd("s1", 0);

    expect(tracker.get("s1")).toBe("/opt/app");
    expect(tracker.get("s2")).toBe("/home/deploy");
    expect(tracker.home("s2")).toBe("/home/deploy");
  });

  it("asks for a probe only when the first two sources have no answer", () => {
    const tracker = new RemoteCwdTracker();
    expect(tracker.needsProbe("s1")).toBe(true); // 什么都不知道
    tracker.setHome("s1", "/root");
    expect(tracker.needsProbe("s1")).toBe(true); // 只有登录目录，不算数
    tracker.setFromOsc7("s1", "/srv");
    expect(tracker.needsProbe("s1")).toBe(false);
  });

  it("accepts a probe result but never overrides OSC 7", () => {
    const tracker = new RemoteCwdTracker();
    tracker.setFromProbe("s1", "/from/probe");
    expect(tracker.get("s1")).toBe("/from/probe");
    tracker.setFromOsc7("s1", "/from/osc7");
    tracker.setFromProbe("s1", "/late/probe");
    expect(tracker.get("s1")).toBe("/from/osc7");
  });

  it("forgets everything when the session ends", () => {
    const tracker = new RemoteCwdTracker();
    tracker.setHome("s1", "/root");
    tracker.forget("s1");
    expect(tracker.get("s1")).toBeNull();
    expect(tracker.home("s1")).toBeNull();
  });
});

describe("controlled pwd probe", () => {
  it("emits OSC 7 instead of printing a visible path", () => {
    // 让 shell 自己上报：终端里不会多出 `pwd` 的输出。
    expect(CWD_PROBE_LINE).toContain("\\033]7;");
    expect(CWD_PROBE_LINE).toContain("$PWD");
    // 前导空格：bash/zsh 在 HISTCONTROL=ignorespace 下不进历史。
    expect(CWD_PROBE_LINE.startsWith(" ")).toBe(true);
    expect(CWD_PROBE_LINE).not.toContain("echo");
  });
});
