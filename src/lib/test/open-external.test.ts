import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ invoke: vi.fn(), openUrl: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: h.invoke }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: h.openUrl }));
import { openExternal } from "../open-external";

beforeEach(() => vi.clearAllMocks());

describe("external links", () => {
  it("asks the backend for Chrome when the caller requests it", async () => {
    h.invoke.mockResolvedValue(undefined);
    await expect(
      openExternal("https://example.com", { browser: "chrome" }),
    ).resolves.toBe(true);
    expect(h.invoke).toHaveBeenCalledWith("open_external_url", {
      url: "https://example.com",
      browser: "chrome",
    });
    expect(h.openUrl).not.toHaveBeenCalled();
  });

  it("falls back to the default browser when Chrome cannot be launched", async () => {
    h.invoke.mockRejectedValueOnce(new Error("no chrome"));
    h.openUrl.mockResolvedValue(undefined);
    await expect(
      openExternal("https://example.com", { browser: "chrome" }),
    ).resolves.toBe(true);
    expect(h.openUrl).toHaveBeenCalledWith("https://example.com");
  });

  it("keeps the opener-first order for the system default browser", async () => {
    h.openUrl.mockResolvedValue(undefined);
    await expect(openExternal("https://example.com")).resolves.toBe(true);
    expect(h.openUrl).toHaveBeenCalledTimes(1);
    expect(h.invoke).not.toHaveBeenCalled();
  });

  it("reports failure only when every path fails", async () => {
    h.openUrl.mockRejectedValue(new Error("no handler"));
    h.invoke.mockRejectedValue(new Error("spawn failed"));
    await expect(openExternal("https://example.com")).resolves.toBe(false);
  });
});
