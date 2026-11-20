import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { i18n } from "@/i18n";
import type { ExtremeAttachment, ExtremeMessage } from "@/stores/extreme-store";
import {
  historyFor,
  missingPickedHint,
  outputInstruction,
  pickedLines,
  renderManifest,
  shouldAttachTerminalTail,
  terminalTailBlock,
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

/*
 * 这些用例断言的是中文提示词的具体措辞；测试环境默认英文（i18n 在 test 模式
 * 固定 en），不切语言会把"英文实现正确"误判成失败。英文分支另有 UI 用例覆盖。
 */
const originalLanguage = i18n.language;
beforeAll(async () => {
  await i18n.changeLanguage("zh-CN");
});
afterAll(async () => {
  await i18n.changeLanguage(originalLanguage);
});

describe("上下文范围", () => {
  const history = [
    message("1", "user", "第一句"),
    message("2", "assistant", "回答一"),
    message("3", "user", "  "),
    message("4", "user", "第二句"),
  ];

  it("当前会话带整段历史（跳过空消息）", () => {
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

  /*
   * 不再按条数截断：以前是"最近 6 条"，长任务只剩最近两三轮，模型看不到
   * 前面的结论，界面上的"上下文"也随之失真。裁剪交给 Rust 的 token 预算。
   */
  it("长对话一条都不丢", () => {
    const long = Array.from({ length: 40 }, (_, index) =>
      message(`m${index}`, index % 2 === 0 ? "user" : "assistant", `第 ${index} 句`),
    );
    expect(historyFor("session", long)).toHaveLength(40);
    expect(historyFor("session", long)[0].text).toBe("第 0 句");
  });
});

describe("终端输出的上下文规则", () => {
  const output = [
    { kind: "output" as const, id: "terminal:ws-a", label: "真实终端最近 3 行", detail: "$ uptime\n..." },
  ];

  it("「当前会话」自动带（它属于这段对话的上下文）", () => {
    expect(shouldAttachTerminalTail("session", [])).toBe(true);
  });

  it("「仅本条 / 自选」不自动带：模型不该凭空知道用户刚才在终端里跑了什么", () => {
    expect(shouldAttachTerminalTail("only", [])).toBe(false);
    expect(shouldAttachTerminalTail("picked", [])).toBe(false);
  });

  it("已经手动「加入本次对话」：不重复带同一段", () => {
    expect(shouldAttachTerminalTail("session", output)).toBe(false);
  });

  it("空输出不产生段落（避免空代码块）", () => {
    expect(terminalTailBlock("   \n ")).toBe("");
    expect(terminalTailBlock("$ uptime")).toContain("$ uptime");
    expect(terminalTailBlock("$ uptime")).toContain("真实终端");
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

  it("服务器上的文件没读到正文：保留路径并写明按路径读取", () => {
    const text = renderManifest([
      attachment({
        id: "r1",
        name: "nginx.conf",
        path: "/etc/nginx/nginx.conf",
        remotePath: "/etc/nginx/nginx.conf",
        uploadState: "uploaded",
        error: "permission denied",
      }),
    ]);
    expect(text).toContain("/etc/nginx/nginx.conf");
    expect(text).toContain("未读到正文，按路径读取");
  });
});
