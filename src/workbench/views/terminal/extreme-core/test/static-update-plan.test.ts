import { describe, expect, it } from "vitest";
import { buildStaticUpdatePlan, verifyHttpStatus } from "../static-update-plan";
import { pickStagedZip } from "../deploy-plan";

const plan = () =>
  buildStaticUpdatePlan({
    root: "/var/www/app",
    zipPath: "/root/dist.zip",
  });

describe("同名 dist.zip：计划只认本次勾选的新包", () => {
  const oldPackage = {
    id: "att-old",
    name: "dist.zip",
    remotePath: "/root/.bls-ops/staging/ws/att-old/dist.zip",
    uploadState: "uploaded",
  };
  const newPackage = {
    id: "att-new",
    name: "dist.zip",
    remotePath: "/root/.bls-ops/staging/ws/att-new/dist.zip",
    uploadState: "uploaded",
  };

  it("勾选了新包就只拿新包的确切路径（数组里旧包在前）", () => {
    expect(pickStagedZip([oldPackage, newPackage], ["att-new"])?.remotePath).toBe(
      newPackage.remotePath,
    );
  });

  it("没有勾选时取最后加入的一份，而不是第一份", () => {
    expect(pickStagedZip([oldPackage, newPackage], [])?.remotePath).toBe(
      newPackage.remotePath,
    );
  });

  it("还没暂存完的包不参与计划", () => {
    expect(
      pickStagedZip([oldPackage, { ...newPackage, remotePath: undefined }], ["att-new"]),
    ).toBe(oldPackage);
  });
});

describe("静态站点更新计划", () => {
  it("只做「检查 → 备份 → 替换 → 验证」四步", () => {
    expect(plan().map((step) => step.id)).toEqual([
      "static-inspect",
      "static-backup",
      "static-replace",
      "static-verify",
    ]);
  });

  it("不重启共享 Nginx（配置没变就不该动其它站点）", () => {
    for (const step of plan()) {
      expect(step.command ?? "").not.toMatch(/nginx\s+(-s\s+)?reload|restart/);
    }
  });

  it("备份在替换之前，且带可执行回滚命令", () => {
    const steps = plan();
    const backupAt = steps.findIndex((step) => step.id === "static-backup");
    const replaceAt = steps.findIndex((step) => step.id === "static-replace");
    expect(backupAt).toBeLessThan(replaceAt);
    expect(steps[backupAt].rollback).toContain("cp -a");
  });

  it("不再要求 Compose，也不会再上传一次 ZIP", () => {
    const all = plan()
      .map((step) => `${step.title} ${step.detail} ${step.command ?? ""}`)
      .join("\n");
    expect(all).not.toMatch(/compose/i);
    expect(all).not.toMatch(/sftp|scp /i);
  });

  it("最后一个步骤是验证", () => {
    const steps = plan();
    expect(steps[steps.length - 1].kind).toBe("verify");
  });
});

describe("静态站点验证判定", () => {
  it("2xx / 3xx 算通过（这个是 HTTP 码，不是容器状态）", () => {
    expect(verifyHttpStatus("200").ok).toBe(true);
    expect(verifyHttpStatus("301\n").ok).toBe(true);
  });

  it("4xx / 5xx 与读不到状态码都算失败，并带回原始输出", () => {
    expect(verifyHttpStatus("502").ok).toBe(false);
    expect(verifyHttpStatus("curl: (7) Failed to connect").ok).toBe(false);
    expect(verifyHttpStatus("curl: (7) Failed to connect").reason).toContain("Failed to connect");
  });
});
