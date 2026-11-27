import { describe, expect, it } from "vitest";
import {
  attachmentReadState,
  readAttachment,
  remoteAttachment,
  remoteAttachmentId,
} from "../attachments";
import { attachmentFile, attachmentSource, dropAttachmentFile } from "../attachments/payload";

/**
 * 远程文件 → 附件：**会话 + 路径**是身份。
 *
 * 这两个函数决定了右键「添加到对话」到底是"复用"还是"新建"，也被发送时的
 * 快照用来判断"读到了什么"，所以单独钉住。
 */
describe("remoteAttachmentId", () => {
  it("同一会话同一路径 → 同一个 id（反复右键复用一份）", () => {
    const a = remoteAttachmentId("sess-1", "/etc/nginx/nginx.conf");
    const b = remoteAttachmentId("sess-1", "/etc/nginx/nginx.conf");
    expect(a).toBe(b);
  });

  it("不同会话的同名同路径 → 不是同一个附件", () => {
    expect(remoteAttachmentId("sess-1", "/etc/nginx/nginx.conf")).not.toBe(
      remoteAttachmentId("sess-2", "/etc/nginx/nginx.conf"),
    );
  });

  it("同一会话的不同路径 → 不同附件", () => {
    expect(remoteAttachmentId("sess-1", "/etc/nginx/nginx.conf")).not.toBe(
      remoteAttachmentId("sess-1", "/etc/nginx/mime.types"),
    );
  });
});

describe("remoteAttachment", () => {
  it("文件：先标「读取中」，路径与已上传状态立刻可用", () => {
    const item = remoteAttachment(
      { name: "nginx.conf", path: "/etc/nginx/nginx.conf", size: 1200, kind: "file" },
      "sess-1",
    );
    expect(item).toMatchObject({
      id: remoteAttachmentId("sess-1", "/etc/nginx/nginx.conf"),
      name: "nginx.conf",
      remotePath: "/etc/nginx/nginx.conf",
      path: "/etc/nginx/nginx.conf",
      size: 1200,
      // 还没读正文：状态是 pending，但"在服务器上"是事实。
      state: "pending",
      uploadState: "uploaded",
    });
  });

  it("目录：没有正文可读，直接可用", () => {
    const item = remoteAttachment(
      { name: "sites-enabled", path: "/etc/nginx/sites-enabled", size: 0, kind: "directory" },
      "sess-1",
    );
    expect(item.state).toBe("ready");
    expect(item.remotePath).toBe("/etc/nginx/sites-enabled");
  });
});

describe("readAttachment 二进制不再被 8 MB 硬限制", () => {
  it("刚过旧上限的 dist.zip 仍然读成 ready，且内容不进 React 状态", async () => {
    const file = new File([new Uint8Array(8 * 1024 * 1024 + 1)], "dist.zip");
    const item = await readAttachment(file, {
      id: "att-big",
      t: ((key: string) => key) as never,
    });
    expect(item.state).toBe("ready");
    expect(item.binary).toBe(true);
    // 大文件只留句柄：避免 11 MB base64 常驻 store / 历史库。
    expect(item.data).toBeUndefined();
    expect(attachmentFile("att-big")).toBe(file);
  });

  it("小二进制仍保留 base64（预览 / 旧接口用）", async () => {
    const file = new File([new Uint8Array(1024)], "logo.png");
    const item = await readAttachment(file, {
      id: "att-small",
      t: ((key: string) => key) as never,
    });
    expect(item.data?.length).toBeGreaterThan(0);
    expect(attachmentFile("att-small")).toBe(file);
  });

  it("大文本截取上下文但仍可上传（不再直接判失败）", async () => {
    const file = new File(["x".repeat(1024 * 1024)], "app.log");
    const item = await readAttachment(file, {
      id: "att-text",
      t: ((key: string) => key) as never,
    });
    expect(item.state).toBe("ready");
    expect(item.text?.length).toBeGreaterThan(0);
    expect(item.text).toContain("完整文件仍会上传");
    expect(item.textPartial).toBe(true);
    // 上下文截断了，但上传源仍是完整文件（不是那半截文本）。
    expect(attachmentSource(item)?.total).toBe(file.size);

    // 模拟应用重启：句柄没了，绝不能拿半截文本重传覆盖完整副本。
    dropAttachmentFile("att-text");
    expect(attachmentSource(item)).toBeNull();
  });
});

describe("attachmentReadState", () => {
  const base = { id: "x", name: "x", size: 1, state: "ready" as const };

  it("读到正文 = text", () => {
    expect(attachmentReadState({ ...base, text: "server {}" })).toBe("text");
  });

  it("二进制 = binary（元信息可用，内容不发）", () => {
    expect(attachmentReadState({ ...base, binary: true })).toBe("binary");
  });

  it("读失败 = failed（路径仍然有效）", () => {
    expect(attachmentReadState({ ...base, error: "permission denied" })).toBe("failed");
  });

  it("还没读 = pending", () => {
    expect(attachmentReadState({ ...base, state: "pending" })).toBe("pending");
  });

  it("读失败优先于二进制：先说明为什么没有正文", () => {
    expect(
      attachmentReadState({ ...base, binary: true, error: "connection closed" }),
    ).toBe("failed");
  });
});
