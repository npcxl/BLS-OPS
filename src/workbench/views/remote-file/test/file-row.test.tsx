import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { DirectorySizeResult, RemoteFileEntry } from "@/api/ops-api";
import { useDirSizeStore } from "@/stores/dir-size-store";
import { FileRow } from "./FileRow";

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
    expect(text).not.toContain("排队中");
  });

  it("shows plain 文件夹 before a computation exists", () => {
    expect(rowText(root, holder, entry())).toContain("文件夹");
  });

  it("shows 排队中 while queued and 计算中 while computing", () => {
    applyResult({ status: "pending", complete: false });
    expect(rowText(root, holder, entry())).toContain("排队中");

    act(() => {
      applyResult({ status: "computing", complete: false, calculatedAt: 110 });
    });
    expect(rowText(root, holder, entry())).toContain("计算中");
  });

  it("flips to the finished size automatically, without a remount", () => {
    applyResult({ status: "computing", complete: false });
    rowText(root, holder, entry());
    expect(holder.textContent).toContain("计算中");

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
    expect(holder.textContent).toContain("128 个文件");
    expect(holder.textContent).not.toContain("计算中");
  });

  it("renders an empty directory as 0 B", () => {
    applyResult({ status: "completed", complete: true, calculatedAt: 200 });
    expect(rowText(root, holder, entry())).toContain("0 B");
  });

  it("does not claim 0 个文件 when du reported bytes without a count", () => {
    applyResult({ status: "completed", complete: true, sizeBytes: 7_000_000, fileCount: 0 });
    const text = rowText(root, holder, entry());
    expect(text).toContain("6.7 MB");
    expect(text).not.toContain("0 个文件");
  });

  it("surfaces a permission-denied terminal state", () => {
    applyResult({ status: "permission_denied", complete: true, calculatedAt: 200 });
    expect(rowText(root, holder, entry())).toContain("权限不足");
  });

  it("keeps two sessions with the same path apart", () => {
    // Session s2 finishes; s1's row must not pick up the foreign result.
    applyResult({ sessionId: "s2", status: "completed", complete: true, sizeBytes: 999 });

    expect(rowText(root, holder, entry(), "s1")).not.toContain("999");
    expect(rowText(root, holder, entry(), "s2")).toContain("999");
  });
});
