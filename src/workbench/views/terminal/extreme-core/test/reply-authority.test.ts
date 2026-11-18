import { describe, expect, it } from "vitest";
import { shouldBackfillPrefix, terminalReplyText } from "../reply-authority";

/**
 * P0 回归：流式中途重进后，回答不能缺开头。
 *
 * 判定是纯函数：这里穷举"气泡现状 × 权威全文"的组合，
 * 锁住"完整值覆盖增量、cancelled 不清正文、竞态不回滚"三条原则。
 */
describe("terminalReplyText（终态权威覆盖）", () => {
  const FULL = "第一段结论。第二段细节。";

  it("finished：气泡只有后半段（重进场景）→ 用全文覆盖", () => {
    expect(terminalReplyText("finished", FULL, "第二段细节。", "已停止。")).toBe(FULL);
  });
  it("finished：气泡为空 → 回填全文", () => {
    expect(terminalReplyText("finished", FULL, "", "已停止。")).toBe(FULL);
  });
  it("finished：气泡已是全文 → 不动（避免无谓重渲染）", () => {
    expect(terminalReplyText("finished", FULL, FULL, "已停止。")).toBeNull();
  });
  it("finished：权威值为空 → 不清掉已有正文", () => {
    expect(terminalReplyText("finished", "", "半截回答", "已停止。")).toBeNull();
  });
  it("cancelled：气泡为空才写停止提示", () => {
    expect(terminalReplyText("cancelled", "", "", "已停止。")).toBe("已停止。");
  });
  it("cancelled：已有半截回答 → 保留，不覆盖", () => {
    expect(terminalReplyText("cancelled", FULL, "半截回答", "已停止。")).toBeNull();
  });
  it("failed：一律不动正文（错误在卡片与错误条上）", () => {
    expect(terminalReplyText("failed", FULL, "", "已停止。")).toBeNull();
    expect(terminalReplyText("failed", FULL, "半截回答", "已停止。")).toBeNull();
  });
});

describe("shouldBackfillPrefix（重进接回 running 任务）", () => {
  const PREFIX = "第一段结论。第二段开头";

  it("气泡为空 → 回填快照前缀", () => {
    expect(shouldBackfillPrefix(PREFIX, "")).toBe(true);
  });
  it("气泡只有后缀片段（P0 场景）→ 回填，片段已包含在快照里", () => {
    expect(shouldBackfillPrefix(PREFIX, "第二段开头")).toBe(true);
  });
  it("气泡是快照的旧前缀 → 回填到最新", () => {
    expect(shouldBackfillPrefix(PREFIX, "第一段结论。")).toBe(true);
  });
  it("气泡与快照一致 → 不动", () => {
    expect(shouldBackfillPrefix(PREFIX, PREFIX)).toBe(false);
  });
  it("气泡比快照更新（竞态）→ 不回滚，保住新到的尾巴", () => {
    expect(shouldBackfillPrefix(PREFIX, `${PREFIX}，增量继续`)).toBe(false);
  });
  it("快照为空 → 不动", () => {
    expect(shouldBackfillPrefix("", "半截回答")).toBe(false);
  });
});
