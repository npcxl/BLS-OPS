import { beforeEach, describe, expect, it } from "vitest";
import { useExtremeStore } from "@/stores/extreme-store";

const PANE_KEY = "bls-ops.extreme-pane.v1";

/**
 * 右栏宽度的落盘时机。
 *
 * 拖动分隔线时每个 `pointermove` 都写一次 localStorage（序列化整份面板状态）
 * 是可定位的卡顿来源：中间帧只改内存，松手那一次才写。
 */
describe("右栏宽度的持久化", () => {
  beforeEach(() => {
    localStorage.removeItem(PANE_KEY);
    useExtremeStore.getState().setPaneWidth(360);
    localStorage.removeItem(PANE_KEY);
  });

  it("拖动中的中间帧只改内存，不写本地存储", () => {
    useExtremeStore.getState().setPaneWidth(420, { persist: false });
    expect(useExtremeStore.getState().paneWidth).toBe(420);
    expect(localStorage.getItem(PANE_KEY)).toBeNull();
  });

  it("松手（默认 persist）才落盘，只保底下限、上限交给容器", () => {
    useExtremeStore.getState().setPaneWidth(960);
    expect(useExtremeStore.getState().paneWidth).toBe(960);
    const saved = JSON.parse(localStorage.getItem(PANE_KEY) ?? "{}") as { width?: number };
    expect(saved.width).toBe(960);

    useExtremeStore.getState().setPaneWidth(120);
    expect(useExtremeStore.getState().paneWidth).toBe(300);
    expect(
      (JSON.parse(localStorage.getItem(PANE_KEY) ?? "{}") as { width?: number }).width,
    ).toBe(300);
  });

  it("中间帧之后松手：最终值以松手那次为准", () => {
    useExtremeStore.getState().setPaneWidth(400, { persist: false });
    useExtremeStore.getState().setPaneWidth(460, { persist: false });
    useExtremeStore.getState().setPaneWidth(460);
    expect(useExtremeStore.getState().paneWidth).toBe(460);
    expect(
      (JSON.parse(localStorage.getItem(PANE_KEY) ?? "{}") as { width?: number }).width,
    ).toBe(460);
  });
});
