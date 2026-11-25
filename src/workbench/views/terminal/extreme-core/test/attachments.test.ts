import { describe, expect, it } from "vitest";
import {
  attachmentReadState,
  readAttachment,
  remoteAttachment,
  remoteAttachmentId,
} from "../attachments";

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
  it("刚过旧上限的 dist.zip 仍然读成 ready", async () => {
    const file = new File([new Uint8Array(8 * 1024 * 1024 + 1)], "dist.zip");
    const item = await readAttachment(file, {
      id: "att-big",
      t: ((key: string) => key) as never,
    });
    expect(item.state).toBe("ready");
    expect(item.binary).toBe(true);
    expect(item.data?.length).toBeGreaterThan(0);
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
