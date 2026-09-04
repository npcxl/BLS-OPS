import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// provider 生成 notice 时用 i18n.t（未命中 key 原样返回）—— 初始化 en 保证插值可用。
import "@/i18n";

import type { RemoteFileEntry } from "@/api/ops-api";
import { createRemoteDirectoryProvider } from "../providers/remote-directory";
import { createFileProvider } from "../providers/file";
import { invalidateDirectoryCache, setDirectoryLister } from "../remote-listing";
import { parseLine } from "../path-input";
import type { CompletionContext, CompletionResult, ParsedLine } from "../types";

/**
 * cd 目录补全的行为测试（列目录是唯一的 I/O，这里整体替换掉）。
 *
 * 重点：候选必须**来自当前 SSH 会话**、只给目录、隐藏目录按输入给、
 * 没有匹配时明确告知（而不是显示上一次的缓存结果）。
 */

function entry(name: string, kind: RemoteFileEntry["kind"] = "directory"): RemoteFileEntry {
  return { name, kind, hidden: name.startsWith(".") } as RemoteFileEntry;
}

const TREE: Record<string, RemoteFileEntry[]> = {
  "/root": [
    entry("opt"),
    entry("output"),
    entry("logs"),
    entry(".config"),
    entry("my dir"),
    entry("readme.txt", "file"),
  ],
  "/root/opt": [entry("app"), entry("bin")],
  "/root/my dir": [entry("docs"), entry("incoming")],
  "/home/deploy": [entry("sites"), entry("backups")],
  "/": [entry("root"), entry("var"), entry("etc")],
  "/var": [entry("log"), entry("www")],
  "/root/.config": [entry("nginx")],
};

type Lister = (args: { sessionId: string; path: string }) => Promise<RemoteFileEntry[]>;

/** 可观测的列表器：记录每次请求的路径。 */
function lister(): { list: Lister; calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    list: async ({ path }) => {
      calls.push(path);
      return TREE[path] ?? [];
    },
  };
}

function ctx(line: string, overrides: Partial<CompletionContext> = {}): CompletionContext {
  return { line, cursor: line.length, sessionId: "s1", cwd: "/root", home: "/root", ...overrides };
}

/** 真实解析（不手搓 ParsedLine）—— 光标位置与 prefix 都由 parseLine 给出。 */
function parsed(context: CompletionContext): ParsedLine {
  return parseLine(context.line, context.cursor);
}

async function complete(
  line: string,
  list: Lister,
  overrides: Partial<CompletionContext> = {},
): Promise<CompletionResult> {
  const provider = createRemoteDirectoryProvider({ list });
  const context = ctx(line, overrides);
  return provider.complete(context, parsed(context));
}

beforeEach(() => {
  invalidateDirectoryCache();
});

afterEach(() => {
  setDirectoryLister(null);
});

/** 走共享列表层（带缓存）的补全：缓存行为必须在这里验证。 */
async function completeCached(
  line: string,
  list: Lister,
  overrides: Partial<CompletionContext> = {},
): Promise<CompletionResult> {
  setDirectoryLister(list);
  const provider = createRemoteDirectoryProvider();
  const context = ctx(line, overrides);
  return provider.complete(context, parsed(context));
}

describe("cd completion", () => {
  it("lists the subdirectories of the current directory for `cd `", async () => {
    const io = lister();
    const result = await complete("cd ", io.list);
    expect(io.calls).toEqual(["/root"]);
    // 隐藏目录不出现（输入不是 `.` 开头），普通文件也不出现。
    expect(result.items.map((item) => item.label)).toEqual(["logs", "my dir", "opt", "output"]);
    expect(result.items.every((item) => item.type === "directory")).toBe(true);
  });

  it("does not show plain files", async () => {
    const io = lister();
    const result = await complete("cd ", io.list);
    expect(result.items.some((item) => item.label === "readme.txt")).toBe(false);
  });

  it("filters by the typed prefix (`cd o` → only o-prefixed directories)", async () => {
    const io = lister();
    const result = await complete("cd o", io.list);
    expect(result.items.map((item) => item.label)).toEqual(["opt", "output"]);
    expect(result.items[0].highlight).toEqual({ start: 0, length: 1 });
  });

  it("queries the next level for `cd opt/`", async () => {
    const io = lister();
    const result = await complete("cd opt/", io.list);
    expect(io.calls).toEqual(["/root/opt"]);
    expect(result.items.map((item) => item.label)).toEqual(["app", "bin"]);
  });

  it("keeps the trailing slash so completion can continue", async () => {
    const io = lister();
    const result = await complete("cd o", io.list);
    expect(result.items[0].insertText).toBe("opt/");
    // 替换范围只覆盖"还没敲完的那一段"，前面的 `cd ` 不动。
    expect(result.items[0].replaceRange).toEqual({ start: 3, end: 4 });
  });

  it("supports absolute paths", async () => {
    const io = lister();
    const result = await complete("cd /var/", io.list);
    expect(io.calls).toEqual(["/var"]);
    expect(result.items.map((item) => item.label)).toEqual(["log", "www"]);
  });

  it("supports ../", async () => {
    const io = lister();
    const result = await complete("cd ../", io.list, { cwd: "/root/opt" });
    expect(io.calls).toEqual(["/root"]);
    expect(result.items.map((item) => item.label)).toContain("opt");
  });

  it("supports ~/ against the remote home", async () => {
    const io = lister();
    const result = await complete("cd ~/", io.list, { home: "/home/deploy" });
    expect(io.calls).toEqual(["/home/deploy"]);
    expect(result.items.map((item) => item.label)).toEqual(["backups", "sites"]);
  });

  it("shows hidden directories only when the input starts with a dot", async () => {
    const io = lister();
    const plain = await complete("cd ", io.list);
    expect(plain.items.map((item) => item.label)).not.toContain(".config");

    const hidden = await complete("cd .", io.list);
    expect(hidden.items.map((item) => item.label)).toEqual([".config"]);
  });

  it("handles paths with spaces and keeps the open quote intact", async () => {
    const io = lister();
    const result = await complete('cd "my dir/', io.list);
    expect(io.calls).toEqual(["/root/my dir"]);
    expect(result.items.map((item) => item.label)).toEqual(["docs", "incoming"]);
    // 只替换光标前那一段（这里为空），开头的引号不受影响。
    expect(result.items[0].replaceRange).toEqual({ start: 11, end: 11 });
    expect(result.items[0].insertText).toBe("docs/");
  });

  it("quotes directory names that contain spaces when writing them back", async () => {
    const io = lister();
    const result = await complete("cd m", io.list);
    const spaced = result.items.find((item) => item.label === "my dir");
    // 引号要包在结尾 `/` 外面，否则下一层补全会跑出引号。
    expect(spaced?.insertText).toBe('"my dir"/');
    expect(io.calls).toEqual(["/root"]);
  });

  it("reports 'no matching remote directory' instead of stale results", async () => {
    const io = lister();
    const result = await complete("cd zzz", io.list);
    expect(result.items).toHaveLength(0);
    expect(result.notice).toBe("No matching remote directories");
  });

  it("says so when the cwd is unknown — never falls back to the local filesystem", async () => {
    const io = lister();
    const result = await complete("cd ", io.list, { cwd: null });
    expect(io.calls).toEqual([]);
    expect(result.items).toHaveLength(0);
    expect(result.notice).toContain("Remote working directory is unknown");
  });

  it("asks for the home directory instead of inventing one", async () => {
    const io = lister();
    const result = await complete("cd ~/", io.list, { home: null });
    expect(io.calls).toEqual([]);
    expect(result.notice).toContain("Remote home directory is unknown");
  });

  it("surfaces read failures instead of pretending the directory is empty", async () => {
    const list = vi.fn(async () => {
      throw new Error("Permission denied");
    }) as unknown as Lister;
    const result = await complete("cd ", list);
    expect(result.notice).toContain("Permission denied");
  });

  it("caches briefly but forgets after invalidation", async () => {
    const io = lister();
    await completeCached("cd ", io.list);
    await completeCached("cd o", io.list);
    // 同一个目录只列一次（第二个请求命中短缓存）。
    expect(io.calls).toEqual(["/root"]);

    // mkdir / rm / mv 之类改动目录结构后必须失效 ——
    // 留着一份"已经被删掉的目录"比不给补全更糟。
    invalidateDirectoryCache("s1");
    await completeCached("cd o", io.list);
    expect(io.calls).toEqual(["/root", "/root"]);
  });

  it("never serves another session's cached entries", async () => {
    const io = lister();
    await completeCached("cd ", io.list, { sessionId: "s1" });
    const result = await completeCached("cd ", io.list, { sessionId: "s2" });
    // 换了一台服务器就必须重新列目录。
    expect(io.calls).toEqual(["/root", "/root"]);
    expect(result.items.length).toBeGreaterThan(0);
  });

  it("tags every result with a request key so stale responses can be dropped", async () => {
    const io = lister();
    const first = await complete("cd o", io.list);
    const second = await complete("cd opt/", io.list);
    expect(first.requestKey).toBe("cd:/root:o");
    expect(second.requestKey).toBe("cd:/root/opt:");
    expect(first.requestKey).not.toBe(second.requestKey);
  });

  it("only owns the first argument of cd", async () => {
    const provider = createRemoteDirectoryProvider({ list: lister().list });
    expect(provider.matches(parsed(ctx("cd ")))).toBe(true);
    expect(provider.matches(parsed(ctx("cd opt x")))).toBe(false);
    expect(provider.matches(parsed(ctx("ls ")))).toBe(false);
  });
});

describe("file completion", () => {
  it("returns files and directories for `cat`", async () => {
    const io = lister();
    const provider = createFileProvider({ list: io.list });
    const context = ctx("cat ");
    const result = await provider.complete(context, parsed(context));
    expect(result.items.map((item) => item.label)).toContain("readme.txt");
    expect(result.items.map((item) => item.label)).toContain("opt");
  });

  it("marks directories with a trailing slash and files without", async () => {
    const io = lister();
    const provider = createFileProvider({ list: io.list });
    const context = ctx("cat ");
    const result = await provider.complete(context, parsed(context));
    const file = result.items.find((item) => item.label === "readme.txt");
    const dir = result.items.find((item) => item.label === "opt");
    expect(file?.insertText).toBe("readme.txt");
    expect(dir?.insertText).toBe("opt/");
  });

  it("is not owned by cd — that is the directory provider's job", async () => {
    const provider = createFileProvider({ list: lister().list });
    expect(provider.matches(parsed(ctx("cd ")))).toBe(false);
  });
});
