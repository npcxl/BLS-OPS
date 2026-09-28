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
} from "../remote-cwd";

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
    expect(found.path).toBe("/opt/app");
    // 此前不知道 cwd → 认识到了，但**不算"变化"**：面板挂载时已经加载过登录
    // 目录，这里再跟随一次就是重复加载。
    expect(found.changed).toBeNull();
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

  it("marks the cwd uncertain when a cd ends without exit code or OSC 7", () => {
    // 用户裁决：cd 提交后既没等到 OSC 133 D 也没等到 OSC 7 → 目录**可能**
    // 变了但无法证实 → uncertain（下一次补全前受控 pwd 探测刷新）。
    const tracker = new RemoteCwdTracker();
    tracker.setFromOsc7("s1", "/root");
    tracker.noteCd("s1", "cd /dev");
    tracker.onCommandEnd("s1", null);
    // 旧值保留（列目录有得用，比 null 好），但必须标 uncertain。
    expect(tracker.get("s1")).toBe("/root");
    expect(tracker.stateOf("s1").uncertain).toBe(true);
    expect(tracker.needsProbe("s1")).toBe(true);
  });

  it("a failed cd is NOT uncertain — the directory definitely did not change", () => {
    const tracker = new RemoteCwdTracker();
    tracker.setFromOsc7("s1", "/root");
    tracker.noteCd("s1", "cd /does/not/exist");
    tracker.onCommandEnd("s1", 1);
    expect(tracker.get("s1")).toBe("/root");
    expect(tracker.stateOf("s1").uncertain).toBe(false);
    expect(tracker.needsProbe("s1")).toBe(false);
  });

  it("a successful cd clears uncertainty", () => {
    const tracker = new RemoteCwdTracker();
    tracker.setFromOsc7("s1", "/root");
    tracker.noteCd("s1", "cd /dev");
    tracker.onCommandEnd("s1", 0);
    expect(tracker.stateOf("s1").uncertain).toBe(false);
    expect(tracker.needsProbe("s1")).toBe(false);
  });

  it("OSC 7 arriving late clears uncertainty", () => {
    const tracker = new RemoteCwdTracker();
    tracker.setFromOsc7("s1", "/root");
    tracker.noteCd("s1", "cd /dev");
    tracker.onCommandEnd("s1", null);
    expect(tracker.needsProbe("s1")).toBe(true);
    tracker.setFromOsc7("s1", "/dev"); // shell 的探测/上报回来了
    expect(tracker.needsProbe("s1")).toBe(false);
    expect(tracker.get("s1")).toBe("/dev");
  });

  it("non-cd commands never touch uncertainty", () => {
    const tracker = new RemoteCwdTracker();
    tracker.setFromOsc7("s1", "/root");
    tracker.noteCd("s1", "ls -la"); // 不是 cd → 不进 pending
    tracker.onCommandEnd("s1", null);
    expect(tracker.stateOf("s1").uncertain).toBe(false);
    expect(tracker.needsProbe("s1")).toBe(false);
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

  // -- 文件面板跟随：主依据是"权威 cwd 变了"（真事故回归） --------------------
  //
  // 精简提示符生效后每个提示符都上报 OSC 7，而一次 `cd` 的输出顺序是
  // "提示符先画（OSC 7 报新目录）→ 我们注入的 D 标记后跑"。曾经 setFromOsc7
  // 无条件作废 pending，于是 onCommandEnd 拿到 null → 面板再也不跟随
  // （用户报"右边的文件不跟随命令联动了"）。

  it("a prompt OSC 7 arriving right after a cd already means 'follow me'", () => {
    const tracker = new RemoteCwdTracker();
    tracker.setFromOsc7("s1", "/root");
    tracker.noteCd("s1", "cd /opt/app");
    // 提示符先画 → 这一条上报就够，面板跟它（不必等 D 标记）。
    const report = tracker.feedOutput("s1", `\x1b]7;file://host/opt/app\x07`);
    expect(report.changed).toBe("/opt/app");
    expect(tracker.get("s1")).toBe("/opt/app");
    // 已经跟过 → D 标记不能触发第二次同样的跟随。
    expect(tracker.onCommandEnd("s1", 0)).toBeNull();
  });

  it("a failed cd changes nothing upstream, so it can never move the panel", () => {
    const tracker = new RemoteCwdTracker();
    tracker.setFromOsc7("s1", "/root");
    tracker.noteCd("s1", "cd opt"); // /root/opt 不存在
    // 提示符报的还是 /root（目录没变）→ 不跟随。
    expect(tracker.feedOutput("s1", `\x1b]7;file://host/root\x07`).changed).toBeNull();
    // 连 D 标记的退出码也不能把面板带过去（pending 已作废）。
    expect(tracker.onCommandEnd("s1", 1)).toBeNull();
  });

  it("cd into the same directory still re-syncs the panel via the D marker", () => {
    const tracker = new RemoteCwdTracker();
    tracker.setFromOsc7("s1", "/root");
    tracker.noteCd("s1", "cd /root");
    expect(tracker.feedOutput("s1", `\x1b]7;file://host/root\x07`).changed).toBeNull();
    // 上报值与待定目标一致 → pending 保留，确认成功后照旧跟随。
    expect(tracker.onCommandEnd("s1", 0)).toBe("/root");
  });

  it("a compound cd can be followed too — via the reported change, not the exit code", () => {
    const tracker = new RemoteCwdTracker();
    tracker.setFromOsc7("s1", "/root");
    tracker.noteCd("s1", "cd /opt/app && ls"); // 复合命令 → noteCd 不记账
    expect(tracker.feedOutput("s1", `\x1b]7;file://host/opt/app\x07`).changed).toBe("/opt/app");
  });

  it("shells without OSC 7 keep the old path: D marker + exit code", () => {
    const tracker = new RemoteCwdTracker();
    tracker.setHome("s1", "/root"); // 只有兜底家目录，从没上报过 OSC 7
    tracker.noteCd("s1", "cd /opt/app");
    expect(tracker.onCommandEnd("s1", 0)).toBe("/opt/app");
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

/**
 * 文件面板跟随 `cd` 的唯一依据 = **`onCommandEnd` 的返回值**（确认成功的目标）。
 *
 * 两个"必须"：
 * 1. 必须是**绝对路径**（面板可能停在跟终端完全不同的目录，让它自己拼相对路径
 *    会拼出不存在的目录）；
 * 2. 必须是**确认成功的**（`cd` 打错字时 shell 里目录没变，面板也不许动 ——
 *    否则用户看到的是"明明 `ll` 有数据，右边却说这个路径不存在"）。
 *
 * `noteCd` 只负责把目标记进 `pending`，不对外给路径：那是"猜的方向"不是"事实"。
 */
describe("resolved cd target for the file panel", () => {
  it("resolves a relative argument against the terminal's own cwd", () => {
    const tracker = new RemoteCwdTracker();
    tracker.setFromOsc7("s1", "/opt/bls-kox");
    tracker.noteCd("s1", "cd ../logs");
    expect(tracker.stateOf("s1").pending).toBe("/opt/logs");
    tracker.noteCd("s1", "cd nginx");
    expect(tracker.stateOf("s1").pending).toBe("/opt/bls-kox/nginx");
    tracker.noteCd("s1", "cd /var/www");
    expect(tracker.stateOf("s1").pending).toBe("/var/www");
  });

  it("resolves ~ and - like the shell would", () => {
    const tracker = new RemoteCwdTracker();
    tracker.setHome("s1", "/root");
    tracker.noteCd("s1", "cd ~/app");
    expect(tracker.stateOf("s1").pending).toBe("/root/app");
    tracker.noteCd("s1", "cd");
    expect(tracker.stateOf("s1").pending).toBe("/root");
    tracker.setFromOsc7("s1", "/opt/a");
    tracker.noteCd("s1", "cd /opt/b");
    tracker.onCommandEnd("s1", 0);
    tracker.noteCd("s1", "cd -");
    expect(tracker.stateOf("s1").pending).toBe("/opt/a");
  });

  it("pending 为空（不是 cd / 复合命令 / 解析不出来），绝不猜", () => {
    const tracker = new RemoteCwdTracker();
    tracker.noteCd("s1", "ls -la");
    expect(tracker.stateOf("s1").pending).toBeNull();
    tracker.noteCd("s1", "cd /tmp && ls");
    expect(tracker.stateOf("s1").pending).toBeNull();
    // cwd 与家目录都不知道 → 解析不出来，绝不退回面板自己的目录。
    tracker.noteCd("s1", "cd ~/app");
    expect(tracker.stateOf("s1").pending).toBeNull();
  });

  it("onCommandEnd 只在 cd 成功时返回目标 —— 失败 / 未知一律 null（面板不动）", () => {
    const tracker = new RemoteCwdTracker();
    tracker.setFromOsc7("s1", "/root");

    // ✅ 成功：返回确认后的路径，面板可以跳。
    tracker.noteCd("s1", "cd /opt");
    expect(tracker.onCommandEnd("s1", 0)).toBe("/opt");

    // ❌ 打错字：shell 报 No such file，目录没变 → 面板必须原地不动。
    tracker.noteCd("s1", "cd opt");
    expect(tracker.onCommandEnd("s1", 1)).toBeNull();
    expect(tracker.get("s1")).toBe("/opt");

    // ❓ 没有退出码（标记没来）→ 同样不许跳。
    tracker.noteCd("s1", "cd /var");
    expect(tracker.onCommandEnd("s1", null)).toBeNull();

    // 不是 cd 的一次结束 → 与 cd 无关，返回 null。
    expect(tracker.onCommandEnd("s1", 0)).toBeNull();
  });
});
