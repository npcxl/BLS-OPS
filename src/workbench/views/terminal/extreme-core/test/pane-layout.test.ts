import { describe, expect, it } from "vitest";
import { paneLayout } from "../pane-layout";

/**
 * 右栏与聊天区的唯一一套约束：
 * 可用 1000 时右栏可以 350 → 650；窗口缩到 700 时临时压到 380，
 * 首选仍是 650，回到 1000 自动恢复。
 */
describe("右栏布局约束", () => {
  it("可用 1000：350 / 650 都原样显示，聊天仍 ≥ 320", () => {
    expect(paneLayout(350, 1000)).toMatchObject({ overlay: false, actual: 350 });
    const wide = paneLayout(650, 1000);
    expect(wide.overlay).toBe(false);
    expect(wide.actual).toBe(650);
    expect(1000 - wide.actual).toBeGreaterThanOrEqual(320);
  });

  it("窗口缩小只压缩实际宽度，首选不变；放大后恢复", () => {
    expect(paneLayout(650, 1000).actual).toBe(650);
    // 可用 700：聊天要留 320，右栏最多 380。
    expect(paneLayout(650, 700)).toMatchObject({ overlay: false, actual: 380 });
    // 回到可用 1000：恢复首选 650。
    expect(paneLayout(650, 1000).actual).toBe(650);
  });

  it("可用宽度小于 620 时切浮层，仍然可调", () => {
    const layout = paneLayout(650, 500);
    expect(layout.overlay).toBe(true);
    expect(layout.actual).toBe(420);
    expect(layout.actual).toBeGreaterThanOrEqual(300);
  });

  it("首选超过可用上限时，右栏最多把聊天压到 320", () => {
    const layout = paneLayout(1000, 1000);
    expect(layout.actual).toBe(680);
    expect(1000 - layout.actual).toBe(320);
  });

  it("外拖新增宽度全部给右栏，聊天宽度不变", () => {
    const before = paneLayout(650, 1000);
    // 窗口外扩 80，右栏首选同步 +80。
    const after = paneLayout(730, 1080);
    expect(before.actual).toBe(650);
    expect(after.actual).toBe(730);
    expect(1000 - before.actual).toBe(1080 - after.actual);
  });
});
