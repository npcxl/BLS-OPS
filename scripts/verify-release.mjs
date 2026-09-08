#!/usr/bin/env node
/**
 * Release verification — runs the checks that a published release must pass
 * **before** it is announced. Everything here is read-only and fails loudly.
 *
 * Automated here (1–5 of the release checklist):
 *   1. latest.json is valid JSON;
 *   2. it carries a `windows-x86_64-nsis` entry;
 *   3. its URL returns an **MZ** executable (PE header) when fetched with
 *      `Accept: application/octet-stream`;
 *   4. the download's SHA-256 matches the GitHub asset digest;
 *   5. the `.sig` verifies against the **public key in tauri.conf.json**.
 *
 * Manual (6–10): clean-Windows install of the previous version, in-place
 * update, app really exits / installs / relaunches, version shows the new
 * number, Defender enabled — see docs/p5.1-updater.md.
 *
 * Usage:
 *   node scripts/verify-release.mjs [tag]          # tag defaults to latest
 *   GITHUB_TOKEN=… node scripts/verify-release.mjs  # private releases
 *
 * Exits non-zero on the first failed check.
 */
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

const REPO = process.env.GITHUB_REPOSITORY ?? "npcxl/BLS-OPS";
const CONF = "src-tauri/tauri.conf.json";
const failures = [];
const notes = [];

const api = (path) =>
  JSON.parse(
    execFileSync("gh", ["api", `repos/${REPO}/${path}`], { encoding: "utf8", maxBuffer: 1 << 26 }),
  );

function pass(message) {
  console.log(`  ok   ${message}`);
}
function fail(message) {
  failures.push(message);
  console.log(`  FAIL ${message}`);
}

async function main() {
  const tag =
    process.argv[2] ?? (await api("releases/latest").then((r) => r.tag_name).catch(() => null));
  if (!tag) {
    console.error("no tag given and no latest release found");
    process.exit(1);
  }
  console.log(`verifying ${REPO} ${tag}\n`);

  // 1 + 2 — manifest shape.
  const release = await api(`releases/tags/${tag}`);
  const asset = (name) => release.assets.find((a) => a.name === name);
  const manifestAsset = asset("latest.json");
  if (!manifestAsset) {
    fail("latest.json is not attached to the release");
    return report();
  }

  const dir = await mkdtemp(join(tmpdir(), "bls-verify-"));
  try {
    const manifestPath = join(dir, "latest.json");
    execFileSync("gh", ["release", "download", tag, "--pattern", "latest.json", "--dir", dir], {
      stdio: "ignore",
    });
    let manifest;
    try {
      manifest = JSON.parse((await readFile(manifestPath, "utf8")).replace(/^\uFEFF/, ""));
      pass("latest.json is valid JSON");
    } catch (cause) {
      fail(`latest.json is not valid JSON: ${cause.message}`);
      return report();
    }

    const entry = manifest.platforms?.["windows-x86_64-nsis"];
    if (!entry?.url) {
      fail("latest.json has no windows-x86_64-nsis entry");
      return report();
    }
    pass("windows-x86_64-nsis entry present");

    // 3 — the URL must serve a PE binary, not metadata JSON.
    const response = await fetch(entry.url, {
      headers: { Accept: "application/octet-stream" },
      redirect: "follow",
    });
    if (!response.ok) {
      fail(`asset URL returned HTTP ${response.status}`);
      return report();
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length < 2 || bytes[0] !== 0x4d || bytes[1] !== 0x5a) {
      fail(`asset URL did not return an MZ executable (first bytes: ${bytes.subarray(0, 4).toString("hex")})`);
      return report();
    }
    pass(`asset URL returns an MZ executable (${bytes.length} bytes)`);

    // 4 — hash must equal the digest GitHub computed for the asset.
    const fileName = decodeURIComponent(entry.url.split("/").pop() ?? "");
    const githubAsset = asset(fileName);
    const digest = githubAsset?.digest;
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    if (!digest) {
      notes.push(`no GitHub digest for ${fileName} — skipped the hash cross-check`);
    } else if (!digest.endsWith(sha256)) {
      fail(`sha256 mismatch: downloaded ${sha256}, GitHub says ${digest}`);
    } else {
      pass("downloaded SHA-256 matches the GitHub asset digest");
    }

    // 5 — minisign signature against the bundled public key.
    const pubkey = JSON.parse((await readFile(CONF, "utf8")).replace(/^\uFEFF/, "")).plugins
      ?.updater?.pubkey;
    if (!pubkey) {
      fail("tauri.conf.json has no updater pubkey");
      return report();
    }
    const sigUrl = `${entry.url}.sig`;
    const sigResponse = await fetch(sigUrl, {
      headers: { Accept: "application/octet-stream" },
      redirect: "follow",
    });
    if (!sigResponse.ok) {
      fail(`signature is not downloadable (HTTP ${sigResponse.status})`);
      return report();
    }
    const sigText = (await sigResponse.text()).trim();
    const pubkeyPath = join(dir, "pubkey.pub");
    await writeText(pubkeyPath, `${Buffer.from(pubkey, "base64").toString("utf8")}\n`);
    const sigPath = join(dir, "asset.sig");
    await writeText(sigPath, sigText);
    const binPath = join(dir, "asset.bin");
    await writeBinary(binPath, bytes);
    try {
      // `minisign -Vm <file> -p <pubkey> -x <sig>` verifies without a secret key.
      execFileSync("minisign", ["-Vm", binPath, "-p", pubkeyPath, "-x", sigPath], {
        stdio: "pipe",
      });
      pass("signature verifies against the tauri.conf.json public key");
    } catch (cause) {
      const stderr = cause.stderr?.toString?.() ?? cause.message;
      fail(`signature verification failed: ${stderr.trim().split("\n")[0]}`);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }

  report();
}

async function writeText(path, text) {
  const { writeFile } = await import("node:fs/promises");
  await writeFile(path, text);
}
async function writeBinary(path, bytes) {
  const { writeFile } = await import("node:fs/promises");
  await writeFile(path, bytes);
}

function report() {
  console.log("");
  for (const note of notes) console.log(`  note ${note}`);
  console.log("\nmanual steps still required (Windows VM, Defender on):");
  console.log("  6. install the PREVIOUS version on a clean VM");
  console.log("  7. run the in-app update to this version");
  console.log("  8. confirm the app exits, installs and relaunches");
  console.log("  9. confirm the version now shows this release");
  console.log(" 10. repeat with Windows Defender enabled");
  if (failures.length > 0) {
    console.error(`\n${failures.length} check(s) FAILED`);
    process.exit(1);
  }
  console.log("\nall automated checks passed");
}

await main();
