import { beforeEach, describe, expect, it, vi } from "vitest";
import { i18n } from "@/i18n";

const h = vi.hoisted(() => ({ copy: vi.fn(), toast: vi.fn() }));
vi.mock("@/lib/clipboard", () => ({ copyText: h.copy }));
vi.mock("@/components/ui/toast", () => ({ pushToast: h.toast }));
import { copyTextWithFeedback } from "../clipboard-feedback";

beforeEach(() => vi.clearAllMocks());
describe("menu clipboard feedback", () => {
  it("shows the shared compact success feedback only after a successful write", async () => {
    h.copy.mockResolvedValue(true);
    expect(await copyTextWithFeedback("sys_menu")).toBe(true);
    expect(h.copy).toHaveBeenCalledWith("sys_menu");
    expect(h.toast).toHaveBeenCalledWith(i18n.t("Copied"), "success", {variant:"copy",persist:false});
  });
  it("reports a rejected clipboard write as an error", async () => {
    h.copy.mockResolvedValue(false);
    expect(await copyTextWithFeedback("sys_menu")).toBe(false);
    expect(h.toast).toHaveBeenCalledTimes(1);
    expect(h.toast).toHaveBeenCalledWith(i18n.t("Copy failed. Please check clipboard permission"), "error", {variant:undefined,persist:false});
  });
});
