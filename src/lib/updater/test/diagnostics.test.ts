import { describe, expect, it } from "vitest";
import { buildUpdateDiagnostics } from "../diagnostics";
import type { UpdateError } from "@/api/types/updater";

const error: UpdateError = {
  code: "install_failed",
  detail: "failed to write C:\\Users\\alice\\AppData\\Local\\Temp\\x (access denied)",
  stage: "install",
  at: "2026-09-08T10:00:00.000Z",
};

/**
 * The bundle is pasted into GitHub issues, so the redaction rules are asserted
 * as **negative** expectations: no username, no home path, no token, no
 * signature blob — even when the original error carried all of them.
 */
describe("buildUpdateDiagnostics", () => {
  it("includes every field the issue template asks for", () => {
    const text = buildUpdateDiagnostics({
      currentVersion: "0.1.3",
      targetVersion: "0.1.4",
      os: "windows",
      arch: "x86_64",
      stage: "install",
      error,
      manifestUrl: "https://github.com/npcxl/BLS-OPS/releases/latest/download/latest.json",
      lastCheckedAt: Date.parse("2026-09-08T09:59:00.000Z"),
      now: new Date("2026-09-08T10:00:30.000Z"),
    });

    expect(text).toContain("current version: v0.1.3");
    expect(text).toContain("target version: v0.1.4");
    expect(text).toContain("os: windows");
    expect(text).toContain("arch: x86_64");
    expect(text).toContain("stage: install");
    expect(text).toContain("error code: install_failed");
    expect(text).toContain("error stage: install");
    expect(text).toContain("error time: 2026-09-08T10:00:00.000Z");
    expect(text).toContain("manifest: https://github.com/npcxl/BLS-OPS/releases/latest/download/latest.json");
    expect(text).toContain("last checked: 2026-09-08T09:59:00.000Z");
    expect(text).toContain("generated: 2026-09-08T10:00:30.000Z");
  });

  it("never leaks a username, a home path, a token or a signature", () => {
    const text = buildUpdateDiagnostics({
      currentVersion: "0.1.3",
      targetVersion: "0.1.4",
      os: "windows",
      arch: "x86_64",
      stage: "download",
      error: {
        code: "unknown",
        detail:
          "download ?token=abc123 failed: RWQf6LRCGA9i53mlYecO4IzT51TGPpvWucNCh3l0PQZ2nLHwBLzUaGVsbG8gd29ybGQ= at /home/alice/x",
        stage: "download",
        at: "2026-09-08T10:00:00.000Z",
      },
      manifestUrl: "https://github.com/npcxl/BLS-OPS/releases/latest/download/latest.json",
      lastCheckedAt: null,
    });

    expect(text).not.toContain("alice");
    expect(text).not.toContain("abc123");
    expect(text).not.toContain("RWQf6LRCGA9i53mlYecO4IzT51TGPpvWucNCh3l0PQZ2nLHwBLzUaGVsbG8gd29ybGQ=");
    expect(text).toContain("<redacted>");
    expect(text).toContain("<blob>");
  });

  it("renders — for missing values and omits the error block when healthy", () => {
    const text = buildUpdateDiagnostics({
      currentVersion: null,
      targetVersion: null,
      os: null,
      arch: null,
      stage: null,
      error: null,
      manifestUrl: null,
      lastCheckedAt: null,
    });

    expect(text).toContain("current version: —");
    expect(text).not.toContain("error code");
  });
});
