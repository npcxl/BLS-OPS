import { describe, expect, it } from "vitest";
import { LineEditor } from "./terminal-line-editor";

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
    // Arrow keys are escape sequences: they move the *remote* cursor, which we
    // cannot observe, so the tracked position deliberately stays at the end.
    editor.feed("\x1b[D");
    expect(editor.cursor).toBe("docker ps".length);
  });

  it("a multi-line paste runs each terminated line and keeps the last one pending", () => {
    const editor = new LineEditor();
    // Mirrors the shell: a trailing line without a newline is NOT executed —
    // it stays on the prompt waiting for the user to press Enter.
    const completed = editor.feed("\x1b[200~ls -la\rpwd\x1b[201~");
    expect(completed).toEqual(["ls -la"]);
    expect(editor.current).toBe("pwd");
  });
});
