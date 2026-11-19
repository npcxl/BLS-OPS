import { describe, expect, it } from "vitest";
import {
  nextSend,
  queuedSend,
  removeSend,
  sendsFor,
  enqueueSend,
  forgetSends,
  markSendError,
} from "../send-queue";

/**
 * 「完成后发送」按**对话**分桶、FIFO。
 *
 * 以前只有一个全局槽位：A 排一条、B 排一条就把 A 覆盖掉；同一条对话连排两条
 * 也只留最后一条。这组用例钉住"三条都保留、各自按顺序、失败不跳过"。
 */

function item(workspaceId: string, text: string, id?: string) {
  return queuedSend({
    id,
    workspaceId,
    text,
    attachments: [],
    selection: { providerId: "p1", model: "m", effort: "auto", contextBudget: null },
    context: "session",
    output: "auto",
    picked: [],
  });
}

describe("发送队列", () => {
  it("同一对话连续两条都保留，且保持提交顺序", () => {
    const a1 = item("ws-a", "第一条", "q1");
    const a2 = item("ws-a", "第二条", "q2");
    const b1 = item("ws-b", "B 的一条", "q3");
    const queue = [a1, a2, b1].reduce(enqueueSend, [] as ReturnType<typeof item>[]);

    expect(queue).toHaveLength(3);
    expect(sendsFor(queue, "ws-a").map((entry) => entry.text)).toEqual(["第一条", "第二条"]);
    expect(sendsFor(queue, "ws-b").map((entry) => entry.text)).toEqual(["B 的一条"]);
    // 每条有独立 id：取消一条不能带走另一条。
    expect(new Set(queue.map((entry) => entry.id)).size).toBe(3);
  });

  it("派发只取队首；队首失败时后面的不抢跑", () => {
    const queue = [item("ws-a", "一", "q1"), item("ws-a", "二", "q2")];
    expect(nextSend(queue, "ws-a")?.id).toBe("q1");

    const failed = markSendError(queue, "q1", "服务器未连接");
    // 失败项保留并带原因，后面的等它处理完 —— 顺序不能乱。
    expect(nextSend(failed, "ws-a")).toBeNull();
    expect(sendsFor(failed, "ws-a")[0].error).toBe("服务器未连接");
  });

  it("取消只删目标项；删除对话会清掉它自己的队列", () => {
    const queue = [
      item("ws-a", "一", "q1"),
      item("ws-a", "二", "q2"),
      item("ws-b", "三", "q3"),
    ];
    expect(removeSend(queue, "q2").map((entry) => entry.id)).toEqual(["q1", "q3"]);
    expect(forgetSends(queue, "ws-a").map((entry) => entry.id)).toEqual(["q3"]);
  });
});
