import { describe, expect, it } from "vitest";
import type { ExtremeAttachment, ExtremeMessage } from "@/stores/extreme-store";
import {
  historyFor,
  missingPickedHint,
  outputInstruction,
  pickedLines,
  renderManifest,
  type PickedContext,
} from "../chat-context";

const message = (id: string, role: "user" | "assistant", text: string): ExtremeMessage => ({
  id,
  role,
  text,
});

const attachment = (patch: Partial<ExtremeAttachment> & { id: string }): ExtremeAttachment =>
  ({
    name: "app.js",
    size: 2048,
    state: "ready",
    ...patch,
  }) as ExtremeAttachment;

describe("上下文范围", () => {
  const history = [
    message("1", "user", "第一句"),
    message("2", "assistant", "回答一"),
    message("3", "user", "  "),
    message("4", "user", "第二句"),
  ];

  it("当前会话带最近的历史（跳过空消息）", () => {
    expect(historyFor("session", history).map((item) => item.text)).toEqual([
      "第一句",
      "回答一",
      "第二句",
    ]);
  });

  it("仅本条与自选都不带历史", () => {
    expect(historyFor("only", history)).toEqual([]);
    expect(historyFor("picked", history)).toEqual([]);
  });

  it("按上限截取的是**最近**的几条", () => {
    expect(historyFor("session", history, 1).map((item) => item.text)).toEqual(["第二句"]);
  });
});

describe("输出形态", () => {
  it("自动不加任何要求", () => {
    expect(outputInstruction("auto")).toBeNull();
  });

  it("其余三种各自给出明确要求", () => {
    expect(outputInstruction("brief")).toContain("最多三句话");
    expect(outputInstruction("detailed")).toContain("判断依据");
    expect(outputInstruction("structured")).toContain("结论 / 证据 / 下一步");
  });
});

describe("自选材料", () => {
  const picked: PickedContext[] = [
    { kind: "attachment", id: "a1", label: "app.js", detail: "/opt/app/app.js" },
    { kind: "step", id: "s1", label: "重启 nginx", detail: "systemctl restart nginx" },
  ];

  it("按类型分组写进提示词", () => {
    const lines = pickedLines(picked);
    expect(lines[0]).toContain("只依据这些材料");
    expect(lines.join("\n")).toContain("[附件] app.js");
    expect(lines.join("\n")).toContain("[计划步骤] 重启 nginx");
    expect(lines.join("\n")).toContain("systemctl restart nginx");
  });

  it("没有材料时返回空数组（由调用方换成提示）", () => {
    expect(pickedLines([])).toEqual([]);
    expect(missingPickedHint()).toContain("不要假设服务器上的状态");
  });
});

describe("附件清单", () => {
  it("一行一份，写明路径、大小与状态", () => {
    const text = renderManifest([
      attachment({ id: "1", path: "web/app.js" }),
      attachment({ id: "2", name: "logo.png", binary: true }),
      attachment({ id: "3", name: "broken.txt", state: "failed" }),
      attachment({ id: "4", name: "dist.zip", uploadState: "uploaded" }),
    ]);
    expect(text).toContain("web/app.js（2.0 KB）");
    expect(text).toContain("logo.png（2.0 KB，二进制）");
    expect(text).toContain("broken.txt（2.0 KB，读取失败）");
    expect(text).toContain("dist.zip（2.0 KB，已上传）");
  });
});
