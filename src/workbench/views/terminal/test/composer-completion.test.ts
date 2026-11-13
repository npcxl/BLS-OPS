import { describe, expect, it } from "vitest";

// Provider 生成说明文字时会用 i18n.t（未命中 key 原样返回）。
import "@/i18n";

import { replaceSegment, resolveComposerKey } from "../composer-keys";
import {
  historyItems,
  rankByHistory,
  rankByUsage,
  snapshotMatches,
  type ComposerItem,
} from "../use-composer-completion";
import { parseLine } from "../completion/path-input";

/**
 * 弧形输入栏补全的回归测试。
 *
 * 渲染 `CurvedInput` 需要 `ResizeObserver` / `getComputedTextLength`（jsdom 没有），
 * 所以这里覆盖**决策逻辑**：键盘判定、片段替换、快照失效、历史召回与排序。
 * 视觉部分（弧线文字、光标位置）只能桌面实测，见交付说明。
 */

function item(overrides: Partial<ComposerItem> = {}): ComposerItem {
  return {
    label: "docker",
    insertText: "docker ",
    detail: "",
    icon: "command",
    type: "command",
    replaceRange: { start: 0, end: 6 },
    priority: 0,
    source: "command",
    ...overrides,
  };
}

describe("原始输入快照：旧候选必须失效", () => {
  it("快速输入后立刻按 Tab：候选还没跟上 → Tab 不接管", () => {
    // 候选是给 "doc" 算的，用户已经打到 "dock"。
    const snapshot = { text: "doc", caret: 3, sessionId: "s1" };
    const current = { text: "dock", caret: 4, sessionId: "s1" };
    expect(snapshotMatches(snapshot, current)).toBe(false);

    // Tab 在候选不可用时放行（恢复正常焦点导航），不会填入旧候选。
    expect(
      resolveComposerKey(
        { key: "Tab" },
        { listOpen: false, hasUsableItems: false, hasItems: true, hasDraft: true },
      ),
    ).toEqual({ type: "none" });
  });

  it("切换服务器后旧请求晚到：会话不同 → 整批丢弃", () => {
    const snapshot = { text: "doc", caret: 3, sessionId: "s1" };
    expect(snapshotMatches(snapshot, { text: "doc", caret: 3, sessionId: "s2" })).toBe(false);
  });

  it("光标在同一条命令里移动也算过期", () => {
    const snapshot = { text: "docker logs", caret: 11, sessionId: "s1" };
    expect(snapshotMatches(snapshot, { text: "docker logs", caret: 7, sessionId: "s1" })).toBe(false);
  });
});

describe("补全只替换光标所在的词", () => {
  it("光标在词中间：保留后面的参数", () => {
    const text = "docker logs nginx --tail 100";
    // 光标在 `ng|inx` 处。
    const caret = "docker logs ng".length;
    const parsed = parseLine(text, caret);
    expect(parsed.token?.start).toBe("docker logs ".length);
    expect(parsed.token?.end).toBe("docker logs nginx".length);

    const result = replaceSegment(
      text,
      { start: parsed.token!.start, end: parsed.token!.end },
      "nginx-prod",
    );
    expect(result.text).toBe("docker logs nginx-prod --tail 100");
    // 光标停在插入内容之后，可以接着补下一个参数。
    expect(result.caret).toBe("docker logs nginx-prod".length);
  });

  it("带引号与管道时只动当前词", () => {
    const text = `grep "foo bar" access.log | head`;
    const caret = text.indexOf("access.log") + 3;
    const parsed = parseLine(text, caret);
    const result = replaceSegment(
      text,
      { start: parsed.token!.start, end: parsed.token!.end },
      "app.log",
    );
    expect(result.text).toBe(`grep "foo bar" app.log | head`);
  });
});

describe("历史候选", () => {
  const history = ["journalctl -u nginx", "docker ps -a", "docker logs nginx"];

  it("命令库外的自定义命令也能召回，并标 history", () => {
    const items = historyItems("jour", 4, history);
    expect(items[0]?.insertText).toBe("journalctl -u nginx");
    expect(items[0]?.fromHistory).toBe(true);
    // 只替换命令词本身。
    expect(items[0]?.replaceRange).toEqual({ start: 0, end: 4 });
  });

  it("已经在输参数时不给整条历史，避免覆盖参数", () => {
    // `docker logs ng` → 有空格（已进参数），历史是整条命令，插进去会吃掉后面。
    expect(historyItems("docker logs ng", "docker logs ng".length, history)).toEqual([]);
  });

  it("两台服务器的历史互不串味", () => {
    const web = historyItems("jour", 4, ["journalctl -u nginx"]);
    const db = historyItems("jour", 4, ["journalctl -u postgres"]);
    expect(web[0]?.insertText).toContain("nginx");
    expect(db[0]?.insertText).toContain("postgres");
    expect(web[0]?.insertText).not.toBe(db[0]?.insertText);
  });

  it("按最近使用排序：最近执行过的命令名排前面", () => {
    const ranked = rankByHistory(
      [
        item({ label: "docker", priority: 1 }),
        item({ label: "systemctl", priority: 1 }),
      ],
      ["systemctl restart nginx", "docker ps"],
    );
    expect(ranked[0]?.label).toBe("systemctl");
  });
});

describe("按使用习惯排序（命令 + 子命令分别统计）", () => {
  const sub = (label: string) => item({ label, insertText: `${label} `, priority: 2 });

  it("区分 docker logs 与 docker ps：logs 用得多就排前面", () => {
    const history = ["docker logs nginx", "docker logs api", "docker ps"];
    const ranked = rankByUsage([sub("ps"), sub("logs")], history, "docker");
    expect(ranked[0]?.label).toBe("logs");
    expect(ranked[1]?.label).toBe("ps");
  });

  it("只统计到两个词：`docker ps` 不会把 `docker logs` 也抬起来", () => {
    // 只有 ps 用过；logs 的权重要保持 0，顺序按默认。
    const history = ["docker ps", "docker ps -a", "docker ps"];
    const ranked = rankByUsage([sub("logs"), sub("ps")], history, "docker");
    expect(ranked[0]?.label).toBe("ps");
  });

  it("首次使用（该服务器没有历史）沿用命令库默认顺序", () => {
    const ranked = rankByUsage([sub("ps"), sub("logs")], [], "docker");
    expect(ranked.map((entry) => entry.label)).toEqual(["ps", "logs"]);
  });

  it("两台服务器的历史互不影响：一台常用 logs，另一台常用 ps", () => {
    const web = ["docker logs nginx", "docker logs api"];
    const db = ["docker ps", "docker ps -a", "docker ps --format x"];
    expect(rankByUsage([sub("ps"), sub("logs")], web, "docker")[0]?.label).toBe("logs");
    expect(rankByUsage([sub("ps"), sub("logs")], db, "docker")[0]?.label).toBe("ps");
  });
});

describe("键盘", () => {
  const open = { listOpen: true, hasUsableItems: true, hasItems: true, hasDraft: true };
  const closed = { listOpen: false, hasUsableItems: true, hasItems: true, hasDraft: true };

  it("Esc 只收起候选，不清草稿", () => {
    expect(resolveComposerKey({ key: "Escape" }, open)).toEqual({ type: "close-list" });
    // 列表本来就没开：Esc 什么都不做（草稿留着）。
    expect(resolveComposerKey({ key: "Escape" }, closed)).toEqual({ type: "none" });
  });

  it("无候选时 Tab 走正常焦点导航", () => {
    expect(
      resolveComposerKey(
        { key: "Tab" },
        { listOpen: false, hasUsableItems: false, hasItems: false, hasDraft: true },
      ),
    ).toEqual({ type: "none" });
  });

  it("Ctrl+Space 展开列表", () => {
    expect(resolveComposerKey({ key: " ", code: "Space", ctrlKey: true }, closed)).toEqual({
      type: "list-toggle",
    });
  });

  it("列表展开时 ↑↓ 选候选，收起时翻历史", () => {
    expect(resolveComposerKey({ key: "ArrowDown" }, open)).toEqual({ type: "move", delta: 1 });
    expect(resolveComposerKey({ key: "ArrowUp" }, closed)).toEqual({ type: "history", delta: -1 });
  });

  it("候选栏可见时数字直接选候选（输入法式）", () => {
    expect(resolveComposerKey({ key: "1" }, open)).toEqual({ type: "pick", index: 0 });
    expect(resolveComposerKey({ key: "3" }, open)).toEqual({ type: "pick", index: 2 });
    // 空格永远只是空格。
    expect(resolveComposerKey({ key: " " }, open)).toEqual({ type: "none" });
    // 候选栏收起（参数阶段）时数字照常输入。
    expect(resolveComposerKey({ key: "1" }, closed)).toEqual({ type: "none" });
  });

  it("Alt+1~6 才是编号选择", () => {
    expect(resolveComposerKey({ key: "2", altKey: true }, open)).toEqual({
      type: "pick",
      index: 1,
    });
    // 越界由调用方判断（这一页没那么多条就放行）。
    expect(
      resolveComposerKey({ key: "6", altKey: true }, { ...open, pageCount: 1 }),
    ).toEqual({ type: "pick", index: 5 });
  });

  it("多页时 = / - 翻页，单页时仍是普通字符", () => {
    const paged = { ...open, pageCount: 3 };
    expect(resolveComposerKey({ key: "=" }, paged)).toEqual({ type: "page", delta: 1 });
    expect(resolveComposerKey({ key: "-" }, paged)).toEqual({ type: "page", delta: -1 });
    expect(resolveComposerKey({ key: "-" }, { ...open, pageCount: 1 })).toEqual({ type: "none" });
  });

  it("中文选字期间回车不执行命令", () => {
    expect(
      resolveComposerKey({ key: "Enter", isComposing: true }, open),
    ).toEqual({ type: "none" });
    // 组词期间的 Tab / Esc 也让给输入法。
    expect(resolveComposerKey({ key: "Tab", isComposing: true }, open)).toEqual({ type: "none" });
  });
});
