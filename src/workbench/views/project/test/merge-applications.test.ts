import { describe, expect, it } from "vitest";
import type {
  ConfirmedProject,
  ConfirmedScanState,
  ProjectCandidate,
} from "@/api/ops-api";
import {
  mergeApplications,
  removeConfirmedLocally,
  upsertConfirmedLocally,
} from "../merge-applications";

/** 构造一个最小候选（path 即身份）。 */
function candidate(overrides: Partial<ProjectCandidate> & { path: string }): ProjectCandidate {
  return {
    id: `s1:${overrides.path}`,
    server_id: "s1",
    name: overrides.path.split("/").pop() ?? "x",
    project_type: "node",
    score: 90,
    confidence: "high",
    status: "high_confidence",
    category: "source_only",
    project_kind: "application",
    deploy_instances: [],
    markers: ["package.json"],
    config_files: [],
    evidence: [],
    penalties: [],
    runtime_links: [],
    modules: [],
    detected_ports: [],
    required_environment_names: [],
    blockers: [],
    warnings: [],
    readiness: { score: 0, blockers: [], warnings: [], confirmed_facts: [], unknown_facts: [] },
    review: "pending",
    updated_at: "0",
    ...overrides,
  } as ProjectCandidate;
}

/** 把一个候选确认为持久化记录（模拟服务端 project_review_set 的落库结果）。 */
function confirmedOf(c: ProjectCandidate, scanState: ConfirmedScanState = "active"): ConfirmedProject {
  return {
    id: `s1:${c.path}`,
    server_id: "s1",
    canonical_path: c.path,
    name: c.name,
    project_type: c.project_type,
    candidate_payload: JSON.stringify(c),
    scan_state: scanState,
    confirmed_at: 1,
    updated_at: 1,
    last_seen_at: 1,
    missing_since: null,
    candidate: c,
  };
}

describe("确认过的项目在当前页面不会消失", () => {
  it("确认三个项目、重扫只返回一个 → 页面仍显示三个（问题1核心场景）", () => {
    // 用户依次确认了 A / B / C。
    const a = candidate({ path: "/opt/a" });
    const b = candidate({ path: "/opt/b" });
    const c = candidate({ path: "/opt/c" });
    let confirmedProjects = [a, b, c].map((x) => confirmedOf(x));

    // 本页刚确认（confirmedProjects 还没回读服务端）的场景：
    // resolved 里有 confirmed 候选，confirmedProjects 为空也不能丢。
    const justConfirmedResolved = [a, b, c].map((x) => ({ ...x, review: "confirmed" as const }));
    expect(mergeApplications([], justConfirmedResolved)).toHaveLength(3);

    // 重扫：本次只发现了 A，B/C 没扫到。DB 里 B/C 标 missing。
    confirmedProjects = [
      confirmedOf(a, "active"),
      confirmedOf(b, "missing"),
      confirmedOf(c, "missing"),
    ];
    const resolvedAfterScan = [
      { ...a, review: "confirmed" as const },
      { ...b, review: "confirmed" as const },
      { ...c, review: "confirmed" as const },
    ];
    const apps = mergeApplications(confirmedProjects, resolvedAfterScan);
    expect(apps.map((x) => x.path).sort()).toEqual(["/opt/a", "/opt/b", "/opt/c"]);
    expect(apps.find((x) => x.path === "/opt/b")?.scanState).toBe("missing");
  });

  it("重扫结果里完全没有 B，且 confirmedProjects 有 B 快照 → 仍显示 B（missing）", () => {
    const a = candidate({ path: "/opt/a" });
    const b = candidate({ path: "/opt/b" });
    const confirmedProjects = [confirmedOf(a, "active"), confirmedOf(b, "missing")];
    // 本次扫描只有 A（B 连 confirmed 候选都没有）。
    const resolved = [{ ...a, review: "confirmed" as const }];
    const apps = mergeApplications(confirmedProjects, resolved);
    expect(apps.map((x) => x.path)).toContain("/opt/b");
    expect(apps.find((x) => x.path === "/opt/b")?.confirmedMissing).toBe(true);
  });

  it("确认后本地 upsert：无需重进页面，confirmedProjects 立即包含新确认项", () => {
    const existing = confirmedOf(candidate({ path: "/opt/a" }));
    const newly = candidate({ path: "/opt/b" });
    const next = upsertConfirmedLocally([existing], newly, "s1", 1234);
    expect(next).toHaveLength(2);
    const record = next.find((r) => r.canonical_path === "/opt/b");
    expect(record).toBeDefined();
    expect(record?.scan_state).toBe("active");
    // 快照可解析回候选（渲染用）。
    expect(record?.candidate?.path).toBe("/opt/b");
    // 重复确认同一路径 → 覆盖不新增。
    const again = upsertConfirmedLocally(next, newly, "s1", 5678);
    expect(again).toHaveLength(2);
    expect(again.filter((r) => r.canonical_path === "/opt/b")).toHaveLength(1);
  });

  it("撤销确认 / 忽略后本地移除，项目从当前页面消失", () => {
    const a = confirmedOf(candidate({ path: "/opt/a" }));
    const b = confirmedOf(candidate({ path: "/opt/b" }));
    expect(removeConfirmedLocally([a, b], "/opt/a").map((r) => r.canonical_path)).toEqual([
      "/opt/b",
    ]);
  });

  it("人工合并的子目录不单独成行，父候选保留（问题4）", () => {
    const parent = candidate({ path: "/opt/parent" });
    const child = candidate({ path: "/opt/parent/child", merged_into: "/opt/parent" });
    const confirmedProjects = [confirmedOf(parent)];
    const resolved = [
      { ...parent, review: "confirmed" as const },
      { ...child, review: "pending" as const },
    ];
    const apps = mergeApplications(confirmedProjects, resolved);
    expect(apps.map((x) => x.path)).toEqual(["/opt/parent"]);
  });

  it("被人工合并的已确认项目也不单独成行（快照标注）", () => {
    const parent = candidate({ path: "/opt/parent" });
    const child = candidate({ path: "/opt/child" });
    const mergedSnapshot = confirmedOf(child);
    // 快照候选带上 merged_into（确认后又合并的场景）。
    mergedSnapshot.candidate = { ...child, merged_into: "/opt/parent" };
    const resolved = [
      { ...parent, review: "confirmed" as const },
      { ...child, review: "confirmed" as const, merged_into: "/opt/parent" },
    ];
    const apps = mergeApplications([confirmedOf(parent), mergedSnapshot], resolved);
    expect(apps.map((x) => x.path)).toEqual(["/opt/parent"]);
  });
});
