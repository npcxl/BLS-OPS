/**
 * Regenerates `src/lib/icons/vscode-file-icons.ts` from the locally installed
 * @iconify-json/vscode-icons package — no network access.
 *
 * Only icons actually referenced by a `FileIconKey` are emitted, so the app
 * bundles a small, fully-offline icon set instead of talking to the Iconify
 * API at runtime (server file listings must render with no network).
 *
 * Each key lists candidate ids in priority order: the first one that exists
 * wins, the rest are fallbacks. The final fallback of every chain is the
 * generic file/folder icon, so a renamed upstream icon degrades visually
 * instead of breaking the build. The report below flags every fallback so
 * gaps are visible.
 *
 * vscode-icons has no terminal/lock/settings glyphs at all, so those three
 * keys (`ssh`, `ssh-config`, `lock`) fall back to the material-icon-theme
 * collection via the `material:` prefix — same offline bundling rules.
 *
 * The generic `folder` uses the fluent-emoji-flat `file-folder` glyph
 * (`fluent:` prefix): the vscode-icons folder is a dim blue-gray that reads
 * almost invisible on the app's surfaces, while the fluent one is the bright
 * yellow users know from Windows Explorer. Special folders keep their
 * vscode-icons badges for recognizability.
 *
 * Usage: pnpm icons:regen
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);

function loadCollection(pkg) {
  return JSON.parse(readFileSync(require.resolve(pkg), "utf8"));
}

const COLLECTIONS = {
  vscode: loadCollection("@iconify-json/vscode-icons/icons.json"),
  material: loadCollection("@iconify-json/material-icon-theme/icons.json"),
  fluent: loadCollection("@iconify-json/fluent-emoji-flat/icons.json"),
};

/** FileIconKey → ordered candidates (first existing one wins). */
const CHAINS = {
  // generic
  file: ["default-file"],
  folder: ["fluent:file-folder", "default-folder"],
  // special folders
  "folder-git": ["folder-type-git", "default-folder"],
  "folder-github": ["folder-type-github", "default-folder"],
  "folder-node": ["folder-type-node", "folder-type-light-node", "default-folder"],
  "folder-src": ["folder-type-src", "default-folder"],
  "folder-dist": ["folder-type-dist", "default-folder"],
  "folder-docker": ["folder-type-docker", "default-folder"],
  "folder-nginx": ["folder-type-nginx", "folder-type-config", "default-folder"],
  "folder-logs": ["folder-type-log", "default-folder"],
  "folder-config": ["folder-type-config", "default-folder"],
  "folder-backup": ["folder-type-temp", "default-folder"],
  // ssh & security (vscode-icons has no terminal/settings glyphs → material)
  ssh: ["material:console", "file-type-key", "default-file"],
  "ssh-key": ["file-type-key", "default-file"],
  "ssh-config": ["material:settings", "file-type-config", "default-file"],
  key: ["file-type-key", "default-file"],
  certificate: ["file-type-cert", "default-file"],
  // ops & deployment
  docker: ["file-type-docker", "default-file"],
  nginx: ["file-type-nginx", "file-type-config", "default-file"],
  systemd: ["file-type-systemd", "file-type-light-systemd", "file-type-config", "default-file"],
  config: ["file-type-config", "default-file"],
  makefile: ["file-type-makefile", "file-type-config", "default-file"],
  // package managers & build
  npm: ["file-type-npm", "file-type-json", "default-file"],
  yarn: ["file-type-yarn", "file-type-npm", "default-file"],
  pnpm: ["file-type-pnpm", "file-type-light-pnpm", "file-type-npm", "default-file"],
  lock: ["material:lock", "file-type-package", "default-file"],
  git: ["file-type-git", "default-file"],
  nodejs: ["file-type-node", "file-type-js", "default-file"],
  maven: ["file-type-maven", "file-type-java", "file-type-xml", "default-file"],
  gradle: ["file-type-gradle", "file-type-java", "default-file"],
  cmake: ["file-type-cmake", "file-type-config", "default-file"],
  // languages
  javascript: ["file-type-js", "file-type-js-official", "default-file"],
  typescript: ["file-type-typescript", "file-type-typescript-official", "default-file"],
  jsx: ["file-type-reactjs", "file-type-js", "default-file"],
  tsx: ["file-type-reactts", "file-type-typescript", "default-file"],
  java: ["file-type-java", "file-type-jar", "default-file"],
  rust: ["file-type-rust", "default-file"],
  go: ["file-type-go", "default-file"],
  python: ["file-type-python", "default-file"],
  php: ["file-type-php", "default-file"],
  ruby: ["file-type-ruby", "default-file"],
  csharp: ["file-type-csharp", "default-file"],
  c: ["file-type-c", "default-file"],
  cpp: ["file-type-cpp", "default-file"],
  vue: ["file-type-vue", "default-file"],
  html: ["file-type-html", "default-file"],
  css: ["file-type-css", "file-type-sass", "file-type-scss", "file-type-css2", "default-file"],
  // structured data
  json: ["file-type-json", "file-type-json2", "file-type-json-official", "default-file"],
  xml: ["file-type-xml", "default-file"],
  yaml: ["file-type-yaml", "file-type-light-yaml", "default-file"],
  toml: ["file-type-toml", "file-type-config", "default-file"],
  ini: ["file-type-ini", "file-type-config", "default-file"],
  env: ["file-type-dotenv", "file-type-config", "default-file"],
  // text & docs
  shell: ["file-type-shell", "file-type-powershell", "default-file"],
  markdown: ["file-type-markdown", "default-file"],
  sql: ["file-type-sql", "file-type-db", "default-file"],
  text: ["file-type-text", "default-file"],
  log: ["file-type-log", "file-type-text", "default-file"],
  csv: ["file-type-csv", "file-type-excel", "file-type-text", "default-file"],
  pdf: ["file-type-pdf2", "file-type-pdf", "default-file"],
  sheet: ["file-type-excel", "file-type-excel2", "default-file"],
  doc: ["file-type-word", "default-file"],
  slides: ["file-type-powerpoint", "default-file"],
  // media & binaries
  image: ["file-type-image", "file-type-image2", "default-file"],
  video: ["file-type-video", "file-type-video2", "default-file"],
  audio: ["file-type-audio", "file-type-audio2", "default-file"],
  archive: ["file-type-zip", "default-file"],
  jar: ["file-type-jar", "file-type-java", "file-type-zip", "default-file"],
  package: ["file-type-package", "file-type-debian", "file-type-zip", "default-file"],
  binary: ["file-type-binary", "default-file"],
  database: ["file-type-db", "file-type-database", "default-file"],
};

/** Resolves `collection:id` (default `vscode:`) through alias parents. */
function resolveIcon(candidate) {
  const colon = candidate.indexOf(":");
  const collection = colon >= 0 ? COLLECTIONS[candidate.slice(0, colon)] : COLLECTIONS.vscode;
  const id = colon >= 0 ? candidate.slice(colon + 1) : candidate;
  if (!collection) return null;

  const aliases = collection.aliases ?? {};
  const chain = [id];
  let name = id;
  while (!collection.icons[name] && aliases[name]) {
    name = aliases[name].parent;
    chain.push(name);
  }
  const icon = collection.icons[name];
  if (!icon) return null;
  const merged = { ...icon };
  for (const link of chain) {
    if (aliases[link]) Object.assign(merged, aliases[link]);
  }
  return {
    body: merged.body,
    width: merged.width ?? collection.width ?? collection.info?.width ?? 16,
    height: merged.height ?? collection.height ?? collection.info?.height ?? 16,
  };
}

const resolved = {};
const report = [];
for (const [key, candidates] of Object.entries(CHAINS)) {
  let picked = null;
  for (const candidate of candidates) {
    const icon = resolveIcon(candidate);
    if (icon) {
      picked = { id: candidate, ...icon };
      break;
    }
  }
  if (picked) {
    resolved[key] = picked;
    const wanted = picked.id === candidates[0] ? "" : `  (fallback; wanted ${candidates[0]})`;
    report.push(`${key.padEnd(15)} ← ${picked.id}${wanted}`);
  } else {
    report.push(`${key.padEnd(15)} ✗ none of: ${candidates.join(", ")}`);
  }
}
console.log(report.join("\n"));

const missing = Object.keys(CHAINS).filter((key) => !resolved[key]);
if (missing.length > 0) {
  console.error(`\nNo icon found for: ${missing.join(", ")}`);
  process.exit(1);
}

const entries = Object.entries(resolved)
  .map(([key, icon]) => `  ${JSON.stringify(key)}: { body: ${JSON.stringify(icon.body)}, width: ${icon.width}, height: ${icon.height} },`)
  .join("\n");

const out = `/**
 * GENERATED FILE — do not edit by hand.
 *
 * Icon data for every {@link FileIconKey}, extracted from the locally
 * installed @iconify-json/vscode-icons package (plus material-icon-theme for
 * the terminal/lock/settings glyphs vscode-icons lacks, and fluent-emoji-flat
 * for the bright yellow Windows-style folder). Only icons actually
 * referenced by the app are bundled, keeping the set small and fully offline:
 * @iconify/react renders these objects directly and never calls the Iconify
 * API, so file listings render the same with no network.
 *
 * Regenerate with: pnpm icons:regen  (mapping: scripts/generate-file-icons.mjs)
 */
import type { IconifyIcon } from "@iconify/react";
import type { FileIconKey } from "@/lib/file-kind";

export const FILE_ICONS: Record<FileIconKey, IconifyIcon> = {
${entries}
};
`;

const target = fileURLToPath(new URL("../src/lib/icons/vscode-file-icons.ts", import.meta.url));
mkdirSync(dirname(target), { recursive: true });
writeFileSync(target, out);
console.log(`\nWrote ${Object.keys(resolved).length} icons → src/lib/icons/vscode-file-icons.ts`);
