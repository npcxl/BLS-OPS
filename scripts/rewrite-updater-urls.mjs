/**
 * Rewrites the updater manifest's asset URLs to **direct download links**.
 *
 * tauri-action generates `latest.json` with URLs of the form
 * `https://api.github.com/repos/<owner>/<repo>/releases/assets/<id>`. That
 * endpoint answers with *asset metadata* (and 401 for anonymous clients), not
 * with the installer binary — so the updater's download step fails with an
 * unclassified error ("The update could not be completed.").
 *
 * The fix: map every asset id to its real file name and point the manifest at
 * `https://github.com/<owner>/<repo>/releases/download/<tag>/<name>` — the
 * browser-downloadable URL that works for anonymous clients.
 *
 * Inputs (all from the release workflow):
 * - argv[2]: path to the downloaded latest.json (rewritten in place);
 * - `TAG`:            the release tag, e.g. `v0.1.3`;
 * - `GITHUB_REPOSITORY`: `owner/repo` (always set by Actions);
 * - `ASSET_MAP`:      JSON `{ "<asset id>": "<file name>", … }`.
 */
import { readFileSync, writeFileSync } from "node:fs";

const file = process.argv[2];
const tag = process.env.TAG;
const repo = process.env.GITHUB_REPOSITORY;
const map = JSON.parse(process.env.ASSET_MAP ?? "{}");

if (!file || !tag || !repo) {
  console.error("usage: TAG=<v…> GITHUB_REPOSITORY=<o/r> ASSET_MAP=<json> node rewrite-updater-urls.mjs <latest.json>");
  process.exit(1);
}

const manifest = JSON.parse(readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
let rewritten = 0;

for (const [platform, entry] of Object.entries(manifest.platforms ?? {})) {
  const match = /^(.*\/releases\/assets\/)(\d+)$/.exec(entry.url ?? "");
  if (!match) continue;
  const name = map[match[2]];
  if (!name) {
    console.error(`[rewrite-updater-urls] ${platform}: no asset name for id ${match[2]} — leaving URL unchanged`);
    continue;
  }
  entry.url = `https://github.com/${repo}/releases/download/${tag}/${encodeURIComponent(name)}`;
  rewritten += 1;
  console.log(`[rewrite-updater-urls] ${platform} → ${entry.url}`);
}

if (rewritten === 0) {
  console.error("[rewrite-updater-urls] nothing rewritten — is this already a direct URL manifest?");
  process.exit(1);
}

writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`[rewrite-updater-urls] ${rewritten} URL(s) rewritten in ${file}`);
