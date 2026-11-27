import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { opsApi } from "@/api/ops-api";
import { MemorySettings } from "../view/MemorySettings";

it("shows a title and exposes details and actions when expanded", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const list = vi.spyOn(opsApi, "extremeMemoryList").mockResolvedValue([{
    id: "m1", scope: "global", serverId: null, workspaceId: null,
    title: "部署偏好", content: "上线前先检查并备份", source: "user", updatedAt: 1000,
  }]);
  const holder = document.body.appendChild(document.createElement("div"));
  const root = createRoot(holder);
  try {
    await act(async () => { root.render(<MemorySettings />); });
    const details = holder.querySelector("details");
    expect(details?.querySelector("summary")?.textContent).toContain("部署偏好");
    expect(details?.open).toBe(false);
    await act(async () => { details!.open = true; });
    expect(details?.textContent).toContain("上线前先检查并备份");
    expect(details?.querySelectorAll("button").length).toBe(2);
  } finally {
    await act(async () => root.unmount());
    holder.remove(); list.mockRestore(); vi.unstubAllGlobals();
  }
});
