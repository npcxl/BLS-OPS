/**
 * Read-only .pptx reader for the file preview.
 *
 * Slides come out of `ppt/slides/slideN.xml` in numeric order (the file name
 * is the only reliable order — `presentation.xml` lists them by relationship
 * id, which is not sorted). Each slide is reduced to the shared block list:
 * titles, body text, bullet level, tables and pictures.
 *
 * Text is taken from the shape's own paragraphs, so speaker notes, animations
 * and master-slide placeholders are not shown.
 */
import { strFromU8, unzipSync } from "fflate";

import { i18n } from "@/i18n";
import { compactBlocks, type DocBlock, type Slide } from "./blocks";
import { blipRef, MediaStore } from "./media";
import { attr, findTags, nextElement, runTexts } from "./xml";

export interface PptxModel {
  slides: Slide[];
  /** One store per slide (relationship ids are only unique inside a slide). */
  media: MediaStore[];
}

export function parsePptx(bytes: Uint8Array): PptxModel {
  const zip = unzipSync(bytes);
  const keys = Object.keys(zip)
    .filter((key) => /^ppt\/slides\/slide\d+\.xml$/.test(key))
    .sort((a, b) => slideNumber(a) - slideNumber(b));
  if (keys.length === 0) throw new Error(i18n.t("Not a valid .pptx file (no slides found)"));

  const media: MediaStore[] = [];
  const slides = keys.map((key) => {
    const relKey = key.replace("ppt/slides/", "ppt/slides/_rels/") + ".rels";
    const relsPart = zip[relKey];
    const store = new MediaStore(zip, relsPart ? strFromU8(relsPart) : null, "ppt/slides/");
    media.push(store);
    const shapeTree = findTags(findTags(strFromU8(zip[key]), "p:cSld")[0]?.body ?? "", "p:spTree")[0];
    return {
      name: String(slideNumber(key)),
      blocks: compactBlocks(parseShapeTree(shapeTree?.body ?? "", store)),
    };
  });

  return { slides, media };
}

/** Shape containers that can hold text, pictures or tables, in document order. */
const SHAPE_NAMES = ["p:sp", "p:pic", "p:graphicFrame", "p:cxnSp", "p:grpSp"];

function parseShapeTree(body: string, media: MediaStore): DocBlock[] {
  const blocks: DocBlock[] = [];
  let index = 0;

  for (;;) {
    let best: { name: string; match: NonNullable<ReturnType<typeof nextElement>> } | null = null;
    for (const name of SHAPE_NAMES) {
      const match = nextElement(body, name, index);
      if (!match) continue;
      if (!best || match.start < best.match.start) best = { name, match };
    }
    if (!best) break;
    index = best.match.end;

    if (best.name === "p:grpSp") {
      // A group is a container: recurse instead of skipping its contents.
      const tree = nextElement(best.match.body, "p:grpSpPr", 0);
      blocks.push(...parseShapeTree(best.match.body.slice(tree?.end ?? 0), media));
      continue;
    }
    if (best.name === "p:pic") {
      const image = media.resolve(blipRef(best.match.body));
      if (image) blocks.push({ type: "image", src: image.src, alt: pictureAlt(best.match.body, image.name) });
      continue;
    }

    const table = findTags(best.match.body, "a:tbl")[0];
    if (table) {
      const rows = parseTable(table.body);
      if (rows.length > 0) blocks.push({ type: "table", rows });
      continue;
    }

    const textBody = nextElement(best.match.body, "p:txBody", 0);
    if (!textBody) continue;
    blocks.push(...parseTextBox(textBody.body, best.match.body));
  }
  return blocks;
}

function parseTextBox(body: string, shapeXml: string): DocBlock[] {
  const placeholder = findTags(shapeXml, "p:ph")[0];
  const phType = placeholder ? attr(placeholder.attrs, "type") : null;
  const titleLevel = phType === "title" || phType === "ctrTitle" ? 1 : phType === "subTitle" ? 2 : 0;
  const blocks: DocBlock[] = [];

  for (const paragraph of findTags(body, "a:p")) {
    const text = runTexts(paragraph.body, "a:t").trim();
    if (!text) continue;
    if (titleLevel > 0 && blocks.length === 0) {
      blocks.push({ type: "heading", level: titleLevel, text });
      continue;
    }
    // `a:buChar` lives inside `a:pPr`, which some producers write as a
    // self-closing empty element; searching the whole paragraph covers both.
    const props = nextElement(paragraph.body, "a:pPr", 0);
    const bulleted = nextElement(paragraph.body, "a:buChar", 0) !== null;
    const level = props ? bulletLevel(props.attrs) : 0;
    if (bulleted) blocks.push({ type: "bullet", text, level });
    else blocks.push({ type: "paragraph", text });
  }
  return blocks;
}

function parseTable(body: string): string[][] {
  const rows: string[][] = [];
  for (const tr of findTags(body, "a:tr")) {
    const cells = findTags(tr.body, "a:tc").map((tc) =>
      findTags(tc.body, "a:p")
        .map((p) => runTexts(p.body, "a:t").trim())
        .filter(Boolean)
        .join(" "),
    );
    if (cells.length > 0) rows.push(cells);
  }
  return rows;
}

function bulletLevel(propsBody: string): number {
  const value = Number(attr(propsBody, "lvl"));
  return Number.isFinite(value) ? Math.max(0, Math.min(4, value)) : 0;
}

function pictureAlt(shapeXml: string, fallback: string): string {
  const nvPicPr = findTags(shapeXml, "p:nvPicPr")[0];
  const descr = nvPicPr ? attr(nvPicPr.attrs, "descr") : null;
  return descr && descr.trim() ? descr : fallback;
}

function slideNumber(path: string): number {
  const match = /slide(\d+)\.xml$/.exec(path);
  return match ? Number(match[1]) : Number.MAX_SAFE_INTEGER;
}
