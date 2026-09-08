import { describe, expect, it } from "vitest";
import { classifyUpdateError, sanitizeUpdateDetail } from "../errors";

/**
 * The Tauri updater surfaces Rust errors as free-form strings. These cases pin
 * the mapping from message → user-facing code, including the ones that must
 * never be mis-reported (a signature failure is not "no network").
 */
describe("classifyUpdateError", () => {
  it("maps offline / DNS failures to network", () => {
    expect(classifyUpdateError("error sending request for url: dns error").code).toBe("network");
    expect(classifyUpdateError(new Error("Network is unreachable (os error 11001)")).code).toBe("network");
  });

  it("maps timeouts to timeout", () => {
    expect(classifyUpdateError("request timed out after 30s").code).toBe("timeout");
  });

  it("maps a broken manifest to malformed_manifest", () => {
    expect(classifyUpdateError("invalid json: expected value at line 1").code).toBe("malformed_manifest");
  });

  // Regression: a repo that has never published a release answers 404, and
  // tauri-plugin-updater reports that as `ReleaseNotFound` → "Could not fetch
  // a valid release JSON from the remote". The word "JSON" used to route this
  // to `malformed_manifest`, so a first-run user saw "the update information
  // is malformed" instead of "nothing has been published yet".
  it.each([
    "Could not fetch a valid release JSON from the remote",
    "https://github.com/npcxl/BLS-OPS/releases/latest/download/latest.json: 404 Not Found",
    "release not found",
  ])("maps a missing release to no_release, never to malformed_manifest: %s", (raw) => {
    expect(classifyUpdateError(raw).code).toBe("no_release");
  });

  it("maps a release without an asset for this platform to no_platform_asset", () => {
    expect(classifyUpdateError("no release asset found for target windows-x86_64").code).toBe(
      "no_platform_asset",
    );
  });

  it("maps a missing signature to signature_missing", () => {
    expect(classifyUpdateError("signature not found for the update package").code).toBe("signature_missing");
  });

  it("maps a bad signature to signature_invalid, never to network", () => {
    expect(classifyUpdateError("failed to verify signature: invalid signature").code).toBe(
      "signature_invalid",
    );
  });

  it("maps a broken transfer to download_interrupted", () => {
    expect(classifyUpdateError("download interrupted: connection reset by peer").code).toBe(
      "download_interrupted",
    );
  });

  it("maps a full disk to disk_full", () => {
    expect(classifyUpdateError("failed to write: no space left on device (os error 112)").code).toBe(
      "disk_full",
    );
  });

  it("maps installer failures to install_failed", () => {
    expect(classifyUpdateError("failed to install update: installer exited with code 2").code).toBe(
      "install_failed",
    );
  });

  it("maps user cancellation to cancelled", () => {
    expect(classifyUpdateError("update cancelled by user").code).toBe("cancelled");
  });

  it("maps a dev build to unsupported_build", () => {
    expect(classifyUpdateError("Updater is disabled in dev mode").code).toBe("unsupported_build");
  });

  it.each([
    // Windows / Tauri installer failures that used to fall through to unknown.
    ["failed to extract the update archive", "install_failed"],
    ["failed to spawn installer process", "install_failed"],
    ["failed to execute the installer", "install_failed"],
    ["ShellExecuteW returned 5", "install_failed"],
    ["access denied writing the update", "install_failed"],
    ["permission denied", "install_failed"],
    ["elevation required", "install_failed"],
    ["the installer exited with code 2", "install_failed"],
    ["failed to create temporary file (os error 5)", "install_failed"],
    ["failed to rename/replace the executable (os error 5)", "install_failed"],
    ["file not found (os error 2)", "install_failed"],
    ["path not found", "install_failed"],
    ["blocked by antivirus", "install_failed"],
    ["blocked by security policy", "install_failed"],
    ["requires elevation (os error 740)", "install_failed"],
    ["failed to open the downloaded archive", "install_failed"],
  ])("maps %s to %s", (raw, code) => {
    expect(classifyUpdateError(raw, "install").code).toBe(code);
  });

  it("falls back to unknown instead of guessing", () => {
    expect(classifyUpdateError("something entirely new happened").code).toBe("unknown");
    expect(classifyUpdateError(undefined).code).toBe("unknown");
  });
});

describe("failure stage", () => {
  it("keeps the stage the caller reports", () => {
    expect(classifyUpdateError("boom", "check").stage).toBe("check");
    expect(classifyUpdateError("boom", "download").stage).toBe("download");
    expect(classifyUpdateError("boom", "install").stage).toBe("install");
    expect(classifyUpdateError("boom", "relaunch").stage).toBe("relaunch");
  });

  it("relabels signature failures as verify — the plugin verifies inside install", () => {
    const error = classifyUpdateError("failed to verify signature: invalid", "install");
    expect(error.code).toBe("signature_invalid");
    expect(error.stage).toBe("verify");
  });

  it("timestamps the failure for the diagnostics bundle", () => {
    const { at } = classifyUpdateError("boom", "download");
    expect(Number.isNaN(Date.parse(at))).toBe(false);
  });
});

describe("sanitizeUpdateDetail", () => {
  it("redacts the local user's home path on Windows", () => {
    expect(sanitizeUpdateDetail("failed to write C:\\Users\\alice\\AppData\\Local\\Temp\\x")).toBe(
      "failed to write C:\\Users\\<redacted>\\AppData\\Local\\Temp\\x",
    );
  });

  // Regression: an earlier version kept the captured group (the username) and
  // only hid the slash, turning /home/alice into "alice<redacted>".
  it.each([
    ["Linux", "failed to write /home/alice/.local/share/x", "failed to write /home/<redacted>/.local/share/x"],
    ["macOS", "failed to write /Users/alice/Library/x", "failed to write /Users/<redacted>/Library/x"],
  ])("redacts the home path on %s without leaking the username", (_os, input, expected) => {
    const detail = sanitizeUpdateDetail(input);
    expect(detail).toBe(expected);
    expect(detail).not.toContain("alice");
  });

  it("redacts every home path in a multi-path message", () => {
    const detail = sanitizeUpdateDetail("copy /home/alice/a to /Users/bob/b failed");
    expect(detail).toBe("copy /home/<redacted>/a to /Users/<redacted>/b failed");
    expect(detail).not.toMatch(/alice|bob/);
  });

  it("redacts tokens and signature blobs", () => {
    const detail = sanitizeUpdateDetail(
      "download failed ?token=abc123 for " +
        "RWQf6LRCGA9i53mlYecO4IzT51TGPpvWucNCh3l0PQZ2nLHwBLzUaGVsbG8gd29ybGQ=",
    );
    expect(detail).not.toContain("abc123");
    expect(detail).toContain("token=<redacted>");
    expect(detail).toContain("<blob>");
  });

  it("keeps the reason intact when there is nothing to redact", () => {
    expect(sanitizeUpdateDetail("connection reset by peer")).toBe("connection reset by peer");
  });
});
