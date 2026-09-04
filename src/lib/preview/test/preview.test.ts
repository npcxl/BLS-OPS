import { describe, expect, it } from "vitest";
import { strToU8, zipSync } from "fflate";

import { buildPreview, decodeText, extensionOf } from "..";
import { listArchive, UnsupportedArchiveError } from "../archive";
import { parseDocx } from "../docx";
import { parsePptx } from "../pptx";
import { parseXlsx } from "../xlsx";
import { hexDump, sniffType } from "../hex";
import { attr, decodeXmlEntities, findTags, nextElement } from "../xml";

/**
 * Fixtures are built with fflate from the real OOXML part layout, so these
 * tests exercise the actual parser against real ZIP+XML bytes — not stubs
 * shaped like the parser's input.
 */

const OOXML_NS = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"';
const REL_NS = 'xmlns="http://schemas.openxmlformats.org/package/2006/relationships"';

function zipOf(parts: Record<string, string>, binary: Record<string, Uint8Array> = {}): Uint8Array {
  const entries: Record<string, Uint8Array> = {};
  for (const [name, text] of Object.entries(parts)) entries[name] = strToU8(text);
  Object.assign(entries, binary);
  return zipSync(entries);
}

// -- XLSX -------------------------------------------------------------------

function sampleXlsx(): Uint8Array {
  return zipOf({
    "xl/workbook.xml": `<workbook ${OOXML_NS} xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="人员" sheetId="1" r:id="rId1"/></sheets></workbook>`,
    "xl/_rels/workbook.xml.rels": `<Relationships ${REL_NS}><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`,
    "xl/sharedStrings.xml": `<sst ${OOXML_NS}><si><t>姓名</t></si><si><t>张三</t></si><si><t>备注 &amp; 说明</t></si></sst>`,
    "xl/styles.xml": `<styleSheet ${OOXML_NS}><numFmts count="1"><numFmt numFmtId="164" formatCode="yyyy\\-mm\\-dd"/></numFmts><cellXfs count="2"><xf numFmtId="0"/><xf numFmtId="164"/></cellXfs></styleSheet>`,
    "xl/worksheets/sheet1.xml": `<worksheet ${OOXML_NS}><sheetData>`
      + `<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>2</v></c></row>`
      + `<row r="2"><c r="A2" t="s"><v>1</v></c><c r="B2" s="1"><v>45000</v></c><c r="C2"><v>42</v></c></row>`
      + `<row r="3"><c r="A3" t="inlineStr"><is><t>内联</t></is></c><c r="B3" t="b"><v>1</v></c></row>`
      + `</sheetData></worksheet>`,
  });
}

describe("parseXlsx", () => {
  it("resolves shared strings, inline strings, booleans and numbers", () => {
    const { sheets } = parseXlsx(sampleXlsx());
    expect(sheets).toHaveLength(1);
    expect(sheets[0].name).toBe("人员");
    expect(sheets[0].rows[0]).toEqual(["姓名", "备注 & 说明"]);
    expect(sheets[0].rows[1][0]).toBe("张三");
    expect(sheets[0].rows[1][2]).toBe("42");
    expect(sheets[0].rows[2]).toEqual(["内联", "TRUE"]);
  });

  it("formats a serial number as a date when its style says so", () => {
    const { sheets } = parseXlsx(sampleXlsx());
    expect(sheets[0].rows[1][1]).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("keeps gaps for skipped cells instead of shifting the row", () => {
    const bytes = zipOf({
      "xl/workbook.xml": `<workbook ${OOXML_NS} xmlns:r="r"><sheets><sheet name="S" r:id="rId1"/></sheets></workbook>`,
      "xl/_rels/workbook.xml.rels": `<Relationships ${REL_NS}><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>`,
      "xl/worksheets/sheet1.xml": `<worksheet ${OOXML_NS}><sheetData><row r="1"><c r="A1"><v>1</v></c><c r="D1"><v>4</v></c></row></sheetData></worksheet>`,
    });
    const { sheets } = parseXlsx(bytes);
    expect(sheets[0].rows[0]).toEqual(["1", "", "", "4"]);
  });

  it("falls back to scanning worksheets when the workbook part is missing", () => {
    const bytes = zipOf({
      "xl/worksheets/sheet1.xml": `<worksheet ${OOXML_NS}><sheetData><row r="1"><c r="A1"><v>7</v></c></row></sheetData></worksheet>`,
    });
    const { sheets } = parseXlsx(bytes);
    expect(sheets).toHaveLength(1);
    expect(sheets[0].rows[0]).toEqual(["7"]);
  });

  it("reports an empty workbook instead of pretending it parsed", () => {
    const { sheets, warning } = parseXlsx(zipOf({ "readme.txt": "nope" }));
    expect(sheets).toHaveLength(0);
    expect(warning).toBeTruthy();
  });
});

// -- DOCX -------------------------------------------------------------------

const W_NS = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';

function sampleDocx(): Uint8Array {
  return zipOf({
    "word/document.xml": `<w:document ${W_NS}><w:body>`
      + `<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>部署手册</w:t></w:r></w:p>`
      + `<w:p><w:r><w:t>第一步：上传</w:t><w:tab/><w:t>第二步：重启</w:t></w:r></w:p>`
      + `<w:p><w:pPr><w:numPr><w:ilvl w:val="1"/></w:numPr></w:pPr><w:r><w:t>检查端口</w:t></w:r></w:p>`
      + `<w:tbl><w:tr><w:tc><w:p><w:r><w:t>主机</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>状态</w:t></w:r></w:p></w:tc></w:tr></w:tbl>`
      + `</w:body></w:document>`,
  });
}

describe("parseDocx", () => {
  it("extracts headings, paragraphs, bullets and tables in document order", () => {
    const { blocks } = parseDocx(sampleDocx());
    expect(blocks.map((block) => block.type)).toEqual([
      "heading",
      "paragraph",
      "bullet",
      "table",
    ]);
    expect(blocks[0]).toMatchObject({ level: 1, text: "部署手册" });
    // A tab inside one run becomes a tab character, not a run boundary.
    expect(blocks[1]).toMatchObject({ text: "第一步：上传\t第二步：重启" });
    expect(blocks[2]).toMatchObject({ level: 1, text: "检查端口" });
    expect(blocks[3]).toMatchObject({ rows: [["主机", "状态"]] });
  });

  it("does not duplicate table-cell text as top-level paragraphs", () => {
    const { blocks } = parseDocx(sampleDocx());
    expect(blocks.filter((block) => block.type === "paragraph" && block.text === "主机")).toHaveLength(0);
  });

  it("rejects a zip that is not a Word document", () => {
    expect(() => parseDocx(zipOf({ "hello.txt": "hi" }))).toThrow(/docx/);
  });
});

// -- PPTX -------------------------------------------------------------------

const P_NS = 'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';

function samplePptx(): Uint8Array {
  return zipOf({
    "ppt/slides/slide1.xml": `<p:sld ${P_NS}><p:cSld><p:spTree>`
      + `<p:sp><p:nvSpPr><p:cNvPr id="1" name="title"/><p:nvPr/><p:ph type="title"/></p:nvSpPr><p:txBody><a:p><a:r><a:t>季度汇报</a:t></a:r></a:p></p:txBody></p:sp>`
      + `<p:sp><p:nvSpPr><p:cNvPr id="2" name="body"/><p:nvPr/></p:nvSpPr><p:txBody><a:p><a:pPr lvl="1"><a:buChar char="•"/></a:pPr><a:r><a:t>要点一</a:t></a:r></a:p></p:txBody></p:sp>`
      + `</p:spTree></p:cSld></p:sld>`,
    "ppt/slides/slide2.xml": `<p:sld ${P_NS}><p:cSld><p:spTree>`
      + `<p:sp><p:txBody><a:p><a:r><a:t>第二页</a:t></a:r></a:p></p:txBody></p:sp>`
      + `</p:spTree></p:cSld></p:sld>`,
  });
}

describe("parsePptx", () => {
  it("orders slides numerically and reads placeholders", () => {
    const { slides } = parsePptx(samplePptx());
    expect(slides.map((slide) => slide.name)).toEqual(["1", "2"]);
    expect(slides[0].blocks[0]).toMatchObject({ type: "heading", level: 1, text: "季度汇报" });
    expect(slides[0].blocks[1]).toMatchObject({ type: "bullet", text: "要点一" });
    expect(slides[1].blocks[0]).toMatchObject({ type: "paragraph", text: "第二页" });
  });

  it("throws when there is no slide at all", () => {
    expect(() => parsePptx(zipOf({ "hello.txt": "hi" }))).toThrow(/pptx/);
  });
});

// -- archives ---------------------------------------------------------------

describe("listArchive", () => {
  it("lists zip entries without inflating them", () => {
    const bytes = zipSync({
      "a.txt": strToU8("hello"),
      "dir/": new Uint8Array(0),
      "dir/b.txt": strToU8("world!"),
    });
    const listing = listArchive(bytes, "bundle.zip");
    expect(listing.format).toBe("zip");
    expect(listing.entries.map((entry) => entry.name).sort()).toEqual(["a.txt", "dir/", "dir/b.txt"]);
    const file = listing.entries.find((entry) => entry.name === "dir/b.txt");
    expect(file?.size).toBe(6);
    expect(file?.directory).toBe(false);
    expect(listing.entries.find((entry) => entry.name === "dir/")?.directory).toBe(true);
  });

  it("refuses formats it cannot read, with a reason", () => {
    expect(() => listArchive(new Uint8Array([0x52, 0x61, 0x72, 0x21, 1, 0, 0]), "x.rar")).toThrow(
      UnsupportedArchiveError,
    );
  });
});

// -- hex + sniffing ---------------------------------------------------------

describe("hex", () => {
  it("dumps 16 bytes per row and pads the tail", () => {
    const lines = hexDump(new Uint8Array(20).fill(0x41), 0, 20);
    expect(lines).toHaveLength(2);
    expect(lines[0].cells).toHaveLength(16);
    expect(lines[1].cells.filter((cell) => cell === null)).toHaveLength(12);
    expect(lines[0].text).toBe("AAAAAAAAAAAAAAAA");
  });

  it("identifies files by magic bytes, not by extension", () => {
    expect(sniffType(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe("PNG 图片");
    expect(sniffType(new Uint8Array([0x25, 0x50, 0x44, 0x46]))).toBe("PDF 文档");
    expect(sniffType(new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]))).toContain("OLE2");
    expect(sniffType(new Uint8Array([1, 2, 3]))).toBeNull();
  });
});

// -- dispatcher -------------------------------------------------------------

describe("buildPreview", () => {
  it("routes spreadsheets, documents and decks by extension", () => {
    expect(buildPreview({ name: "book.xlsx", mime: "", bytes: sampleXlsx() }).model.kind).toBe("sheet");
    expect(buildPreview({ name: "notes.docx", mime: "", bytes: sampleDocx() }).model.kind).toBe("doc");
    expect(buildPreview({ name: "deck.pptx", mime: "", bytes: samplePptx() }).model.kind).toBe("slides");
  });

  it("reads csv as a table, honouring quoted separators and newlines", () => {
    const csv = 'name,note\n"李,四","第一行\n第二行"\n';
    const result = buildPreview({ name: "data.csv", mime: "text/csv", bytes: strToU8(csv) });
    expect(result.model.kind).toBe("sheet");
    if (result.model.kind !== "sheet") return;
    expect(result.model.sheets[0].rows).toEqual([
      ["name", "note"],
      ["李,四", "第一行\n第二行"],
    ]);
  });

  it("shows images, pdfs and media as binary previews", () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]);
    expect(buildPreview({ name: "a.png", mime: "image/png", bytes: png }).model.kind).toBe("image");
    expect(buildPreview({ name: "a.pdf", mime: "application/pdf", bytes: strToU8("%PDF-1.7") }).model.kind).toBe("pdf");
    const audio = buildPreview({ name: "a.mp3", mime: "audio/mpeg", bytes: strToU8("ID3") });
    expect(audio.model).toMatchObject({ kind: "media", audio: true });
  });

  it("explains why a legacy Office file cannot be previewed", () => {
    const model = buildPreview({ name: "old.xls", mime: "", bytes: new Uint8Array([0xd0, 0xcf, 0x11, 0xe0]) }).model;
    expect(model.kind).toBe("unsupported");
    if (model.kind !== "unsupported") return;
    expect(model.reason).toContain("旧版 Office");
    expect(model.hint).toBeTruthy();
  });

  it("falls back to hex for unrecognised binaries, naming what it detected", () => {
    const model = buildPreview({ name: "mystery.bin", mime: "", bytes: new Uint8Array([0x7f, 0x45, 0x4c, 0x46]) }).model;
    expect(model).toMatchObject({ kind: "hex", detected: "ELF 可执行文件" });
  });

  it("shows extension-less text as text", () => {
    const model = buildPreview({ name: "README", mime: "", bytes: strToU8("just some notes\n第二行\n") }).model;
    expect(model).toMatchObject({ kind: "text", text: "just some notes\n第二行\n" });
  });

  it("reports a truncated payload instead of hiding it", () => {
    const result = buildPreview({ name: "big.log", mime: "", bytes: strToU8("abc"), size: 999 });
    expect(result.note).toContain("预览只加载了前");
  });

  it("releases object URLs it created", () => {
    const result = buildPreview({ name: "notes.docx", mime: "", bytes: sampleDocx() });
    expect(() => result.dispose()).not.toThrow();
  });
});

// -- helpers ----------------------------------------------------------------

describe("decodeText", () => {
  it("decodes utf-8 and strips a BOM", () => {
    expect(decodeText(new Uint8Array([0xef, 0xbb, 0xbf, 0x41]))).toBe("A");
  });

  it("decodes gb18030 when the bytes are not valid utf-8", () => {
    // "中文" in GBK: D6 D0 CE C4
    expect(decodeText(new Uint8Array([0xd6, 0xd0, 0xce, 0xc4]))).toBe("中文");
  });
});

describe("extensionOf", () => {
  it("lower-cases the extension and ignores dotfiles", () => {
    expect(extensionOf("Report.XLSX")).toBe("xlsx");
    expect(extensionOf(".env")).toBe("");
    expect(extensionOf("archive.tar.gz")).toBe("gz");
  });
});

describe("xml helpers", () => {
  it("decodes the entities Office uses", () => {
    expect(decodeXmlEntities("a &amp; b &#65; &#x42;")).toBe("a & b A B");
  });

  it("does not match a longer element name", () => {
    const xml = "<table><t>x</t></table>";
    expect(findTags(xml, "t")).toHaveLength(1);
    expect(nextElement(xml, "t")?.body).toBe("x");
  });

  it("handles nesting when collecting elements", () => {
    const found = findTags("<a><b>1</b></a><a><b>2</b></a>", "a");
    expect(found).toHaveLength(2);
    expect(found[1].body).toBe("<b>2</b>");
  });

  it("reads quoted attributes", () => {
    expect(attr(' r="A1" t="s"', "t")).toBe("s");
    expect(attr(" t='inlineStr'", "t")).toBe("inlineStr");
    expect(attr(" t=\"s\"", "x")).toBeNull();
  });
});
