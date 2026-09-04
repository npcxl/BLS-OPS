/**
 * Server list grouping — the single source of truth for how servers are
 * bucketed, sorted and surfaced in every sidebar (终端 / 项目 / 服务 / 日志).
 *
 * The rule that matters: **groups are the primary data, servers are looked up
 * by `group_id`.** Bucketing by iterating `servers` (what the sidebars used to
 * do) makes an empty group unreachable — it has no server to create a bucket
 * from — so a freshly created group silently disappeared until a server was
 * moved into it.
 *
 * Kept free of React and of the store so the ordering rules can be unit-tested
 * directly.
 */
import { i18n } from "@/i18n";
import type { ServerGroupRecord, ServerRecord } from "@/api/types/servers";

/** Synthetic id for servers with no group. Never persisted. */
export const UNGROUPED_ID = "__ungrouped__";
/** i18n key（natural keys）：纯 TS 模块不能 hook，渲染处 t() / i18n.t()。 */
export const UNGROUPED_LABEL = "Ungrouped";

export interface ServerGroupSection {
  /** Real group id, or {@link UNGROUPED_ID}. */
  id: string;
  name: string;
  /** `null` for the synthetic 未分组 section. */
  group: ServerGroupRecord | null;
  /** Sorted: favorite first, then by name. */
  servers: ServerRecord[];
}

export interface ServerSections {
  /** Shortcut entries only — these servers stay in their own section too. */
  favorites: ServerRecord[];
  /** Every group, including empty ones, ordered by `sort_order` then name. */
  groups: ServerGroupSection[];
  /** Always last; also collects servers pointing at a deleted group. */
  ungrouped: ServerGroupSection;
  /** Human-readable data problems to surface in the UI. */
  warnings: string[];
}

const byName = (a: string, b: string) => a.localeCompare(b, "zh-Hans-CN");

/** favorite DESC, then name ASC. Ties fall back to id so order is stable. */
export function compareServers(a: ServerRecord, b: ServerRecord): number {
  if (a.favorite !== b.favorite) return a.favorite ? -1 : 1;
  return byName(a.name, b.name) || byName(a.id, b.id);
}

/** `sort_order` ASC, then name ASC. */
export function compareGroups(a: ServerGroupRecord, b: ServerGroupRecord): number {
  if (a.sort_order !== b.sort_order) return a.sort_order - b.sort_order;
  return byName(a.name, b.name) || byName(a.id, b.id);
}

/** Normalises the three "no group" spellings the DB and forms can produce. */
function groupIdOf(server: ServerRecord): string | null {
  const raw = server.group_id;
  return raw && raw.trim() !== "" ? raw : null;
}

export function buildServerSections(
  servers: ServerRecord[],
  groups: ServerGroupRecord[],
): ServerSections {
  const known = new Map(groups.map((group) => [group.id, group]));
  const perGroup = new Map<string, ServerRecord[]>();
  const orphans: ServerRecord[] = [];
  const missing = new Map<string, string[]>();

  for (const server of servers) {
    const groupId = groupIdOf(server);
    if (groupId === null) {
      orphans.push(server);
      continue;
    }
    // A server can outlive its group (group deleted outside this session, an
    // imported record, …). It must still be reachable, so it lands in 未分组
    // and the situation is reported instead of being silently dropped.
    if (!known.has(groupId)) {
      orphans.push(server);
      const bucket = missing.get(groupId);
      if (bucket) bucket.push(server.name);
      else missing.set(groupId, [server.name]);
      continue;
    }
    const bucket = perGroup.get(groupId);
    if (bucket) bucket.push(server);
    else perGroup.set(groupId, [server]);
  }

  // 纯 TS 模块没有 hook，用 i18n.t（渲染期间调用拿到当前语言）。
  // 插值占位只用 {{name}}/{{count}}，服务器名单不再拼进文案。
  const warnings = [...missing.entries()].map(([groupId, names]) =>
    i18n.t("Group {{name}} does not exist, {{count}} servers moved to Ungrouped", {
      name: groupId,
      count: names.length,
    }),
  );

  return {
    favorites: servers.filter((server) => server.favorite).sort(compareServers),
    groups: [...groups]
      .sort(compareGroups)
      .map((group) => ({
        id: group.id,
        name: group.name,
        group,
        servers: [...(perGroup.get(group.id) ?? [])].sort(compareServers),
      })),
    ungrouped: {
      id: UNGROUPED_ID,
      name: UNGROUPED_LABEL,
      group: null,
      servers: orphans.sort(compareServers),
    },
    warnings,
  };
}

/** Every section in render order: 收藏 first, then groups, 未分组 last. */
export function serverSectionsInOrder(sections: ServerSections): ServerGroupSection[] {
  return [...sections.groups, sections.ungrouped];
}
