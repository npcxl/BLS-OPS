import { describe, expect, it } from "vitest";
import {
  planReport,
  reportStatusLabel,
  requestedUploadReport,
  runReport,
  uploadReceipt,
  uploadReport,
} from "../execution-report";

/** 只做 `{{name}}` 替换的翻译桩：断言的仍然是文案骨架。 */
const t = (key: string, options?: Record<string, unknown>) =>
  Object.entries(options ?? {}).reduce(
    (text, [name, value]) => text.replace(`{{${name}}}`, String(value)),
    key,
  );

const ROOT = "/root/.bls-ops/extreme-ws1";

describe("上传结果", () => {
  it("刚开始时先占一行「已请求」，目录可直接点开", () => {
    const report = requestedUploadReport(t, { count: 3, root: ROOT });
    expect(report).toMatchObject({ id: "upload", status: "requested", path: ROOT });
    expect(report.title).toContain("已请求上传 3 个文件");
  });

  it("全部写成功：标题说清数量和去处，不报失败明细", () => {
    const report = uploadReport(t, { written: 3, reused: 0, failures: [], root: ROOT });
    expect(report.status).toBe("success");
    expect(report.title).toBe("已上传 3 个文件到服务器临时目录");
    expect(report.detail).toBeUndefined();
    expect(report.path).toBe(ROOT);
  });

  it("复用已存在的文件也算成功，但要在标题里说清", () => {
    const report = uploadReport(t, { written: 2, reused: 1, failures: [], root: ROOT });
    expect(report.status).toBe("success");
    expect(report.title).toBe("已上传 2 个文件（复用 1 个）到服务器临时目录");
    expect(report.detail).toBe("复用 1 个已存在的文件");
  });

  it("部分失败：状态是「部分成功」，失败文件与原因写进明细", () => {
    const report = uploadReport(t, {
      written: 2,
      reused: 0,
      failures: ["static/app.js：Permission denied"],
      root: ROOT,
    });
    expect(report.status).toBe("partial");
    expect(report.title).toBe("已上传 2 个文件，1 个失败");
    expect(report.detail).toContain("static/app.js");
    expect(report.detail).toContain("Permission denied");
    expect(report.path).toBe(ROOT);
  });

  it("一个都没写成功：失败态，不给可点的目录", () => {
    const report = uploadReport(t, {
      written: 0,
      reused: 0,
      failures: ["a.txt：No space left on device"],
      root: ROOT,
    });
    expect(report.status).toBe("failed");
    expect(report.title).toContain("上传失败");
    expect(report.detail).toContain("No space left");
    expect(report.path).toBeUndefined();
  });
});

describe("回给模型的回执", () => {
  it("成功：带落盘目录，并说明部署时不必重传", () => {
    const receipt = uploadReceipt(t, { written: 3, reused: 0, failures: [], root: ROOT });
    expect(receipt).toContain(`已上传 3 个文件到 ${ROOT}`);
    expect(receipt).toContain("不必重传");
  });

  it("失败：说清哪几个失败、为什么，并说明文件仍在本机", () => {
    const receipt = uploadReceipt(t, {
      written: 1,
      reused: 0,
      failures: ["a.txt：Permission denied"],
      root: ROOT,
    });
    expect(receipt).toContain("失败 1 个");
    expect(receipt).toContain("a.txt：Permission denied");
    expect(receipt).toContain("仍只在用户本机");
  });
});

describe("计划 / 执行结果", () => {
  it("有步骤是成功，停在等待补充是部分成功", () => {
    expect(planReport(t, { result: "更新 nginx：备份 → 重启", ready: true }).status).toBe("success");
    expect(planReport(t, { result: "等待补充信息：没有 ZIP", ready: false }).status).toBe("partial");
  });

  it("执行结果按步骤状态区分成功 / 部分成功 / 失败", () => {
    expect(runReport(t, [{ state: "success" }, { state: "success" }]).status).toBe("success");
    const partial = runReport(t, [
      { state: "success", title: "备份" },
      { state: "failed", title: "重启" },
    ]);
    expect(partial.status).toBe("partial");
    expect(partial.title).toBe("1 个步骤通过，1 个失败");
    expect(partial.detail).toContain("重启");
    expect(runReport(t, [{ state: "failed", title: "备份" }]).status).toBe("failed");
    expect(runReport(t, []).status).toBe("failed");
  });

  it("状态文案与之一一对应", () => {
    expect(reportStatusLabel("requested", t)).toBe("已请求");
    expect(reportStatusLabel("success", t)).toBe("已成功");
    expect(reportStatusLabel("partial", t)).toBe("部分成功");
    expect(reportStatusLabel("failed", t)).toBe("失败");
  });
});
