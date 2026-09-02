/**
 * Embedded-image resolution for Office previews.
 *
 * `word/media/image1.png` (or `ppt/media/…`) is referenced indirectly: a run
 * carries `<a:blip r:embed="rId7"/>` and `rId7` is mapped to a path in the
 * part's `.rels`. This resolves that chain and hands out object URLs, which
 * the caller must revoke when the preview closes.
 */
import { bytesToBlob } from "@/lib/blob";

import { attr, findTags } from "./xml";

export interface MediaRef {
  src: string;
  mime: string;
  /** File name inside the archive, shown as the image's alt text. */
  name: string;
}

const MIME_BY_EXT: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  bmp: "image/bmp",
  tif: "image/tiff",
  tiff: "image/tiff",
  webp: "image/webp",
  emf: "image/emf",
  wmf: "image/wmf",
  svg: "image/svg+xml",
};

/**
 * Lazily turns archive entries into `blob:` URLs.
 *
 * `revoke()` releases every URL it created; the preview owns one instance per
 * opened file and calls it on unmount, so nothing leaks between previews.
 */
export class MediaStore {
  private readonly targets = new Map<string, string>();
  private readonly urls = new Map<string, string>();

  constructor(
    private readonly zip: Record<string, Uint8Array>,
    relsXml: string | null,
    /** Folder the `.rels` targets are relative to, e.g. `word/`. */
    baseDir: string,
  ) {
    if (!relsXml) return;
    for (const rel of findTags(relsXml, "Relationship")) {
      const id = attr(rel.attrs, "Id");
      const target = attr(rel.attrs, "Target");
      if (id && target) this.targets.set(id, resolvePart(target, baseDir));
    }
  }

  resolve(rid: string | null | undefined): MediaRef | null {
    if (!rid) return null;
    const path = this.targets.get(rid);
    if (!path) return null;
    const cached = this.urls.get(path);
    const bytes = this.zip[path];
    if (!bytes) return null;
    const ext = extension(path);
    const mime = MIME_BY_EXT[ext];
    if (!mime) return null; // unsupported embedded object (e.g. an OLE blob)
    if (cached) return { src: cached, mime, name: fileName(path) };
    const url = URL.createObjectURL(bytesToBlob(bytes, mime));
    this.urls.set(path, url);
    return { src: url, mime, name: fileName(path) };
  }

  revoke(): void {
    for (const url of this.urls.values()) URL.revokeObjectURL(url);
    this.urls.clear();
  }
}

/**
 * Resolves a relationship target against the part's folder.
 *
 * Targets come in three shapes — `media/image1.png` (Word), `../media/image1.png`
 * (PowerPoint: slides live one level below `ppt/`) and `/ppt/media/image1.png`
 * (absolute) — so `.`/`..` are resolved properly rather than stripped, which
 * would point PowerPoint at `media/…` instead of `ppt/media/…`.
 */
function resolvePart(target: string, baseDir: string): string {
  const raw = target.startsWith("/") ? target.slice(1) : `${baseDir}${target}`;
  const parts: string[] = [];
  for (const segment of raw.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") parts.pop();
    else parts.push(segment);
  }
  return parts.join("/");
}

function extension(path: string): string {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  return dot < 0 ? "" : name.slice(dot + 1).toLowerCase();
}

function fileName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

/** `<a:blip r:embed="rId7"/>` → `rId7` (also accepts `r:id` and `r:link`). */
export function blipRef(xml: string): string | null {
  const blip = findTags(xml, "blip")[0];
  if (!blip) return null;
  return attr(blip.attrs, "r:embed") ?? attr(blip.attrs, "embed") ?? attr(blip.attrs, "r:link");
}
