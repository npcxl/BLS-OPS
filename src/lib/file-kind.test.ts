import { describe, expect, it } from "vitest";
import { fileKind, isEditableKind } from "./file-kind";

describe("fileKind", () => {
  it("recognizes the extensions the user called out", () => {
    expect(fileKind("query.sql").label).toBe("SQL");
    expect(fileKind("index.html").label).toBe("HTML");
    expect(fileKind("app.js").label).toBe("JavaScript");
    expect(fileKind("Main.java").label).toBe("Java");
    expect(fileKind("report.pdf").category).toBe("pdf");
    expect(fileKind("table.xlsx").category).toBe("sheet");
  });

  it("is case-insensitive", () => {
    expect(fileKind("QUERY.SQL").label).toBe("SQL");
    expect(fileKind("Photo.JPG").category).toBe("image");
  });

  it("recognizes dotfiles by full name", () => {
    expect(fileKind(".env").label).toBe("环境变量");
    expect(fileKind("Dockerfile").label).toBe("Dockerfile");
    expect(fileKind("Makefile").label).toBe("Makefile");
  });

  it("falls back to a generic icon for unknown extensions", () => {
    expect(fileKind("data.weird").label).toBe("文件");
    expect(fileKind("noext").label).toBe("文件");
  });

  it("treats names ending with a dot as extension-less", () => {
    // `lastIndexOf(".") <= 0` keeps "name." generic instead of crashing.
    expect(fileKind("name.").label).toBe("文件");
  });
});

describe("isEditableKind", () => {
  it("opens code and text files in the editor", () => {
    expect(isEditableKind("query.sql")).toBe(true);
    expect(isEditableKind("nginx.conf")).toBe(true);
    expect(isEditableKind("app.log")).toBe(true);
    expect(isEditableKind("notes.txt")).toBe(true);
  });

  it("treats compressed dumps as archives, not editable text", () => {
    // schema.sql.gz is a gzip archive even though it contains SQL.
    expect(isEditableKind("schema.sql.gz")).toBe(false);
  });

  it("does not offer editing for binary/rich types", () => {
    expect(isEditableKind("report.pdf")).toBe(false);
    expect(isEditableKind("table.xlsx")).toBe(false);
    expect(isEditableKind("photo.png")).toBe(false);
    expect(isEditableKind("backup.zip")).toBe(false);
  });
});
