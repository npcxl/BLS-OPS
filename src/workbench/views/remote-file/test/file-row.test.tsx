import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { DirectorySizeResult, RemoteFileEntry } from "@/api/ops-api";
import { useDirSizeStore } from "@/stores/dir-size-store";
import { FileRow } from "../FileRow";

// React 19 requires this flag for act() outside react-dom/test-utils.
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function entry(overrides: Partial<RemoteFileEntry> = {}): RemoteFileEntry {
  return {
    name: "assets",
    path: "/var/www/assets",
    kind: "directory",
    size: 4096,
    modified_at: null,
    hidden: false,
    ...overrides,
  };
}

function applyResult(overrides: Partial<DirectorySizeResult>) {
  useDirSizeStore.getState().apply({
    sessionId: "s1",
    path: "/var/www/assets",
    sizeBytes: 0,
    fileCount: 0,
    directoryCount: 0,
    skippedCount: 0,
    status: "computing",
    complete: false,
    calculatedAt: 100,
    ...overrides,
  });
}

/** Renders one row and returns its whole text (name line + size line). */
function rowText(root: Root, holder: HTMLDivElement, entryValue: RemoteFileEntry, sessionId = "s1") {
  act(() => {
    root.render(
      <FileRow
        sessionId={sessionId}
        entry={entryValue}
        selected={false}
        onSelect={() => undefined}
        onOpen={() => undefined}
        onContextMenu={() => undefined}
      />,
    );
  });
  return holder.textContent ?? "";
}

describe("FileRow size line", () => {
  let holder: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    holder = document.createElement("div");
    document.body.appendChild(holder);
    root = createRoot(holder);
    useDirSizeStore.setState({ results: {}, listening: false, unlisten: null });
  });

  afterEach(() => {
    act(() => root.unmount());
    holder.remove();
  });

  it("shows the file's own SFTP size — never the directory machinery", () => {
    const text = rowText(
      root,
      holder,
      entry({ kind: "file", name: "a.tar.gz", path: "/var/www/a.tar.gz", size: 1234 }),
    );
    expect(text).toContain("1.2 KB");
    expect(text).not.toContain("Queued");
  });

  it("shows plain Folder before a computation exists", () => {
    expect(rowText(root, holder, entry())).toContain("Folder");
  });

  it("shows Queued while queued and Computing while computing", () => {
    applyResult({ status: "pending", complete: false });
    expect(rowText(root, holder, entry())).toContain("Queued");

    act(() => {
      applyResult({ status: "computing", complete: false, calculatedAt: 110 });
    });
    expect(rowText(root, holder, entry())).toContain("Computing");
  });

  it("flips to the finished size automatically, without a remount", () => {
    applyResult({ status: "computing", complete: false });
    rowText(root, holder, entry());
    expect(holder.textContent).toContain("Computing");

    // The completed event lands in the store; the memoised row must re-render.
    act(() => {
      applyResult({
        status: "completed",
        complete: true,
        sizeBytes: 7_000_000,
        fileCount: 128,
        calculatedAt: 200,
      });
    });

    expect(holder.textContent).toContain("6.7 MB");
    expect(holder.textContent).toContain("128 files");
    expect(holder.textContent).not.toContain("Computing");
  });

  it("renders an empty directory as 0 B", () => {
    applyResult({ status: "completed", complete: true, calculatedAt: 200 });
    expect(rowText(root, holder, entry())).toContain("0 B");
  });

  it("does not claim 0 files when du reported bytes without a count", () => {
    applyResult({ status: "completed", complete: true, sizeBytes: 7_000_000, fileCount: 0 });
    const text = rowText(root, holder, entry());
    expect(text).toContain("6.7 MB");
    expect(text).not.toContain("0 files");
  });

  it("surfaces a permission-denied terminal state", () => {
    applyResult({ status: "permission_denied", complete: true, calculatedAt: 200 });
    expect(rowText(root, holder, entry())).toContain("Permission denied");
  });

  it("keeps two sessions with the same path apart", () => {
    // Session s2 finishes; s1's row must not pick up the foreign result.
    applyResult({ sessionId: "s2", status: "completed", complete: true, sizeBytes: 999 });

    expect(rowText(root, holder, entry(), "s1")).not.toContain("999");
    expect(rowText(root, holder, entry(), "s2")).toContain("999");
  });
});

describe("FileRow inline rename", () => {
  let holder: HTMLDivElement;
  let root: Root;

  const renderRenaming = (
    onSubmit: (entryValue: RemoteFileEntry, name: string) => boolean = () => true,
    onCancel: () => void = () => undefined,
  ) => {
    act(() => {
      root.render(
        <FileRow
          sessionId="s1"
          entry={entry({ kind: "file", name: "report.tar.gz", path: "/var/www/report.tar.gz" })}
          selected
          renaming
          renameInitial="report.tar.gz"
          onRenameSubmit={onSubmit}
          onRenameCancel={onCancel}
          onSelect={() => undefined}
          onOpen={() => undefined}
          onContextMenu={() => undefined}
        />,
      );
    });
    return holder.querySelector("input") as HTMLInputElement;
  };

  beforeEach(() => {
    holder = document.createElement("div");
    document.body.appendChild(holder);
    root = createRoot(holder);
  });

  afterEach(() => {
    act(() => root.unmount());
    holder.remove();
  });

  it("edits in place instead of opening a dialog", () => {
    const input = renderRenaming();

    expect(input).not.toBeNull();
    expect(input.value).toBe("report.tar.gz");
    // 行内是一行输入框，不再是可点击的行按钮（input 不能嵌在 button 里）。
    expect(holder.querySelector("button")).toBeNull();
  });

  it("submits on Enter and cancels on Escape", () => {
    const submitted: string[] = [];
    let cancelled = 0;
    const input = renderRenaming(
      (_entry, name) => {
        submitted.push(name);
        return true;
      },
      () => {
        cancelled += 1;
      },
    );

    act(() => {
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    expect(submitted).toEqual(["report.tar.gz"]);

    act(() => {
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(cancelled).toBe(1);
  });

  it("stays in edit mode when the parent rejects the name", () => {
    let calls = 0;
    const input = renderRenaming(() => {
      calls += 1;
      return false;
    });

    act(() => {
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });

    expect(calls).toBe(1);
    // 名字不合法时不卸载输入框：刚打的字不能丢。
    expect(holder.querySelector("input")).not.toBeNull();
  });
});
