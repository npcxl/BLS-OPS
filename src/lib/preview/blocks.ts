/**
 * Document blocks shared by the Word and PowerPoint previews.
 *
 * Both formats are "a sequence of things that render top to bottom", so both
 * parsers reduce to this one list and one renderer handles them. Images carry
 * an object URL owned by the preview session (see `media.ts`) — never a data
 * URI, which would copy the whole file into the DOM.
 */

export type DocBlock =
  | { type: "heading"; level: number; text: string }
  | { type: "paragraph"; text: string }
  | { type: "bullet"; text: string; level: number }
  | { type: "image"; src: string; alt: string }
  | { type: "table"; rows: string[][] };

export interface Slide {
  /** `1`, `2`, … — used for the slide selector, not parsed from the XML. */
  name: string;
  blocks: DocBlock[];
}

/** Drops empty blocks so a document full of empty runs stays readable. */
export function compactBlocks(blocks: DocBlock[]): DocBlock[] {
  return blocks.filter((block) => {
    switch (block.type) {
      case "heading":
      case "paragraph":
      case "bullet":
        return block.text.trim().length > 0;
      case "image":
        return block.src.length > 0;
      case "table":
        return block.rows.length > 0;
    }
  });
}
