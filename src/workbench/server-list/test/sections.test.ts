import { describe, expect, it } from "vitest";
import type { ServerGroupRecord, ServerRecord } from "@/api/types/servers";
import {
  UNGROUPED_ID,
  buildServerSections,
  compareServers,
  serverSectionsInOrder,
} from "../sections";

function server(id: string, overrides: Partial<ServerRecord> = {}): ServerRecord {
  return {
    id,
    name: id,
    host: `${id}.local`,
    port: 22,
    username: "root",
    credential_id: null,
    group_id: null,
    tags: [],
    proxy_jump_id: null,
    favorite: false,
    last_connected_at: null,
    status: "idle",
    created_at: 0,
    updated_at: 0,
    ...overrides,
  };
}

function group(id: string, name: string, sort_order = 0): ServerGroupRecord {
  return { id, name, sort_order, created_at: 0, updated_at: 0 };
}

const names = (items: ServerRecord[]) => items.map((item) => item.name);

describe("buildServerSections", () => {
  it("renders a group that has no servers at all", () => {
    const sections = buildServerSections([server("s1")], [group("g1", "生产环境")]);

    const production = sections.groups.find((item) => item.id === "g1");
    expect(production).toBeDefined();
    expect(production?.servers).toHaveLength(0);
    expect(production?.name).toBe("生产环境");
  });

  it("keeps every empty group, not just the ones with servers", () => {
    const sections = buildServerSections([], [group("g1", "A 组"), group("g2", "B 组")]);

    expect(sections.groups.map((item) => item.id)).toEqual(["g1", "g2"]);
    expect(sections.groups.every((item) => item.servers.length === 0)).toBe(true);
  });

  it("orders groups by sort_order then name", () => {
    const sections = buildServerSections([], [
      group("g2", "B 组", 2),
      group("g1", "A 组", 1),
      group("g3", "A 组", 1),
    ]);

    expect(sections.groups.map((item) => item.id)).toEqual(["g1", "g3", "g2"]);
  });

  it("puts 未分组 last, after every named group", () => {
    const sections = buildServerSections([server("s1")], [group("g1", "生产环境")]);

    const order = serverSectionsInOrder(sections).map((item) => item.id);
    expect(order).toEqual(["g1", UNGROUPED_ID]);
    // 未分组 is still returned even when it is empty.
    expect(sections.ungrouped.servers.map((item) => item.name)).toEqual(["s1"]);
  });

  it("falls back to 未分组 — with a warning — when group_id no longer exists", () => {
    const sections = buildServerSections([server("s1", { group_id: "ghost" })], [
      group("g1", "生产环境"),
    ]);

    expect(sections.ungrouped.servers.map((item) => item.name)).toEqual(["s1"]);
    expect(sections.warnings).toHaveLength(1);
    expect(sections.warnings[0]).toContain("ghost");
    expect(sections.warnings[0]).toContain("s1");
    expect(sections.groups.find((item) => item.id === "g1")?.servers).toHaveLength(0);
  });

  it("groups one warning per missing group, not per server", () => {
    const sections = buildServerSections(
      [server("s1", { group_id: "ghost" }), server("s2", { group_id: "ghost" })],
      [],
    );

    expect(sections.warnings).toHaveLength(1);
    expect(sections.warnings[0]).toContain("2 台");
  });

  it("treats an empty-string group_id as 未分组", () => {
    const sections = buildServerSections([server("s1", { group_id: "" })], []);
    expect(sections.ungrouped.servers).toHaveLength(1);
    expect(sections.warnings).toHaveLength(0);
  });

  it("sorts a group's servers favorite-first, then by name", () => {
    const sections = buildServerSections(
      [
        server("zeta", { group_id: "g1" }),
        server("alpha", { group_id: "g1", favorite: true }),
        server("beta", { group_id: "g1", favorite: true }),
      ],
      [group("g1", "生产环境")],
    );

    expect(names(sections.groups[0].servers)).toEqual(["alpha", "beta", "zeta"]);
  });

  it("lists favorites as shortcuts without removing them from their group", () => {
    const sections = buildServerSections(
      [
        server("s1", { group_id: "g1", favorite: true }),
        server("s2", { group_id: "g1" }),
        server("s3", { favorite: true }),
      ],
      [group("g1", "生产环境")],
    );

    expect(names(sections.favorites)).toEqual(["s1", "s3"]);
    // Still present under its own group — the favorites area is a shortcut.
    expect(names(sections.groups[0].servers)).toEqual(["s1", "s2"]);
    expect(names(sections.ungrouped.servers)).toEqual(["s3"]);
  });

  it("drops servers from 收藏 as soon as they are unfavorited", () => {
    const withFavorite = buildServerSections([server("s1", { favorite: true })], []);
    expect(withFavorite.favorites).toHaveLength(1);

    const without = buildServerSections([server("s1", { favorite: false })], []);
    expect(without.favorites).toHaveLength(0);
  });

  it("compareServers is stable for equal names and favorites", () => {
    const a = server("a", { favorite: true });
    const b = server("b", { favorite: true });
    expect(compareServers(a, b)).toBeLessThan(0);
    expect(compareServers(a, a)).toBe(0);
  });
});
