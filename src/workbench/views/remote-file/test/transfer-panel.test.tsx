import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { TransferTask } from "@/api/ops-api";
import { groupTransferEntries, sortTransferTasks } from "../TransferCenterPanel";
import { TransferTaskRow, percentOf } from "../TransferTaskRow";

vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));

// React 19 requires this flag for act() outside react-dom/test-utils.
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function task(overrides: Partial<TransferTask> = {}): TransferTask {
  return {
    id: "t1",
    session_id: "s1",
    kind: "upload",
    name: "report.pdf",
    source: "/tmp/report.pdf",
    target: "/var/www/report.pdf",
    total: 1000,
    transferred: 0,
    size_known: true,
    state: "queued",
    batch_id: "b1",
    attempt: 1,
    revision: 1,
    created_at: 1,
    updated_at: 1,
    ...overrides,
  };
}

describe("transfer list ordering and batches", () => {
  it("puts running before queued before finished", () => {
    const sorted = sortTransferTasks([
      task({ id: "done", state: "completed", updated_at: 30 }),
      task({ id: "queued", state: "queued", created_at: 2 }),
      task({ id: "running", state: "running", created_at: 3 }),
    ]);
    expect(sorted.map((item) => item.id)).toEqual(["running", "queued", "done"]);
  });

  it("collapses a large batch into one summary entry", () => {
    const files = Array.from({ length: 12 }, (_, index) =>
      task({
        id: `f${index}`,
        name: `f${index}.log`,
        state: index < 8 ? "completed" : "running",
        batch_id: "batch-a",
        created_at: index,
      }),
    );

    const entries = groupTransferEntries(files);
    expect(entries).toHaveLength(1);
    expect(entries[0].kind).toBe("batch");
    if (entries[0].kind === "batch") {
      expect(entries[0].tasks).toHaveLength(12);
    }
  });

  it("keeps two or three files as individual rows", () => {
    const entries = groupTransferEntries([
      task({ id: "a", batch_id: "batch-a" }),
      task({ id: "b", batch_id: "batch-a" }),
    ]);
    expect(entries.map((entry) => entry.kind)).toEqual(["task", "task"]);
  });
});

describe("TransferTaskRow", () => {
  let holder: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    holder = document.createElement("div");
    document.body.appendChild(holder);
    root = createRoot(holder);
  });

  afterEach(() => {
    act(() => root.unmount());
    holder.remove();
  });

  const render = (value: TransferTask, extra: Partial<Parameters<typeof TransferTaskRow>[0]> = {}) => {
    act(() => {
      root.render(
        <TransferTaskRow
          task={value}
          busy={false}
          cancelRequested={false}
          expanded={false}
          onToggle={() => undefined}
          onCancel={() => undefined}
          onRetry={() => undefined}
          {...extra}
        />,
      );
    });
    return holder.textContent ?? "";
  };

  it("shows cancel while active and never a retry", () => {
    const text = render(task({ state: "running", transferred: 500 }));
    expect(text).toContain("Transferring");
    expect(text).toContain("Cancel");
    expect(text).not.toContain("Upload again");
  });

  it("shows the local «cancelling» state immediately and removes the action", () => {
    const text = render(task({ state: "running", transferred: 500 }), {
      cancelRequested: true,
    });
    expect(text).toContain("Cancelling…");
    // 同一操作不能有第二个提交入口。
    const labels = [...holder.querySelectorAll("button")].map((button) => button.textContent);
    expect(labels).not.toContain("Cancel");
  });

  it("offers a direction-specific retry only for failed or cancelled tasks", () => {
    expect(render(task({ kind: "download", state: "failed" }))).toContain("Download again");
    expect(render(task({ kind: "upload", state: "cancelled" }))).toContain("Upload again");
    expect(render(task({ state: "completed", transferred: 1000 }))).not.toContain("again");
    expect(render(task({ state: "skipped" }))).not.toContain("again");
  });

  it("shows «finishing» instead of success once the bytes are written", () => {
    const text = render(
      task({ state: "finalizing", transferred: 1000, total: 1000 }),
    );
    expect(text).toContain("Finishing…");
    expect(text).not.toContain("Completed");
    expect(holder.querySelector('[role="progressbar"]')?.getAttribute("aria-valuenow")).toBe("100");
  });

  it("uses an indeterminate bar when the total size is unknown", () => {
    const text = render(task({ state: "running", size_known: false, total: 0, transferred: 2048 }));
    expect(text).toContain("2.0 KB");
    expect(text).toContain("transferred");
    expect(holder.querySelector('[role="progressbar"]')?.getAttribute("aria-valuenow")).toBeNull();
  });

  it("treats an empty file as complete rather than unknown", () => {
    expect(percentOf(task({ total: 0, size_known: true }))).toBe(100);
    expect(percentOf(task({ total: 0, size_known: false }))).toBeNull();
  });

  it("surfaces an action failure on its own row, outside the collapsed details", () => {
    const text = render(task({ state: "failed" }), {
      actionError: new Error("retry refused"),
    });
    expect(text).toContain("retry refused");
  });
});
