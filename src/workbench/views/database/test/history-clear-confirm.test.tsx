import "@/i18n";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { i18n } from "@/i18n";
import { databaseApi } from "@/api/ops-api";
import type { QueryHistoryEntry } from "@/api/types/database";
import { HistoryDialog } from "../HistoryDialog";

/**
 * SQL 历史「清空」属于删除：必须先确认，确认前一次都不能真的清库。
 *
 * 这类"列表上的一个文字按钮"最容易漏确认 —— 点错一下，整段历史就没了。
 */

(
  globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const PROFILE_ID = "profile-1";

const entry: QueryHistoryEntry = {
  id: "h1",
  profile_id: PROFILE_ID,
  session_id: null,
  sql: "select 1",
  succeeded: true,
  rows: 1,
  elapsed_ms: 3,
  error: null,
  created_at: 1_700_000_000_000,
};

const t = (key: string, values?: Record<string, unknown>) =>
  i18n.t(key, values) as string;

async function flush() {
  for (let index = 0; index < 12; index += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

/** 最上层弹窗（确认框）里的按钮。 */
function topDialogButton(text: string): HTMLButtonElement | null {
  const dialogs = Array.from(document.querySelectorAll<HTMLElement>('[role="dialog"]'));
  const top = dialogs[dialogs.length - 1];
  if (!top) return null;
  return (
    Array.from(top.querySelectorAll("button")).find(
      (button) => button.textContent?.trim() === text,
    ) ?? null
  );
}

function footerButton(text: string): HTMLButtonElement | null {
  return (
    Array.from(document.body.querySelectorAll("button")).find(
      (button) => button.textContent?.trim() === text,
    ) ?? null
  );
}

describe("SQL 历史 · 清空", () => {
  let container: HTMLDivElement;
  let root: Root;
  let clearMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    clearMock = vi.fn().mockResolvedValue(undefined);
    vi.spyOn(databaseApi, "historyList").mockResolvedValue([entry]);
    vi.spyOn(databaseApi, "historyClear").mockImplementation(clearMock as never);

    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.restoreAllMocks();
  });

  it("点清空先弹确认，确认前不碰数据库", async () => {
    act(() => {
      root.render(
        <HistoryDialog open onClose={() => undefined} profileId={PROFILE_ID} onPick={() => undefined} />,
      );
    });
    await flush();

    const clearButton = footerButton(t("清空"));
    expect(clearButton).not.toBeNull();
    act(() => clearButton?.click());
    await flush();

    // 确认框出现，但还没清库。
    expect(document.body.textContent).toContain(t("清空全部历史记录？"));
    expect(clearMock).not.toHaveBeenCalled();

    const confirm = topDialogButton(t("清空"));
    expect(confirm).not.toBeNull();
    act(() => confirm?.click());
    await flush();

    expect(clearMock).toHaveBeenCalledTimes(1);
    expect(clearMock).toHaveBeenCalledWith(PROFILE_ID);
  });

  it("取消确认就什么都不做", async () => {
    act(() => {
      root.render(
        <HistoryDialog open onClose={() => undefined} profileId={PROFILE_ID} onPick={() => undefined} />,
      );
    });
    await flush();

    act(() => footerButton(t("清空"))?.click());
    await flush();

    const cancel = topDialogButton(t("Cancel"));
    expect(cancel).not.toBeNull();
    act(() => cancel?.click());
    // 确认框有 150ms 收起动画：等它真的离开 DOM，再断言"没留下来"。
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 220));
    });

    expect(clearMock).not.toHaveBeenCalled();
    expect(document.body.textContent).not.toContain(t("清空全部历史记录？"));
  });
});
