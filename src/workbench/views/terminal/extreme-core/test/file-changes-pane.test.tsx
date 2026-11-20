import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { i18n } from "@/i18n";
import type { FileChangeDetail, FileChangeSummary } from "@/api/types/agent";
import { useExtremeStore } from "@/stores/extreme-store";
import { FileChangesPane } from "../FileChangesPane";

/**
 * 右栏「文件变更」的渲染约束：
 * * 正文来自**后端返回的 hunk**（不是前端猜的）；
 * * 只显示当前对话的记录；
 * * 没有 Diff 的操作如实标成"未采集"，不画假的增删。
 */
const list = vi.fn();
const detail = vi.fn();

vi.mock("@/api/ops-api", () => ({
  opsApi: {
    aiAgentFileChanges: (...args: unknown[]) => list(...args),
    aiAgentFileChangeDetail: (...args: unknown[]) => detail(...args),
  },
}));

function change(patch: Partial<FileChangeSummary> = {}): FileChangeSummary {
  return {
    id: "c1",
    taskId: "task-1",
    callId: "call-0-0",
    stepIndex: 0,
    workspaceId: "w1",
    server: "prod",
    serverId: "s1",
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
    backupPath: "/etc/nginx/conf.d/ops.conf.bls-bak.1",
    backupVerified: true,
    canOpen: true,
    uncollected: false,
    note: null,
    createdAt: 1,
    updatedAt: 2,
    ...patch,
  };
}

function detailOf(summary: FileChangeSummary): FileChangeDetail {
  return {
    summary,
    before: { exists: true, path: summary.path, sha: "a", size: 4, binary: false, tooLarge: false },
    after: { exists: true, path: summary.path, sha: "b", size: 8, binary: false, tooLarge: false },
    diff: {
      additions: 2,
      deletions: 1,
      unchanged: 10,
      tooLarge: false,
      hunks: [
        {
          oldStart: 1,
          oldLines: 2,
          newStart: 1,
          newLines: 3,
          lines: [
            { kind: "context", text: "server {", oldNo: 1, newNo: 1 },
            { kind: "del", text: "    listen 80;", oldNo: 2, newNo: null },
            { kind: "add", text: "    listen 8080;", oldNo: null, newNo: 2 },
            { kind: "add", text: "    server_name ops.local;", oldNo: null, newNo: 3 },
          ],
        },
      ],
      note: null,
    },
    beforeText: "server {\n    listen 80;\n}\n",
    afterText: "server {\n    listen 8080;\n    server_name ops.local;\n}\n",
    limits: [],
    redacted: false,
  };
}

async function renderPane(node: React.ReactElement) {
  const holder = document.body.appendChild(document.createElement("div"));
  const root = createRoot(holder);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  await act(async () => root.render(node));
  // 摘要与正文都是异步加载：多让几轮微任务，等 setState 落地。
  for (let index = 0; index < 6; index += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
  return {
    holder,
    cleanup: async () => {
      await act(async () => root.unmount());
      holder.remove();
      vi.unstubAllGlobals();
    },
  };
}

beforeEach(() => {
  list.mockReset();
  detail.mockReset();
  useExtremeStore.setState({ fileChanges: {}, changeViews: {}, tasks: {} });
  // happy-dom 没有实现滚动：点文件时不能因此抛错。
  Element.prototype.scrollIntoView = vi.fn();
});

afterEach(() => {
  useExtremeStore.setState({ fileChanges: {}, changeViews: {}, tasks: {} });
});

it("renders the unified diff returned by the backend", async () => {
  const summary = change();
  useExtremeStore.setState({ fileChanges: { [summary.id]: summary } });
  list.mockResolvedValue([summary]);
  detail.mockResolvedValue(detailOf(summary));

  const language = i18n.language;
  await i18n.changeLanguage("zh-CN");
  const { holder, cleanup } = await renderPane(
    <FileChangesPane
      workspaceId="w1"
      serverName="prod"
      sessionId="ssh-1"
      onOpenRemotePath={() => undefined}
    />,
  );
  try {
    const text = holder.textContent ?? "";
    expect(text).toContain("/etc/nginx/conf.d/ops.conf");
    expect(text).toContain("listen 8080");
    expect(text).toContain("+2");
    expect(text).toContain("-1");
    // 回读之后的记录标「实际变更」（不是模型的说法）。
    expect(text).toContain("实际变更");
    // 两个列的行号：删除行只有旧行号，新增行只有新行号。
    const del = holder.querySelector("[data-kind='del']");
    expect(del?.textContent).toContain("listen 80");
    expect(del?.textContent).not.toContain("listen 8080");
    const add = holder.querySelector("[data-kind='add']");
    expect(add?.textContent).toContain("listen 8080");
    // 已验证的备份显示"已备份"，未验证的只能是"计划备份"。
    expect(text).toContain("已备份");
  } finally {
    await cleanup();
    await i18n.changeLanguage(language);
  }
});

it("uses the compact codex-style diff layout", async () => {
  const summary = change();
  useExtremeStore.setState({ fileChanges: { [summary.id]: summary } });
  list.mockResolvedValue([summary]);
  detail.mockResolvedValue(detailOf(summary));

  const language = i18n.language;
  await i18n.changeLanguage("zh-CN");
  const { holder, cleanup } = await renderPane(
    <FileChangesPane
      workspaceId="w1"
      serverName="prod"
      sessionId="ssh-1"
      onOpenRemotePath={() => undefined}
    />,
  );
  try {
    // 顶栏：轮次胶囊带增删总数，切换入口收在胶囊里（不再叠一排标签）。
    const chip = holder.querySelector("[aria-haspopup='menu']");
    expect(chip?.textContent).toContain("+2");
    expect(chip?.textContent).toContain("-1");
    expect(holder.querySelector(".extreme-core-pane-tabs")).toBeNull();

    // 文件头吸顶；正文只有旧 / 新两列行号与代码（无 + / - 字符列、无 @@ 行）。
    const header = holder.querySelector("section > div");
    expect(header?.className).toContain("sticky");
    const rows = holder.querySelectorAll(".extreme-core-diff-row");
    expect(rows.length).toBe(4);
    expect(rows[0]?.children.length).toBe(3);
    expect(holder.textContent).not.toContain("@@");

    // 未修改的长段折叠成一条可展开的带。
    expect(holder.querySelector(".extreme-core-diff-gap")?.getAttribute("aria-expanded")).toBe(
      "false",
    );
    expect(holder.textContent).toContain("行未修改");

    // 文件树的筛选框就在树面板里，不是在正文上方。
    const aside = holder.querySelector("aside");
    expect(aside?.querySelector("input[aria-label='按路径筛选文件']")).toBeTruthy();
  } finally {
    await cleanup();
    await i18n.changeLanguage(language);
  }
});

it("never shows files from another conversation", async () => {
  const mine = change({ id: "mine", workspaceId: "w1", path: "/etc/a.conf" });
  const other = change({ id: "other", workspaceId: "w2", path: "/etc/b.conf" });
  useExtremeStore.setState({ fileChanges: { mine, other } });
  list.mockResolvedValue([mine]);
  detail.mockResolvedValue(detailOf(mine));

  const language = i18n.language;
  await i18n.changeLanguage("zh-CN");
  const { holder, cleanup } = await renderPane(
    <FileChangesPane
      workspaceId="w1"
      serverName="prod"
      sessionId="ssh-1"
      onOpenRemotePath={() => undefined}
    />,
  );
  try {
    const text = holder.textContent ?? "";
    expect(text).toContain("/etc/a.conf");
    expect(text).not.toContain("/etc/b.conf");
  } finally {
    await cleanup();
    await i18n.changeLanguage(language);
  }
});

it("marks shell writes as uncollected instead of drawing a fake diff", async () => {
  const shell = change({
    id: "shell",
    path: "",
    tool: "run_shell",
    status: "uncollected",
    stage: "none",
    additions: 0,
    deletions: 0,
    diffReady: false,
    canOpen: false,
    uncollected: true,
    note: "普通 shell 命令……该操作未采集文件差异",
  });
  useExtremeStore.setState({ fileChanges: { shell } });
  list.mockResolvedValue([shell]);

  const language = i18n.language;
  await i18n.changeLanguage("zh-CN");
  const { holder, cleanup } = await renderPane(
    <FileChangesPane
      workspaceId="w1"
      serverName="prod"
      sessionId="ssh-1"
      onOpenRemotePath={() => undefined}
    />,
  );
  try {
    const text = holder.textContent ?? "";
    expect(text).toContain("未采集差异");
    expect(text).toContain("没有逐行差异");
    expect(detail).not.toHaveBeenCalled();
  } finally {
    await cleanup();
    await i18n.changeLanguage(language);
  }
});

it("offers a pending view and jumps to a file from the tree", async () => {
  const pending = change({
    id: "p1",
    status: "proposed",
    stage: "proposed",
    canOpen: false,
    backupVerified: false,
  });
  const other = change({ id: "p2", path: "/var/www/app/index.html" });
  useExtremeStore.setState({ fileChanges: { p1: pending, p2: other } });
  list.mockResolvedValue([pending, other]);
  detail.mockImplementation((id: string) => Promise.resolve(detailOf(id === "p1" ? pending : other)));

  const language = i18n.language;
  await i18n.changeLanguage("zh-CN");
  const { holder, cleanup } = await renderPane(
    <FileChangesPane
      workspaceId="w1"
      serverName="prod"
      sessionId="ssh-1"
      focus={{ taskId: "task-1", changeId: "p2", nonce: 1 }}
      onOpenRemotePath={() => undefined}
    />,
  );
  try {
    // 从聊天点进来：定位到指定文件（文件树里该项被选中）。
    const selected = holder.querySelector("[data-selected='true']");
    expect(selected?.textContent).toContain("index.html");

    // 顶栏胶囊是"待确认 / 历史运行"的切换入口（和上一轮 Diff 一起收在这里）。
    const chip = holder.querySelector("[aria-haspopup='menu']") as HTMLElement | null;
    expect(chip).toBeTruthy();
    await act(async () => {
      chip!.click();
    });
    const pendingItem = [...holder.querySelectorAll("[role='menuitemradio']")].find((node) =>
      (node.textContent ?? "").includes("待确认的变更"),
    ) as HTMLElement | undefined;
    expect(pendingItem).toBeTruthy();
    await act(async () => {
      pendingItem!.click();
    });

    const text = holder.textContent ?? "";
    expect(text).toContain("待确认的变更");
    expect(text).toContain("拟修改");
    // 切到待确认：只剩还没放行的那份，已写入的不再混进来。
    expect(text).toContain("ops.conf");
    expect(text).not.toContain("index.html");
  } finally {
    await cleanup();
    await i18n.changeLanguage(language);
  }
});
