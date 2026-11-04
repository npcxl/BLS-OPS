import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@/i18n";
import { ExportDialog } from "../ExportDialog";
import { exportFileName } from "../export-formats";

const api = vi.hoisted(() => ({
  pickExportPath: vi.fn(), exportStart: vi.fn(), exportRemove: vi.fn(),
  exportStatus: vi.fn(), exportOutcome: vi.fn(), exportCancel: vi.fn(),
}));
vi.mock("@/api/ops-api", () => ({ databaseApi: api }));
vi.mock("@/components/ui/toast", () => ({pushToast: vi.fn()}));
(globalThis as {IS_REACT_ACT_ENVIRONMENT?: boolean}).IS_REACT_ACT_ENVIRONMENT = true;
let holder: HTMLDivElement;
let root: Root;
const click = async (text: string) => {
  const button = Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find(b => b.textContent?.trim() === text);
  expect(button, text).toBeDefined();
  await act(async () => button!.click());
};
const formatMenu = async () => act(async () => document.querySelector<HTMLButtonElement>('button[aria-label="文件格式"]')!.click());
const render = async (table = true) => act(async () => root.render(<ExportDialog open onClose={() => undefined} profileId="test" sql="SELECT 1"
  table={table ? { database: "main", table: "items", filters: [], sorts: [] } : null} />));
beforeEach(() => {
  vi.clearAllMocks();
  api.pickExportPath.mockResolvedValue("C:\\export\\items.json");
  api.exportStart.mockResolvedValue({export_id: "export-1"});
  api.exportRemove.mockResolvedValue(undefined);
  holder = document.createElement("div"); document.body.appendChild(holder); root = createRoot(holder);
});
afterEach(async () => { await act(async () => root.unmount()); holder.remove(); });

describe("export formats and native path authorization", () => {
  it("submits the selected format and disables BOM for JSON", async () => {
    await render(); await formatMenu(); await click("JSON.json");
    expect(document.querySelector('[role="switch"]')).toBeNull();
    await click("浏览…");
    expect(api.pickExportPath).toHaveBeenCalledWith(expect.stringMatching(/\.json$/), "json");
    await click("开始导出");
    expect(api.exportStart).toHaveBeenCalledWith("test", expect.objectContaining({format: "json", bom: false, target_path: "C:\\export\\items.json"}));
    expect(document.querySelector<HTMLButtonElement>('button[aria-label="文件格式"]')?.disabled).toBe(true);
  });
  it("requires a fresh save location after changing the file type", async () => {
    await render(); await click("浏览…");
    await formatMenu(); await click("JSON.json"); await click("开始导出");
    expect(api.exportStart).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain("请选择导出文件路径");
  });
  it("does not pretend a query result has an INSERT target", async () => {
    await render(false); await formatMenu();
    const sql = Array.from(document.querySelectorAll<HTMLButtonElement>('[role="option"]')).find(n => n.textContent?.includes("SQL INSERT"));
    expect(sql?.disabled).toBe(true);
  });
  it("changes extensions without changing directories or duplicating the old suffix", () => {
    expect(exportFileName("C:\\folder.csv\\orders.CSV", "jsonl")).toBe("C:\\folder.csv\\orders.jsonl");
    expect(exportFileName("orders", "xml")).toBe("orders.xml");
  });
});
