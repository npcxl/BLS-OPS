import { describe, expect, it } from "vitest";
import type { FileChangeSummary, FileDiff } from "@/api/types/agent";
import {
  batchSummary,
  buildChangeTree,
  canOpenInRemote,
  changeStatusLabel,
  countInDir,
  diffSegments,
  fileLabel,
  filterChanges,
  gapLines,
  isPending,
} from "../file-changes";

function change(patch: Partial<FileChangeSummary> = {}): FileChangeSummary {
  return {
    id: "c1",
    taskId: "t1",
    callId: "call-1",
    stepIndex: 0,
    workspaceId: "w1",
    server: "prod",
    path: "/etc/nginx/conf.d/ops.conf",
    tool: "write_file",
    status: "written",
    stage: "actual",
    created: false,
    binary: false,
    tooLarge: false,
    additions: 2,
    deletions: 1,
    diffReady: true,
    backupPath: null,
    backupVerified: false,
    canOpen: true,
    uncollected: false,
    createdAt: 1,
    updatedAt: 1,
    ...patch,
  };
}

describe("文件变更：目录树", () => {
  it("按服务器目录分组，同级目录在文件前", () => {
    const tree = buildChangeTree([
      change({ id: "a", path: "/etc/nginx/nginx.conf" }),
      change({ id: "b", path: "/etc/nginx/conf.d/ops.conf" }),
      change({ id: "c", path: "/var/www/app/index.html" }),
    ]);
    expect(tree.dirs.map((dir) => dir.name)).toEqual(["etc", "var"]);
    const nginx = tree.dirs[0].dirs[0];
    expect(nginx.name).toBe("nginx");
    // 同一目录里：conf.d 是目录，nginx.conf 是文件。
    expect(nginx.dirs.map((dir) => dir.name)).toEqual(["conf.d"]);
    expect(nginx.files.map((item) => item.id)).toEqual(["a"]);
    expect(countInDir(tree)).toBe(3);
  });

  it("没有路径的记录挂在根上，不编造目录", () => {
    const tree = buildChangeTree([
      change({ id: "shell", path: "", uncollected: true, tool: "run_shell", diffReady: false }),
    ]);
    expect(tree.dirs).toHaveLength(0);
    expect(tree.files).toHaveLength(1);
    expect(fileLabel(tree.files[0])).toBe("run_shell");
  });

  it("筛选按路径匹配，大小写不敏感", () => {
    const list = [change({ id: "a", path: "/etc/nginx/nginx.conf" }), change({ id: "b", path: "/var/www/a.html" })];
    expect(filterChanges(list, "NGINX").map((item) => item.id)).toEqual(["a"]);
    expect(filterChanges(list, "   ")).toHaveLength(2);
    expect(filterChanges(list, "nomatch")).toHaveLength(0);
  });
});

describe("文件变更：批次结论", () => {
  it("待确认优先于其它状态", () => {
    const summary = batchSummary([
      change({ status: "proposed", stage: "proposed" }),
      change({ id: "c2", status: "written" }),
    ]);
    expect(summary.state).toBe("pending");
    expect(summary.pending).toBe(1);
  });

  it("一个文件成功、另一个失败 = 部分成功，不拿单文件替整批背书", () => {
    const summary = batchSummary([
      change({ status: "written" }),
      change({ id: "c2", status: "write_failed" }),
    ]);
    expect(summary.state).toBe("partial");
    expect(summary.written).toBe(1);
    expect(summary.failed).toBe(1);
  });

  it("全部失败 = 失败；全部写入 = 已写入", () => {
    expect(batchSummary([change({ status: "write_failed" })]).state).toBe("failed");
    expect(batchSummary([change({ status: "written" }), change({ id: "c2" })]).state).toBe("written");
    expect(batchSummary([]).state).toBe("empty");
  });

  it("增删行数按记录累加", () => {
    const summary = batchSummary([
      change({ additions: 3, deletions: 1 }),
      change({ id: "c2", additions: 5, deletions: 2 }),
    ]);
    expect(summary.additions).toBe(8);
    expect(summary.deletions).toBe(3);
  });
});

describe("文件变更：折叠段", () => {
  const diff: FileDiff = {
    unchanged: 30,
    additions: 2,
    deletions: 1,
    tooLarge: false,
    hunks: [
      {
        oldStart: 6,
        oldLines: 4,
        newStart: 6,
        newLines: 5,
        lines: [],
      },
      {
        oldStart: 20,
        oldLines: 3,
        newStart: 21,
        newLines: 3,
        lines: [],
      },
    ],
  };

  it("hunk 之间的未修改内容拆成独立段", () => {
    const segments = diffSegments("c1", diff);
    expect(segments.map((item) => item.kind)).toEqual(["gap", "hunk", "gap", "hunk", "gap"]);
    const first = segments[0];
    expect(first.kind === "gap" && first.count).toBe(5);
    const middle = segments[2];
    // 第一个 hunk 结束于 old 9，下一个从 old 20 开始 → 10 行未修改。
    expect(middle.kind === "gap" && middle.count).toBe(10);
    const tail = segments[4];
    // 第二段结束于 old 22；全文 30 行 → 剩 8 行。
    expect(tail.kind === "gap" && tail.count).toBe(8);
  });

  it("展开时按旧行号取原文", () => {
    const segments = diffSegments("c1", diff);
    const gap = segments[0];
    if (gap.kind !== "gap") throw new Error("应当是未修改段");
    const text = Array.from({ length: 40 }, (_, index) => `line ${index + 1}`).join("\n");
    const lines = gapLines(text, gap);
    expect(lines[0]).toEqual([1, "line 1"]);
    expect(lines[4]).toEqual([5, "line 5"]);
    expect(gapLines(null, gap)).toEqual([]);
  });
});

describe("文件变更：状态文案与打开条件", () => {
  const t = (key: string) => key;

  it("状态各自有标签，未采集不冒充成功", () => {
    expect(changeStatusLabel("proposed", t)).toBe("拟修改");
    expect(changeStatusLabel("written", t)).toBe("已写入");
    expect(changeStatusLabel("readback_failed", t)).toBe("回读失败");
    expect(changeStatusLabel("uncollected", t)).toBe("未采集差异");
    expect(isPending("proposed")).toBe(true);
    expect(isPending("written")).toBe(false);
  });

  it("只有确认存在且是绝对路径的文件才能打开", () => {
    expect(canOpenInRemote(change())).toBe(true);
    expect(canOpenInRemote(change({ canOpen: false }))).toBe(false);
    expect(canOpenInRemote(change({ path: "" }))).toBe(false);
  });
});
