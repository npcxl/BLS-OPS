import { describe, expect, it } from "vitest";
import { needsBackup, planWriteBackup } from "../remote-write";

describe("写前备份", () => {
  it("备份与原文件同目录，带时间戳后缀", () => {
    const backup = planWriteBackup("/var/www/app/index.html", 1700000000000);
    expect(backup.path).toBe("/var/www/app/index.html.bls-bak.1700000000000");
  });

  it("备份命令是 cp -a，回滚方向相反", () => {
    const backup = planWriteBackup("/srv/a.conf", 1);
    expect(backup.command).toBe("cp -a '/srv/a.conf' '/srv/a.conf.bls-bak.1'");
    expect(backup.rollback).toBe("cp -a '/srv/a.conf.bls-bak.1' '/srv/a.conf'");
  });

  it("路径里有单引号也不会拼坏命令", () => {
    const backup = planWriteBackup("/srv/it's/a.txt", 2);
    expect(backup.command).toContain("'/srv/it'\\''s/a.txt'");
  });

  it("只对文件备份，目录交给调用方逐个处理", () => {
    expect(needsBackup({ kind: "file" })).toBe(true);
    expect(needsBackup({ kind: "dir" })).toBe(false);
    expect(needsBackup({ kind: "symlink" })).toBe(false);
  });
});
