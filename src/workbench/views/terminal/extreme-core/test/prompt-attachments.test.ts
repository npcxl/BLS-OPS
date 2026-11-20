import { describe, expect, it } from "vitest";
import type { ExtremeAttachment, ExtremeMessage } from "@/stores/extreme-store";
import type { ActionScope } from "../action-scope";
import { buildMessages } from "../view/prompt";

/**
 * 用**这条消息**的附件指代「这个文件」。
 *
 * 线上问题：用户新拖入一个文件，`focusId` 还停在上一轮的文件上，模型就继续
 * 读旧文件。这里验证两件事：
 * 1. 用户轮次里有显式的「本条消息附带的文件」；
 * 2. 焦点按消息附件重算，新文件排在旧文件前面。
 */
function attachment(
  id: string,
  name: string,
  text: string,
  path: string,
): ExtremeAttachment {
  return {
    id,
    name,
    size: text.length,
    path,
    state: "ready",
    text,
    binary: false,
    uploadState: "uploaded",
  };
}

function scope(attachments: ExtremeAttachment[], focusId: string | null): ActionScope {
  return {
    workspaceId: "ws-a",
    serverId: "srv-a",
    server: "A",
    sessionId: "sess-a",
    requestId: 1,
    home: "/root",
    permission: "readonly",
    preflight: null,
    envChecks: [],
    attachments,
    prefs: { context: "session", output: "auto", picked: [] },
    focusId,
    selectedAttachmentIds: ["att-new"],
    plan: null,
    planSession: null,
    planTaskId: null,
    candidates: null,
  };
}

describe("buildMessages：本条消息的附件", () => {
  it("用户轮次明确指代新附件，焦点不再沿用上一轮", () => {
    const oldFile = attachment(
      "att-old",
      "index.html",
      "<div id=\"root\"></div>",
      "/opt/bls-ops/dist/index.html",
    );
    const newFile = attachment(
      "att-new",
      "pydistutils.cfg",
      "[install]\nprefix=/usr/local",
      "/root/pydistutils.cfg",
    );
    const message: ExtremeMessage = {
      id: "m-new",
      role: "user",
      text: "更改这个文件内容，往里面随便写点单词。",
      attachmentIds: ["att-new"],
    };

    const messages = buildMessages(
      message,
      scope([oldFile, newFile], "att-old"),
      [message],
      { locale: "zh-CN" },
    );

    const user = messages.find((turn) => turn.role === "user" && turn.content.includes(message.text));
    expect(user?.content).toContain("【本条消息附带的文件】");
    expect(user?.content).toContain("pydistutils.cfg");
    expect(user?.content).not.toContain("index.html");

    const system = messages.find((turn) => turn.role === "system")?.content ?? "";
    // 附件正文块里，本条消息的焦点文件排在第一（旧文件不会抢额度）。
    const blocks = system.slice(system.indexOf("用户上传的附件"));
    expect(blocks).toContain("--- pydistutils.cfg");
    expect(blocks).toContain("--- index.html");
    expect(blocks.indexOf("--- pydistutils.cfg")).toBeLessThan(
      blocks.indexOf("--- index.html"),
    );
  });
});
