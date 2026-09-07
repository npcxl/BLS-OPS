#!/usr/bin/env node
/**
 * Single source of truth for the release version.
 *
 * A Tauri app carries its version in four places; if they drift, the updater
 * compares the wrong numbers (or refuses to update at all). The release
 * workflow runs this **before** building, so a forgotten bump fails fast.
 *
 * Usage:
 *   node scripts/check-versions.mjs                 # compare the four sources
 *   EXPECTED_VERSION=0.1.1 node scripts/check-versions.mjs   # + git tag match
 *
 * Exits 1 with every mismatch listed; never tries to "fix" anything.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (relative) => readFileSync(join(root, relative), "utf8");

/** `[package] version` in Cargo.toml — not the version of a dependency. */
function cargoPackageVersion(toml) {
  const lines = toml.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === "[package]");
  if (start < 0) return null;
  for (const line of lines.slice(start + 1)) {
    if (line.trim().startsWith("[")) break;
    const match = /^version\s*=\s*"([^"]+)"/.exec(line.trim());
    if (match) return match[1];
  }
  return null;
}

function cargoLockVersion(lock, packageName) {
  const lines = lock.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index].trim() !== `name = "${packageName}"`) continue;
    const match = /^version\s*=\s*"([^"]+)"/.exec(lines[index + 1]?.trim() ?? "");
    if (match) return match[1];
  }
  return null;
}

/** Strips semver range markers so `^2.11.0`, `=2.11.0` and `2.11.0` compare equal. */
function bare(value) {
  return String(value).replace(/^[\^~=><]+\s*/, "").trim();
}

const pkg = JSON.parse(read("package.json"));
const conf = JSON.parse(read("src-tauri/tauri.conf.json"));
const cargoToml = read("src-tauri/Cargo.toml");
const cargoLock = read("src-tauri/Cargo.lock");

const sources = [
  ["package.json", pkg.version],
  ["src-tauri/Cargo.toml", cargoPackageVersion(cargoToml)],
  ["src-tauri/tauri.conf.json", conf.version],
  ["src-tauri/Cargo.lock", cargoLockVersion(cargoLock, "ops-workbench")],
];

const errors = [];
const distinct = new Set(sources.map(([, value]) => value));

if (distinct.size > 1) {
  errors.push(
    `version mismatch:\n${sources
      .map(([label, value]) => `  - ${label}: ${value ?? "<missing>"}`)
      .join("\n")}`,
  );
}

const expected = process.env.EXPECTED_VERSION?.trim();
if (expected && bare(expected) !== sources[0][1]) {
  errors.push(`git tag '${expected}' does not match package version '${sources[0][1]}'`);
}

/*
 * Plugin versions must match across the IPC boundary: a JS client speaking to a
 * Rust plugin from a different minor can call commands that no longer exist.
 */
const pluginPairs = [
  ["@tauri-apps/plugin-updater", "tauri-plugin-updater"],
  ["@tauri-apps/plugin-process", "tauri-plugin-process"],
  ["@tauri-apps/plugin-dialog", "tauri-plugin-dialog"],
];

for (const [jsName, crateName] of pluginPairs) {
  const js = bare(pkg.dependencies?.[jsName]);
  const rust = bare(new RegExp(`${crateName}\\s*=\\s*\\{\\s*version\\s*=\\s*"([^"]+)"`).exec(cargoToml)?.[1] ?? "");
  if (!js || !rust) continue;
  if (js !== rust) {
    errors.push(`plugin version drift: ${jsName}@${js} vs ${crateName}@${rust}`);
  }
}

if (errors.length > 0) {
  console.error(`\n[check-versions] ${errors.length} problem(s):\n`);
  for (const error of errors) console.error(`  ${error}\n`);
  process.exit(1);
}

console.log(`[check-versions] all versions agree: v${sources[0][1]}`);
