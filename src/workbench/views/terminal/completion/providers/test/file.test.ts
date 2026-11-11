import { describe, expect, it } from "vitest";

import "@/i18n";

import type { RemoteFileEntry } from "@/api/ops-api";
import { parseLine } from "../../path-input";
import type { CompletionContext, ParsedLine } from "../../types";
import { createFileProvider } from "../file";

function entry(name: string, kind: RemoteFileEntry["kind"] = "file"): RemoteFileEntry {
  return { name, kind, hidden: name.startsWith(".") } as RemoteFileEntry;
}

const TREE: Record<string, RemoteFileEntry[]> = {
  "/root": [
    entry("opt", "directory"),
    entry("readme.txt"),
    entry("nginx.conf"),
    entry("release.zip"),
    entry("backup.tar.gz"),
    entry("bundle.tgz"),
    entry("archive.rar"),
    entry("notes.gz"),
    entry(".hidden.zip"),
  ],
};

async function labels(line: string, cwd = "/root"): Promise<string[]> {
  const context: CompletionContext = {
    line,
    cursor: line.length,
    sessionId: "s1",
    cwd,
    home: "/root",
  };
  const parsed: ParsedLine = parseLine(line, line.length);
  const provider = createFileProvider({ list: async () => TREE["/root"] });
  const result = await provider.complete(context, parsed);
  return result.items.map((item) => item.label);
}

describe("file completion by command semantics", () => {
  it("unzip 只给 .zip 与目录", async () => {
    const found = await labels("unzip ");
    expect(found).toContain("release.zip");
    expect(found).toContain("opt");
    expect(found).not.toContain("readme.txt");
    expect(found).not.toContain("backup.tar.gz");
  });

  it("tar 只给压缩包与目录", async () => {
    const found = await labels("tar -xf ");
    expect(found).toContain("backup.tar.gz");
    expect(found).toContain("bundle.tgz");
    expect(found).not.toContain("nginx.conf");
  });

  it("unrar 只给 .rar", async () => {
    const found = await labels("unrar ");
    expect(found).toContain("archive.rar");
    expect(found).not.toContain("release.zip");
  });

  it("cat 不过滤：文件与目录都给", async () => {
    const found = await labels("cat ");
    expect(found).toContain("readme.txt");
    expect(found).toContain("nginx.conf");
    expect(found).toContain("opt");
  });

  it("隐藏文件仍按 `.` 前缀规则控制", async () => {
    expect(await labels("unzip ")).not.toContain(".hidden.zip");
    expect(await labels("unzip .")).toContain(".hidden.zip");
  });

  it("cwd 未知时退回家目录，而不是完全不给候选", async () => {
    const context: CompletionContext = {
      line: "unzip ",
      cursor: 6,
      sessionId: "s1",
      cwd: null,
      home: "/root",
    };
    const provider = createFileProvider({ list: async () => TREE["/root"] });
    const result = await provider.complete(context, parseLine(context.line, context.cursor));
    expect(result.items.map((item) => item.label)).toContain("release.zip");
  });
});
