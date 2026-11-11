import { describe, expect, it } from "vitest";
import { LineEditor } from "../terminal-line-editor";

describe("LineEditor", () => {
  it("accumulates printable input and submits on Enter", () => {
    const editor = new LineEditor();
    expect(editor.feed("docker p")).toEqual([]);
    expect(editor.current).toBe("docker p");
    expect(editor.feed("s\r")).toEqual(["docker ps"]);
    expect(editor.current).toBe("");
  });

  it("handles backspace and Ctrl+U", () => {
    const editor = new LineEditor();
    editor.feed("abc\x7f");
    expect(editor.current).toBe("ab");

    editor.feed("def\x15");
    expect(editor.current).toBe("");
  });

  it("Ctrl+C abandons the line without recording it", () => {
    const editor = new LineEditor();
    editor.feed("docker ps");
    expect(editor.feed("\x03")).toEqual([]);
    expect(editor.current).toBe("");
  });

  it("reset drops everything, including a pending paste", () => {
    const editor = new LineEditor();
    editor.feed("half-typed");
    // An unterminated bracketed paste leaves internal state behind.
    editor.feed("\x1b[200~multi\nline");
    editor.reset();
    expect(editor.current).toBe("");
    // After reset the editor must behave like a fresh one.
    expect(editor.feed("ls\r")).toEqual(["ls"]);
  });

  it("cursor reports the end of the tracked buffer", () => {
    const editor = new LineEditor();
    expect(editor.cursor).toBe(0);
    editor.feed("docker ps");
    expect(editor.cursor).toBe("docker ps".length);
    expect(editor.canComplete).toBe(true);
  });

  it("stops tracking once the remote cursor may have moved", () => {
    const editor = new LineEditor();
    editor.feed("docker ps");
    // Arrow keys move the *remote* cursor, which we cannot observe: completing
    // against a stale buffer would splice the suggestion into the wrong place,
    // so tracking is dropped until the next submit / reset.
    editor.feed("\x1b[D");
    expect(editor.current).toBe("");
    expect(editor.cursor).toBe(0);
    expect(editor.canComplete).toBe(false);
    // Submitting then records nothing rather than a half-known command.
    expect(editor.feed("\r")).toEqual([]);
  });

  it("a paste is literal text: no line is submitted behind the user's back", () => {
    const editor = new LineEditor();
    // Bracketed paste: the line breaks are the user's text, not Enter presses.
    // The old behaviour executed every terminated line immediately — pasting
    // a copied block ran half of it on the server.
    const completed = editor.feed("\x1b[200~ls -la\rpwd\x1b[201~");
    expect(completed).toEqual([]);
    expect(editor.current).toBe("ls -la\npwd");
    expect(editor.canComplete).toBe(false);
    // Only the user's own Enter submits it, as one block.
    expect(editor.feed("\r")).toEqual(["ls -la\npwd"]);
  });
});
