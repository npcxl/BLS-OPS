/**
 * 文件变更面板的**纯视图逻辑**：状态文案、目录树、折叠段、批次结论。
 *
 * 不碰 React / Tauri：目录分组、增删计数、部分成功的判定都能单测，
 * 界面只负责把结果画出来。
 */
import type { DiffHunk, FileChangeDetail, FileChangeSummary, FileDiff } from "@/api/types/agent";
import type { Translate } from "./agent-steps";

/** 状态 → 一句话（界面上的小徽标）。 */
export function changeStatusLabel(status: string, t: Translate): string {
  switch (status) {
    case "proposed":
      return t("拟修改");
    case "written":
      return t("已写入");
    case "deleted":
      return t("已删除");
    case "unchanged":
      return t("无变化");
    case "write_failed":
      return t("写入失败");
    case "readback_failed":
      return t("回读失败");
    case "rejected":
      return t("已拒绝");
    case "withdrawn":
      return t("已撤回");
    case "stale":
      return t("已作废");
    case "uncollected":
      return t("未采集差异");
    case "unavailable":
      return t("无法对比");
    default:
      return status;
  }
}

export type ChangeTone = "neutral" | "info" | "success" | "warning" | "danger";

/** 状态 → 语气：只有"确实写进去了"才用成功色。 */
export function changeTone(status: string): ChangeTone {
  switch (status) {
    case "proposed":
      return "info";
    case "written":
    case "deleted":
      return "success";
    case "unchanged":
      return "neutral";
    case "write_failed":
    case "readback_failed":
      return "danger";
    case "rejected":
    case "withdrawn":
    case "stale":
      return "warning";
    default:
      return "neutral";
  }
}

/** 还没有被放行的记录：面板"待确认的变更"只列这些。 */
export function isPending(status: string): boolean {
  return status === "proposed";
}

/**
 * 已确认落地的净变化：只有这类才算进「已更改的文件」。
 *
 * `uncollected` / `readback_failed` / `unavailable` 是"没有可靠快照"的条目，
 * 照常列出（要能核对），但不能算已确认变更。
 */
export function isConfirmedChange(change: FileChangeSummary): boolean {
  return change.status === "written" || change.status === "deleted";
}

/**
 * 计数为 0 时替代 `+0 -0` 的文字。
 *
 * 净变化条目由后端给出具体原因（新增空文件 / 二进制已修改 / 敏感内容已变化…）；
 * 逐条历史没有这个字段，就按状态与已知标记推一句。
 */
export function changeReasonLabel(change: FileChangeSummary, t: Translate): string {
  // 后端给的是具体原因（新增空文件 / 二进制已修改…）：当成文案 key 交给 i18n，
  // 没有对应翻译时原样返回，不会丢信息。
  if (change.reason) return t(change.reason);
  if (change.uncollected || change.status === "uncollected") return t("未采集差异");
  if (change.status === "readback_failed") return t("回读失败");
  if (change.status === "unavailable") return t("无法对比");
  if (change.status === "write_failed") return t("写入失败");
  if (change.binary) return t("二进制已修改");
  if (change.created && change.additions === 0) return t("新增空文件");
  if (change.status === "deleted" && change.deletions === 0) return t("删除空文件");
  return changeStatusLabel(change.status, t);
}

/**
 * 一批变更的整体结论。
 *
 * **不能用某个文件的成功替整批背书**：只要有一个失败，整批就是"部分成功"或
 * "失败"，不会显示成"已写入"。
 */
export interface BatchSummary {
  /** 展示的条目数（含未确认 / 未采集）。 */
  files: number;
  /** 已确认发生净变化的文件数：未确认 / 未采集**不计入**。 */
  changed: number;
  additions: number;
  deletions: number;
  pending: number;
  written: number;
  failed: number;
  skipped: number;
  /** `pending` / `written` / `partial` / `failed` / `skipped` / `empty` / `nochange`。 */
  state: "pending" | "written" | "partial" | "failed" | "skipped" | "empty" | "nochange";
  /** 所有记录都属于同一台服务器时给名字，否则 `null`（界面显示"多台服务器"）。 */
  server: string | null;
}

/**
 * 一批变更的整体结论。
 *
 * `net=true` 表示这批是**净变化**：此时空列表 = "本轮确实没有变化"，
 * 界面显示「本轮无文件净变化」，而不是"没有可展示的变更"。
 */
export function batchSummary(changes: FileChangeSummary[], net = false): BatchSummary {
  const summary: BatchSummary = {
    files: changes.length,
    changed: 0,
    additions: 0,
    deletions: 0,
    pending: 0,
    written: 0,
    failed: 0,
    skipped: 0,
    state: "empty",
    server: changes[0]?.server ?? null,
  };
  const servers = new Set<string>();
  for (const change of changes) {
    servers.add(change.server);
    switch (change.status) {
      case "proposed":
        /*
         * 待确认预览**独立统计**：行数按预览本身算（用户要看的正是"改了哪些行"），
         * 但不计入「已更改的文件」—— 它还没有落地。
         */
        summary.pending += 1;
        summary.additions += Math.max(0, change.additions);
        summary.deletions += Math.max(0, change.deletions);
        break;
      case "written":
      case "deleted":
        summary.written += 1;
        summary.changed += 1;
        summary.additions += Math.max(0, change.additions);
        summary.deletions += Math.max(0, change.deletions);
        break;
      case "unchanged":
        summary.written += 1;
        break;
      case "write_failed":
      case "readback_failed":
        summary.failed += 1;
        break;
      default:
        summary.skipped += 1;
    }
  }
  if (servers.size !== 1) summary.server = null;
  if (summary.files === 0) summary.state = net ? "nochange" : "empty";
  else if (summary.pending > 0) summary.state = "pending";
  else if (summary.failed > 0) summary.state = summary.changed > 0 ? "partial" : "failed";
  else if (summary.changed > 0) summary.state = "written";
  else summary.state = "skipped";
  return summary;
}

/** 批次结论 → 徽标语气。 */
export function batchTone(state: BatchSummary["state"]): ChangeTone {
  switch (state) {
    case "pending":
      return "info";
    case "written":
      return "success";
    case "nochange":
      return "neutral";
    case "partial":
      return "warning";
    case "failed":
      return "danger";
    default:
      return "neutral";
  }
}

export function batchStateLabel(state: BatchSummary["state"], t: Translate): string {
  switch (state) {
    case "pending":
      return t("待确认");
    case "nochange":
      return t("无净变化");
    case "written":
      return t("已写入");
    case "partial":
      return t("部分成功");
    case "failed":
      return t("失败");
    case "skipped":
      return t("未执行");
    default:
      return t("暂无变更");
  }
}

/* ---------------- 目录树 ---------------- */

export interface ChangeDir {
  /** 目录名（根节点是 `/`）。 */
  name: string;
  /** 完整路径（根是 `/`）。 */
  path: string;
  dirs: ChangeDir[];
  files: FileChangeSummary[];
}

/**
 * 按服务器目录分组。
 *
 * 路径来自服务器的绝对路径（`/etc/nginx/conf.d/ops.conf`）：同级目录排在文件前，
 * 名字按字典序 —— 每次打开面板顺序一致，不会因为事件顺序跳来跳去。
 */
export function buildChangeTree(changes: FileChangeSummary[]): ChangeDir {
  const root: ChangeDir = { name: "/", path: "/", dirs: [], files: [] };
  for (const change of changes) {
    // 没有路径的记录（普通 shell / 读取失败）放在根上，不编一个假目录。
    const segments = change.path.split("/").filter(Boolean);
    if (segments.length === 0) {
      root.files.push(change);
      continue;
    }
    let node = root;
    for (const segment of segments.slice(0, -1)) {
      const path = node.path === "/" ? `/${segment}` : `${node.path}/${segment}`;
      let next = node.dirs.find((dir) => dir.name === segment);
      if (!next) {
        next = { name: segment, path, dirs: [], files: [] };
        node.dirs.push(next);
      }
      node = next;
    }
    node.files.push(change);
  }
  sortDir(root);
  return root;
}

function sortDir(dir: ChangeDir) {
  dir.dirs.sort((a, b) => a.name.localeCompare(b.name));
  dir.files.sort((a, b) => fileLabel(a).localeCompare(fileLabel(b)));
  dir.dirs.forEach(sortDir);
}

/** 树上的文件名（最后一段）。 */
export function fileLabel(change: FileChangeSummary): string {
  const parts = change.path.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? (change.uncollected ? change.tool : change.path) ?? "—";
}

/** 路径筛选：大小写不敏感，空串 = 全都要。 */
export function filterChanges(
  changes: FileChangeSummary[],
  filter: string,
): FileChangeSummary[] {
  const needle = filter.trim().toLowerCase();
  if (!needle) return changes;
  return changes.filter((change) =>
    `${change.path} ${change.server} ${change.tool}`.toLowerCase().includes(needle),
  );
}

/** 目录里（含子目录）有多少条记录：角标用。 */
export function countInDir(dir: ChangeDir): number {
  return dir.files.length + dir.dirs.reduce((sum, child) => sum + countInDir(child), 0);
}

/* ---------------- 折叠段 ---------------- */

/**
 * 把 Diff 拆成「改动段」与「未修改的长段」。
 *
 * 后端只回带 3 行上下文的 hunk，hunk 之间的空白就是被折叠的未修改内容；
 * 展开时用 `beforeText` 里的原文补上（那一区的两边完全一致）。
 */
export type ChangeSegment =
  | { kind: "hunk"; key: string; index: number; hunk: DiffHunk }
  | { kind: "gap"; key: string; count: number; oldStart: number; newStart: number };

export function diffSegments(changeId: string, diff: FileDiff): ChangeSegment[] {
  const segments: ChangeSegment[] = [];
  let oldCursor = 1;
  let newCursor = 1;
  diff.hunks.forEach((hunk, index) => {
    const gap = hunk.oldStart - oldCursor;
    if (gap > 0) {
      segments.push({
        kind: "gap",
        key: `${changeId}:g${index}`,
        count: gap,
        oldStart: oldCursor,
        newStart: newCursor,
      });
    }
    segments.push({ kind: "hunk", key: `${changeId}:h${index}`, index, hunk });
    oldCursor = hunk.oldStart + hunk.oldLines;
    newCursor = hunk.newStart + hunk.newLines;
  });
  if (diff.unchanged > 0) {
    const tail = diff.unchanged - (oldCursor - 1);
    if (tail > 0) {
      segments.push({
        kind: "gap",
        key: `${changeId}:gtail`,
        count: tail,
        oldStart: oldCursor,
        newStart: newCursor,
      });
    }
  }
  return segments;
}

/** 展开一段未修改内容：返回 `[旧行号, 文本]`。 */
export function gapLines(
  text: string | null | undefined,
  segment: Extract<ChangeSegment, { kind: "gap" }>,
): Array<[number, string]> {
  if (!text) return [];
  const lines = text.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  const out: Array<[number, string]> = [];
  for (let index = 0; index < segment.count; index += 1) {
    const position = segment.oldStart - 1 + index;
    if (position >= lines.length) break;
    out.push([segment.oldStart + index, lines[position]]);
  }
  return out;
}

/** 详情标题上的状态：拟修改 / 实际变更（后端状态之外的**阶段**说明）。 */
export function stageLabel(
  detail: Pick<FileChangeDetail, "summary">,
  t: Translate,
): string {
  if (detail.summary.stage === "actual") return t("实际变更");
  if (detail.summary.stage === "proposed") return t("拟修改");
  return t("无差异可展示");
}

/** 状态是否允许"在远程文件中打开"。 */
export function canOpenInRemote(change: FileChangeSummary): boolean {
  return change.canOpen && change.path.startsWith("/");
}

/** 备份路径是不是**已验证存在**（计划中的备份名只给可复制文本）。 */
export function backupVerified(change: FileChangeSummary): boolean {
  return change.backupVerified && Boolean(change.backupPath);
}
