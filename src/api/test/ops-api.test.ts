import { describe, expect, it } from "vitest";
import {
  deployStatusLabel,
  priorityLabel,
  projectSteps,
  type ProjectRecord,
} from "@/api/ops-api";

/**
 * The helpers here are the ones the P3 views lean on to turn stored data into
 * something displayable. They are pure, so they are tested directly.
 *
 * Note what is deliberately *not* here: nothing in this module builds a shell
 * command. Every management call passes structured identifiers and Rust turns
 * those into fixed commands (see `src-tauri/src/safe.rs`).
 */
function project(commandsJson: string): ProjectRecord {
  return {
    id: "p1",
    name: "app",
    description: "",
    server_id: "s1",
    repo_url: "",
    branch: "main",
    deploy_path: "/var/www/app",
    commands_json: commandsJson,
    status: "idle",
    created_at: 1,
    updated_at: 1,
  };
}

describe("projectSteps", () => {
  it("reads a normal step list", () => {
    expect(projectSteps(project('["git pull --ff-only","npm run build"]'))).toEqual([
      "git pull --ff-only",
      "npm run build",
    ]);
  });

  it("returns an empty list for an empty project", () => {
    expect(projectSteps(project("[]"))).toEqual([]);
  });

  it("does not throw on malformed JSON", () => {
    // A record edited by hand (or by an older version) must not crash the view.
    expect(projectSteps(project("not json"))).toEqual([]);
    expect(projectSteps(project(""))).toEqual([]);
  });

  it("drops non-string entries instead of rendering them", () => {
    // `commands` is declared as string[]; anything else is corrupt data.
    const steps = projectSteps(project('["git pull",42,null,{"a":1},"npm ci"]'));
    expect(steps).toEqual(["git pull", "npm ci"]);
  });

  it("keeps a single step", () => {
    expect(projectSteps(project('["git pull --ff-only"]'))).toEqual(["git pull --ff-only"]);
  });
});

describe("priorityLabel", () => {
  it("names every syslog priority", () => {
    expect(priorityLabel(0)).toBe("Emergency");
    expect(priorityLabel(1)).toBe("Alert");
    expect(priorityLabel(2)).toBe("Critical");
    expect(priorityLabel(3)).toBe("Error");
    expect(priorityLabel(4)).toBe("Warning");
    expect(priorityLabel(5)).toBe("Notice");
    expect(priorityLabel(6)).toBe("Info");
    expect(priorityLabel(7)).toBe("Debug");
  });

  it("falls back for anything unexpected", () => {
    // journald only defines 0..7, but a corrupt record must still render.
    expect(priorityLabel(99)).toBe("Other");
    expect(priorityLabel(-1)).toBe("Other");
  });
});

describe("deployStatusLabel", () => {
  it("labels the three states the engine produces", () => {
    expect(deployStatusLabel("running")).toBe("In Progress");
    expect(deployStatusLabel("success")).toBe("Success");
    expect(deployStatusLabel("failed")).toBe("Failed");
  });

  it("shows an unknown status verbatim rather than hiding it", () => {
    expect(deployStatusLabel("queued")).toBe("queued");
  });
});
