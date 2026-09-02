/**
 * Read-only .docx reader for the file preview.
 *
 * Renders the body as a flat block list in document order: headings (from
 * paragraph styles), paragraphs, bullets (from `w:numPr`), tables and embedded
 * images. Comments, headers/footers, footnotes and revision marks are not part
 * of `word/document.xml` and are therefore left out — the preview says what it
 * shows rather than silently pretending to be Word.
 */
import { strFromU8, unzipSync } from "fflate";

import { compactBlocks, type DocBlock } from "./blocks";
import { blipRef, MediaStore } from "./media";
import { attr, decodeXmlEntities, findTags, nextElement, stripTags } from "./xml";

export interface DocxModel {
  blocks: DocBlock[];
  /** Owns every image object URL created for this document. */
  media: MediaStore;
}

const MAX_TABLE_ROWS = 300;

export function parseDocx(bytes: Uint8Array): DocxModel {
  const zip = unzipSync(bytes);
  const document = zip["word/document.xml"];
  if (!document) throw new Error("这不是有效的 .docx 文件（缺少 word/document.xml）");

  const relsPart = zip["word/_rels/document.xml.rels"];
  const media = new MediaStore(zip, relsPart ? strFromU8(relsPart) : null, "word/");
  const xml = strFromU8(document);
  const body = findTags(xml, "w:body")[0];
  const blocks = compactBlocks(parseBody(body?.body ?? xml, media));
  return { blocks, media };
}

/**
 * Walks the body in document order.
 *
 * Taking each element whole (and jumping past it) is what keeps paragraphs
 * inside a table cell from being collected twice — once as table cells and
 * once as top-level paragraphs.
 */
function parseBody(body: string, media: MediaStore): DocBlock[] {
  const blocks: DocBlock[] = [];
  const names = ["w:p", "w:tbl", "w:sdt", "w:sectPr"];
  let index = 0;

  for (;;) {
    let best: { name: string; match: NonNullable<ReturnType<typeof nextElement>> } | null = null;
    for (const name of names) {
      const match = nextElement(body, name, index);
      if (!match) continue;
      if (!best || match.start < best.match.start) best = { name, match };
    }
    if (!best) break;

    index = best.match.end;
    switch (best.name) {
      case "w:sectPr":
        break; // section properties: page size, margins — no content
      case "w:tbl": {
        const rows = parseTable(best.match.body);
        if (rows.length > 0) blocks.push({ type: "table", rows });
        break;
      }
      case "w:sdt": {
        const content = nextElement(best.match.body, "w:sdtContent", 0);
        blocks.push(...parseBody(content?.body ?? best.match.body, media));
        break;
      }
      default: {
        const paragraph = parseParagraph(best.match.body, media);
        if (paragraph) blocks.push(...paragraph);
      }
    }
  }
  return blocks;
}

function parseParagraph(body: string, media: MediaStore): DocBlock[] | null {
  const props = nextElement(body, "w:pPr", 0);
  const style = props
    ? findTags(props.body, "w:pStyle")
        .map((tag) => attr(tag.attrs, "w:val"))
        .find((value): value is string => Boolean(value))
    : undefined;
  const listProps = props ? nextElement(props.body, "w:numPr", 0) : null;
  const indent = listProps ? listIndent(listProps.body) : 0;

  const blocks: DocBlock[] = [];
  let text = "";

  for (const run of findTags(body, "w:r")) {
    const ref = blipRef(run.body);
    if (ref) {
      // Flush whatever text came before the picture so order is preserved.
      if (text.trim()) blocks.push({ type: "paragraph", text });
      text = "";
      const image = media.resolve(ref);
      if (image) blocks.push({ type: "image", src: image.src, alt: image.name });
      continue;
    }
    text += runText(run.body);
  }

  const trimmed = text.trim();
  if (trimmed) {
    const level = style ? headingLevel(style) : 0;
    if (level > 0) blocks.push({ type: "heading", level, text: trimmed });
    else if (listProps) blocks.push({ type: "bullet", text: trimmed, level: indent });
    else blocks.push({ type: "paragraph", text: trimmed });
  }
  return blocks.length > 0 ? blocks : null;
}

/**
 * Text of one run, in document order.
 *
 * A run mixes text with inline breaks and tabs (`<w:t>a</w:t><w:tab/><w:t>b</w:t>`),
 * so the parts are collected as a sequence — extracting only the `<w:t>`
 * contents would silently drop the tab between them.
 */
const RUN_TOKEN = /<w:t\b[^>]*>([\s\S]*?)<\/w:t>|<w:tab\b[^>]*\/>|<w:br\b[^>]*\/>|<w:cr\b[^>]*\/>/g;

function runText(runBody: string): string {
  let out = "";
  for (const match of runBody.matchAll(RUN_TOKEN)) {
    if (match[1] !== undefined) out += decodeXmlEntities(stripTags(match[1]));
    else if (match[0].startsWith("<w:tab")) out += "\t";
    else out += "\n";
  }
  return out;
}

function parseTable(body: string): string[][] {
  const rows: string[][] = [];
  for (const tr of findTags(body, "w:tr")) {
    if (rows.length >= MAX_TABLE_ROWS) break;
    const cells = findTags(tr.body, "w:tc").map((tc) =>
      findTags(tc.body, "w:p")
        .map((p) => runText(p.body).trim())
        .filter(Boolean)
        .join(" "),
    );
    if (cells.length > 0) rows.push(cells);
  }
  return rows;
}

function listIndent(propsBody: string): number {
  const ilvl = nextElement(propsBody, "w:ilvl", 0);
  const value = ilvl ? Number(attr(ilvl.attrs, "w:val")) : Number.NaN;
  return Number.isFinite(value) ? Math.max(0, Math.min(4, value)) : 0;
}

/** `Heading2` → 2, `Title` → 1, `Subtitle` → 2; anything else is not a heading. */
function headingLevel(style: string): number {
  const heading = /^heading\s*(\d+)$/i.exec(style.trim());
  if (heading) return Math.max(1, Math.min(4, Number(heading[1])));
  if (/^title$/i.test(style)) return 1;
  if (/^subtitle$/i.test(style)) return 2;
  return 0;
}
