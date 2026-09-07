#!/usr/bin/env node
/**
 * Release version bump — the only supported way to change the app version.
 *
 * `package.json` is the single input; every other copy is derived from it:
 *
 *   package.json  →  src-tauri/Cargo.toml (`[package] version`)
 *                 →  src-tauri/tauri.conf.json (`version`)
 *                 →  src-tauri/Cargo.lock (`ops-workbench` entry)
 *                 →  pnpm-lock.yaml (nothing to do: the app is `private`)
 *
 * Usage:
 *   node scripts/bump-version.mjs patch            # 0.1.0 → 0.1.1
 *   node scripts/bump-version.mjs minor            # 0.1.0 → 0.2.0
 *   node scripts/bump-version.mjs major            # 0.1.0 → 1.0.0
 *   node scripts/bump-version.mjs 0.2.3            # explicit version
 *   DRY_RUN=1 node scripts/bump-version.mjs patch  # print, write nothing
 *
 * Prints the new version on the last stdout line (prefixed with `version=`) so
 * a CI step can capture it without re-parsing the files:
 *
 *   node scripts/bump-version.mjs "$LEVEL" | tee bump.log
 *   echo "version=$(sed -n 's/^version=//p' bump.log | tail -n1)" >> "$GITHUB_OUTPUT"
 *
 * Refuses to run on a dirty or non-SemVer version, and never touches git.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const path = (relative) => join(root, relative);
const read = (relative) => readFileSync(path(relative), "utf8");
const dryRun = process.env.DRY_RUN === "1";

/** Keeps CRLF files CRLF — rewriting them wholesale would bury the real diff. */
const eolOf = (source) => (source.includes("\r\n") ? "\r\n" : "\n");

const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/;

function fail(message) {
  console.error(`[bump-version] ${message}`);
  process.exit(1);
}

/** SemVer increment. Pre-release/build metadata is not supported on purpose. */
function nextVersion(current, level) {
  const match = SEMVER.exec(current);
  if (!match) fail(`current version '${current}' is not plain SemVer (X.Y.Z)`);

  const [major, minor, patch] = match.slice(1).map(Number);
  if (level === "major") return `${major + 1}.0.0`;
  if (level === "minor") return `${major}.${minor + 1}.0`;
  if (level === "patch") return `${major}.${minor}.${patch + 1}`;
  if (SEMVER.test(level)) return level;
  fail(`unknown level '${level}' — expected patch, minor, major or X.Y.Z`);
}

const level = process.argv[2];
if (!level) fail("missing level: patch | minor | major | X.Y.Z");

const pkgPath = path("package.json");
const pkg = JSON.parse(read("package.json"));
const target = nextVersion(pkg.version, level);

if (target === pkg.version) fail(`'${level}' would not change version ${pkg.version}`);

/*
 * Cargo.toml: only the `[package]` table's version, never a dependency's.
 * Written as a targeted replacement so the rest of the file (formatting,
 * comments, dependency order) is untouched.
 */
function bumpCargoToml(source, version) {
  const eol = eolOf(source);
  const lines = source.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === "[package]");
  if (start < 0) fail("no [package] table in src-tauri/Cargo.toml");

  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.trim().startsWith("[")) break;
    if (/^version\s*=\s*"/.test(line.trim())) {
      lines[index] = line.replace(/^(\s*version\s*=\s*")[^"]+(".*)$/, `$1${version}$2`);
      return lines.join(eol);
    }
  }
  fail("no version field under [package] in src-tauri/Cargo.toml");
}

/* Cargo.lock: the `ops-workbench` package entry, which is our own crate. */
function bumpCargoLock(source, version) {
  const eol = eolOf(source);
  const lines = source.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index].trim() !== 'name = "ops-workbench"') continue;
    if (!/^version\s*=\s*"/.test((lines[index + 1] ?? "").trim())) continue;
    lines[index + 1] = lines[index + 1].replace(/^(\s*version\s*=\s*")[^"]+(".*)$/, `$1${version}$2`);
    return lines.join(eol);
  }
  fail("no ops-workbench entry in src-tauri/Cargo.lock — run `cargo check` first");
}

/*
 * tauri.conf.json: `version` sits at the top level. Re-serialising the whole
 * file with JSON.stringify would reorder and reformat it, so only the one key
 * is patched with a regex that tolerates the existing indentation.
 */
function bumpTauriConf(source, version) {
  const next = source.replace(/("version"\s*:\s*")[^"]+(")/, `$1${version}$2`);
  if (next === source) fail("could not find the top-level \"version\" in tauri.conf.json");
  return next;
}

const pkgSource = read("package.json");
const edits = [
  ["package.json", JSON.stringify({ ...pkg, version: target }, null, 2) + eolOf(pkgSource)],
  ["src-tauri/Cargo.toml", bumpCargoToml(read("src-tauri/Cargo.toml"), target)],
  ["src-tauri/Cargo.lock", bumpCargoLock(read("src-tauri/Cargo.lock"), target)],
  ["src-tauri/tauri.conf.json", bumpTauriConf(read("src-tauri/tauri.conf.json"), target)],
];

for (const [label, content] of edits) {
  if (!dryRun) writeFileSync(path(label), content, "utf8");
}

console.log(`[bump-version] ${pkg.version} → ${target} (${dryRun ? "dry run" : "written"})`);
for (const [label] of edits) console.log(`  - ${label}`);
console.log(`version=${target}`);
