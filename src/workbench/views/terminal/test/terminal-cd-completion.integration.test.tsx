/**
 * cd 远程目录补全 —— **TerminalView 级集成测试**（不只测 Provider）。
 *
 * 复刻 TerminalView 的真实接线，全部用生产实现：
 * - `RemoteCwdTracker`（cwd 四源同步：OSC 7 > 成功的 cd > 受控 pwd 探测）；
 * - `useTerminalCompletion`（React 层 + 调度器防抖）；
 * - `resolveCompletions` → `defaultProviders()`（Provider 注册制原样）；
 * - 只有 SFTP 列目录被替换成可观测的假实现（记录 `sessionId::path`），
 *   受控 pwd 探测的 `sshInput` 走 mock 的 opsApi。
 *
 * 驱动方式 = 用户在终端里的真实操作序列：
 * 提交 `cd …` → `noteCd` → （shell 回 OSC 133 D / OSC 7）→ `onCommandEnd` /
 * `feedOutput` → 敲 `cd`、`cd `、`cd o` → 断言列表目录与候选。
 */

import { act, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@/i18n";

const sshInputMock = vi.fn(async (..._args: unknown[]) => undefined);

vi.mock("@/api/ops-api", () => ({
  opsApi: {
    sshInput: (...args: unknown[]) => sshInputMock(...(args as [])),
    sftpListDir: async () => ({ entries: [] }),
  },
}));

import { opsApi } from "@/api/ops-api";
import type { RemoteFileEntry } from "@/api/ops-api";
import { invalidateDirectoryCache, setDirectoryLister } from "../completion/remote-listing";
import { parseLine } from "../completion/path-input";
import { CWD_PROBE_LINE, RemoteCwdTracker } from "../remote-cwd";
import { ghostTextFor } from "../terminal-suggest";
import { useTerminalCompletion } from "../use-terminal-completion";

function entry(name: string, kind: RemoteFileEntry["kind"] = "directory"): RemoteFileEntry {
  return { name, kind, hidden: name.startsWith(".") } as RemoteFileEntry;
}

/** 远程目录树（fake SFTP 侧）。`/dev` 特意混入普通文件。 */
const TREE: Record<string, RemoteFileEntry[]> = {
  "/root": [entry("opt"), entry(".config"), entry("notes.txt", "file"), entry("my docs")],
  "/root/opt": [entry("app"), entry("bin")],
  "/dev": [entry("pts"), entry("shm"), entry("null", "file"), entry("fd", "symlink"), entry("ovm")],
  "/var": [entry("log")],
  "/var/log": [entry("nginx"), entry("syslog", "file")],
};

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// -- 可观测的 SFTP 列目录层 ---------------------------------------------------

const listCalls: string[] = [];
const fakeLister = async ({ sessionId, path }: { sessionId: string; path: string }) => {
  listCalls.push(`${sessionId}::${path}`);
  return TREE[path] ?? [];
};

// -- Harness：TerminalView 的补全等价物 --------------------------------------

interface HarnessProps {
  tracker: RemoteCwdTracker;
  sessionId: string;
  line: string;
  /** 是否启用 TerminalView 的受控 pwd 探测接线（行空 + needsProbe）。 */
  probeWiring: boolean;
}

let latest: {
  labels: string[];
  inserts: string[];
  notice: string | null;
  /** 收起态行内 ghost（第一条候选的剩余部分，TerminalView 的接线等价）。 */
  ghost: string;
} = { labels: [], inserts: [], notice: null, ghost: "" };

function Harness({ tracker, sessionId, line, probeWiring }: HarnessProps) {
  const enabled = line.trim().length > 0;
  const completion = useTerminalCompletion({
    sessionId,
    line,
    cursor: line.length,
    enabled,
    cwd: tracker.get(sessionId),
    home: tracker.home(sessionId),
    debounceMs: 150,
  });
  const parsed = parseLine(line, line.length);
  const ghost = enabled
    ? ghostTextFor(completion.items[0], line, parsed && parsed.index > 0 ? parsed.prefix : null)
    : "";
  latest = {
    labels: completion.items.map((item) => item.label),
    inserts: completion.items.map((item) => item.insertText),
    notice: completion.notice,
    ghost,
  };

  // TerminalView.requestCwdProbe 的接线等价：行是空的（shell 停在提示符上）
  // 且 tracker 说需要探测 → 发受控探测行。**绝不在用户输入途中发**；
  // cwdProbedRef 等价的防重（re-render 不重复发）。
  const probedRef = useRef(false);
  const needsProbe = probeWiring && line === "" && tracker.needsProbe(sessionId);
  if (needsProbe && !probedRef.current) {
    probedRef.current = true;
    void opsApi.sshInput(sessionId, `${CWD_PROBE_LINE}\r`).catch(() => undefined);
  }
  return null;
}

// -- 测试 ---------------------------------------------------------------------

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** 提交一条命令（TerminalView.noteExecutedCommand 的 cwd 部分等价）。 */
function submitCd(tracker: RemoteCwdTracker, sessionId: string, command: string) {
  tracker.noteCd(sessionId, command);
}

/** shell 回 OSC 133 D（命令结束，带退出码）。 */
function commandEnd(tracker: RemoteCwdTracker, sessionId: string, exitCode: number | null) {
  tracker.onCommandEnd(sessionId, exitCode);
}

let host: HTMLDivElement;
let root: Root;
let tracker: RemoteCwdTracker;

const SESSION = "sess-1";
const OTHER = "sess-2";

async function renderHarness(line: string, sessionId = SESSION, probeWiring = true) {
  await act(async () => {
    root.render(
      <Harness tracker={tracker} sessionId={sessionId} line={line} probeWiring={probeWiring} />,
    );
  });
}

/** 输入一行并等调度器防抖（150ms）+ 结果落定。 */
async function type(line: string, sessionId = SESSION) {
  await renderHarness(line, sessionId);
  await wait(240);
}

beforeEach(() => {
  vi.clearAllMocks();
  listCalls.length = 0;
  setDirectoryLister(fakeLister as never);
  tracker = new RemoteCwdTracker();
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  setDirectoryLister(null);
  invalidateDirectoryCache();
});

describe("cd remote-directory completion (integration)", () => {
  it("starts from the OSC 7 reported cwd (/root)", async () => {
    tracker.feedOutput(SESSION, "\x1b]7;file://host/root\x07");
    expect(tracker.get(SESSION)).toBe("/root");

    await type("cd ");
    expect(listCalls).toEqual([`${SESSION}::/root`]);
    // 收起态行内 ghost：第一条候选的剩余部分（含转义引号 —— 写回什么样
    // ghost 就显示什么样；不弹面板，只有 ghost 文本）。
    expect(latest.ghost).toBe('"my docs"/');
  });

  it("blank input never reads the remote directory or shows a ghost", async () => {
    tracker.setFromOsc7(SESSION, "/root");
    await type("");
    expect(listCalls).toEqual([]);
    expect(latest.ghost).toBe("");
    expect(latest.labels).toEqual([]);
  });

  it("a successful `cd /dev` moves the cwd; bare `cd` then lists /dev", async () => {
    tracker.setFromOsc7(SESSION, "/root");
    submitCd(tracker, SESSION, "cd /dev");
    commandEnd(tracker, SESSION, 0); // OSC 133 D: exit 0
    expect(tracker.get(SESSION)).toBe("/dev");

    // 裸 `cd`（还没有空格）→ 列 cwd。
    await type("cd");
    expect(listCalls).toEqual([`${SESSION}::/dev`]);
    // 普通文件（null）绝不出现；可进入的 symlink（fd）与真目录一起出现。
    expect(latest.labels).toEqual(["fd", "ovm", "pts", "shm"]);
    // 插入文本必须自带前导空格（`cd` 后面还没有空格）。
    expect(latest.inserts.every((text) => text.startsWith(" "))).toBe(true);
    // ghost 前自动包含必要的空格（用户裁决：裸 cd 的 ghost = " fd/"）。
    expect(latest.ghost).toBe(" fd/");
  });

  it("`cd ` (space typed) lists /dev without doubling the space", async () => {
    tracker.setFromOsc7(SESSION, "/dev");
    await type("cd ");
    expect(listCalls).toEqual([`${SESSION}::/dev`]);
    expect(latest.inserts.every((text) => !text.startsWith(" "))).toBe(true);
  });

  it("`cd o` only shows o-prefixed directories", async () => {
    tracker.setFromOsc7(SESSION, "/dev");
    await type("cd o");
    expect(listCalls).toEqual([`${SESSION}::/dev`]);
    expect(latest.labels).toEqual(["ovm"]);
    // ghost = 第一条候选去掉已输入的 partial（用户视觉：黑 `cd o` + 灰 `vm/`）。
    expect(latest.ghost).toBe("vm/");
  });

  it("multi-level completion continues from the trailing slash", async () => {
    tracker.setFromOsc7(SESSION, "/root");
    await type("cd opt/");
    expect(listCalls).toEqual([`${SESSION}::/root/opt`]);
    expect(latest.labels).toEqual(["app", "bin"]);
  });

  it("supports absolute (/var/), ~, hidden and spaced names", async () => {
    tracker.setFromOsc7(SESSION, "/root");
    tracker.setHome(SESSION, "/home/deploy");

    await type("cd /var/l");
    expect(listCalls).toContain(`${SESSION}::/var`);
    expect(latest.labels).toEqual(["log"]); // /var 下只有 log 目录

    invalidateDirectoryCache(SESSION);
    await type("cd /var/log/n");
    expect(latest.labels).toEqual(["nginx"]); // syslog 是文件，不出现

    invalidateDirectoryCache(SESSION);
    await type("cd ~/");
    expect(listCalls).toContain(`${SESSION}::/home/deploy`);

    invalidateDirectoryCache(SESSION);
    await type("cd ."); // 隐藏目录只有 `.` 开头才出现
    expect(latest.labels).toEqual([".config"]);

    invalidateDirectoryCache(SESSION);
    await type("cd my"); // 带空格目录：写回必须带引号
    expect(latest.labels).toEqual(["my docs"]);
    expect(latest.inserts).toContain('"my docs"/');
  });

  it("a failed cd keeps the previous cwd — suggestions still read the old directory", async () => {
    tracker.setFromOsc7(SESSION, "/root");
    submitCd(tracker, SESSION, "cd /var/log");
    commandEnd(tracker, SESSION, 1); // cd 失败（OSC 133 D exit 1）
    expect(tracker.get(SESSION)).toBe("/root");

    await type("cd n");
    // 仍列**原目录** /root（nginx 在 /var/log 下，不该冒出来）。
    expect(listCalls).toEqual([`${SESSION}::/root`]);
    expect(latest.labels).toEqual(["notes.txt"].filter(() => false)); // 文件被过滤 → 空
    expect(latest.notice).toBe("No matching remote directories");
  });

  it("a cd without any confirmation signal marks cwd uncertain and probes before completing", async () => {
    tracker.setFromOsc7(SESSION, "/root");
    submitCd(tracker, SESSION, "cd /var/log");
    // 既没有 OSC 133 D 也没有 OSC 7 → uncertain（但此时行还是空的）。
    commandEnd(tracker, SESSION, null);
    expect(tracker.stateOf(SESSION).uncertain).toBe(true);

    // 行清空后 TerminalView 的探测接线发起**受控 pwd 探测**（OSC 7，无可见文字）。
    await renderHarness("", SESSION, true);
    expect(sshInputMock).toHaveBeenCalledTimes(1);
    expect(sshInputMock.mock.calls[0][0]).toBe(SESSION);
    expect(String(sshInputMock.mock.calls[0][1])).toContain(CWD_PROBE_LINE);

    // shell 执行探测行 → OSC 7 报回真实 cwd（/var/log）→ uncertain 清除。
    await act(async () => {
      tracker.feedOutput(SESSION, "\x1b]7;file://host/var/log\x1b\\");
    });
    expect(tracker.stateOf(SESSION).uncertain).toBe(false);

    // 下一次目录补全用的是刷新后的 cwd。
    invalidateDirectoryCache(SESSION);
    await type("cd n", SESSION);
    expect(listCalls).toContain(`${SESSION}::/var/log`);
    expect(latest.labels).toEqual(["nginx"]);
  });

  it("does not probe while the user is typing (would corrupt the line)", async () => {
    tracker.setFromOsc7(SESSION, "/root");
    submitCd(tracker, SESSION, "cd /var/log");
    commandEnd(tracker, SESSION, null);

    await type("cd v"); // 行非空 → 绝不发探测
    expect(sshInputMock).not.toHaveBeenCalled();
  });

  it("keeps per-tab cwd and directory caches isolated", async () => {
    // 两个 Tab：sess-1 在 /dev，sess-2 在 /root。
    tracker.setFromOsc7(SESSION, "/dev");
    tracker.setFromOsc7(OTHER, "/root");

    await type("cd p", SESSION);
    expect(latest.labels).toEqual(["pts"]);
    await type("cd o", OTHER);
    expect(latest.labels).toEqual(["opt"]); // sess-2 看到的是自己的 /root

    // 目录缓存按 sessionId 隔离：清掉 sess-1 的不影响 sess-2 的命中。
    const callsBefore = listCalls.length;
    invalidateDirectoryCache(SESSION);
    await type("cd p", SESSION);
    expect(listCalls.slice(callsBefore)).toEqual([`${SESSION}::/dev`]); // sess-1 重新列
    await type("cd o", OTHER);
    expect(listCalls.length).toBe(callsBefore + 1); // sess-2 仍命中缓存
  });
});
