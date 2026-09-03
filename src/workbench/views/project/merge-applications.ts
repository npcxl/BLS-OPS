import type { ConfirmedProject, ConfirmedScanState, ProjectCandidate } from "@/api/ops-api";

/**
 * 渲染用候选：在 ProjectCandidate 之上附加"已确认项目"的持久化状态。
 */
export type DisplayCandidate = ProjectCandidate & {
  /** 该已确认项目本次扫描的态度：active / missing / inaccessible / changed。 */
  scanState?: ConfirmedScanState;
  /** 系统重新将其分类为基础设施，但用户曾确认是业务项目 → 需复核。 */
  kindChanged?: boolean;
  /** 本次扫描未再发现该路径（快照仍在，仅供展示）。 */
  confirmedMissing?: boolean;
};

/**
 * 「项目」列表 = 持久化已确认项目 + 本次扫描的高可信候选，按 canonical_path 合并。
 *
 * 人工确认优先级最高：只要一个路径被确认过，**无论本次扫描有没有再发现它**，
 * 它都必须出现在结果里 —— 差异只体现在 scanState（本次已发现 / 本次未发现 /
 * 服务器不可访问 / 信息有变化）。这是"已确认项目消失"问题的最终防线：
 * 扫描结果里没有 A 时，A 从 confirmedProjects 快照来；confirmedProjects 里
 * 没有 A 时（刚在本页确认、还没落库回读），A 从本次扫描的 confirmed 候选来。
 * 两个来源按 canonical_path 去重，绝不因为某一路径缺席一个来源就消失。
 */
export function mergeApplications(
  confirmedProjects: ConfirmedProject[],
  resolved: ProjectCandidate[],
): DisplayCandidate[] {
  const out: DisplayCandidate[] = [];
  const usedPaths = new Set<string>();

  // 人工合并的子目录不单独成行（人工决定优先于扫描，扫描快照里的
  // merged_into 只是标注）。父候选可能自己不在扫描结果里（比如已确认），
  // 所以这里按 resolved 里的标注与快照里的标注双重判断。
  const isMerged = (path: string): boolean => {
    const scanned = resolved.find((c) => c.path === path);
    if (scanned) return Boolean(scanned.merged_into);
    return Boolean(
      confirmedProjects.find((cp) => cp.canonical_path === path)?.candidate?.merged_into,
    );
  };

  // 1) 持久化已确认项目：无论本次是否扫到，都先加入。
  for (const cp of confirmedProjects) {
    if (isMerged(cp.canonical_path)) continue;
    const scanned = resolved.find((c) => c.path === cp.canonical_path);
    if (scanned) {
      usedPaths.add(scanned.path);
      const kindChanged =
        scanned.project_kind === "infrastructure" &&
        cp.candidate?.project_kind !== "infrastructure";
      out.push({
        ...scanned,
        review: "confirmed",
        scanState: cp.scan_state,
        kindChanged,
        confirmedMissing: cp.scan_state !== "active",
      });
    } else {
      // 本次未扫到：保留快照，状态取 DB 的 scan_state（missing / inaccessible / changed）。
      if (cp.candidate) {
        out.push({
          ...cp.candidate,
          review: "confirmed",
          scanState: cp.scan_state,
          kindChanged: false,
          confirmedMissing: cp.scan_state !== "active",
        });
      }
    }
  }

  // 2) 本次扫描的高可信候选（未被已确认项目占用、未被人工合并的路径）。
  for (const c of resolved) {
    if (usedPaths.has(c.path)) continue;
    if (c.merged_into) continue;
    if (c.review === "ignored") continue;
    if (c.review === "confirmed") {
      // 刚在本页确认、confirmedProjects 还没回读的候选：本地已 upsert 快照，
      // 但即便没有，也不能让它因为"不在 confirmedProjects"而消失。
      out.push({ ...c, scanState: "active" });
      continue;
    }
    if (c.project_kind === "infrastructure") continue;
    if (c.status === "high_confidence") out.push({ ...c });
  }

  return out;
}

/** 被人工并入其他项目的子目录（resolved 里有 merged_into 的候选），按父路径分组。 */
export function mergedChildrenByParent(resolved: ProjectCandidate[]): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const c of resolved) {
    if (!c.merged_into) continue;
    const list = map.get(c.merged_into) ?? [];
    list.push(c.path);
    map.set(c.merged_into, list);
  }
  return map;
}

/**
 * 确认项目后本地 upsert 一条已确认项目记录（服务端落库的镜像），
 * 让"确认 → 重扫 → 新结果里没有它"这个窗口内项目也不消失。
 */
export function upsertConfirmedLocally(
  current: ConfirmedProject[],
  candidate: ProjectCandidate,
  serverId: string,
  now = Date.now(),
): ConfirmedProject[] {
  const record: ConfirmedProject = {
    id: `${serverId}:${candidate.path}`,
    server_id: serverId,
    canonical_path: candidate.path,
    name: candidate.name,
    project_type: candidate.project_type,
    candidate_payload: JSON.stringify(candidate),
    scan_state: "active",
    confirmed_at: now,
    updated_at: now,
    last_seen_at: now,
    missing_since: null,
    candidate,
  };
  const next = current.filter(
    (cp) => cp.canonical_path !== candidate.path,
  );
  next.push(record);
  return next;
}

/** 撤销确认 / 忽略后，把该项目从本地已确认列表移除（服务端已软删除）。 */
export function removeConfirmedLocally(
  current: ConfirmedProject[],
  path: string,
): ConfirmedProject[] {
  return current.filter((cp) => cp.canonical_path !== path);
}
