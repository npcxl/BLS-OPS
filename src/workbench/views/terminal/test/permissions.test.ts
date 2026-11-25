import { describe, expect, it } from "vitest";
import {
  BACKUP_MARK,
  PERMISSION_HINT,
  backupPathFor,
  backupStamp,
  deleteWithBackupCommand,
  isBackupPath,
  listBackupsCommand,
  originalPathOf,
  parseBackups,
  purgeBackupsCommand,
} from "../extreme-core/permissions";

describe("备份命名", () => {
  it("备份与原文件同目录，后缀带标记和时间戳", () => {
    const at = new Date(2026, 0, 2, 3, 4, 5).getTime();
    expect(backupPathFor("/srv/ops/config.yaml", at)).toBe(
      "/srv/ops/config.yaml.bls-bak.20260102030405",
    );
  });

  it("能识别自己的备份，也不会把别人的 .bak 当成自己的", () => {
    expect(isBackupPath("/srv/a.yaml.bls-bak.20260102030405")).toBe(true);
    expect(isBackupPath("/srv/a.yaml.bak")).toBe(false);
    expect(isBackupPath("/srv/a.yaml.old")).toBe(false);
  });

  it("从备份路径还原原文件路径", () => {
    expect(originalPathOf("/srv/a.yaml.bls-bak.20260102030405")).toBe("/srv/a.yaml");
    // 原文件名里本来就带标记：取**最后一个**标记之前的部分。
    expect(originalPathOf("/srv/x.bls-bak.old.bls-bak.20260102030405")).toBe("/srv/x.bls-bak.old");
  });

  it("时间戳是 14 位、可排序", () => {
    expect(backupStamp(new Date(2026, 10, 16, 9, 8, 7).getTime())).toBe("20261116090807");
  });
});

describe("删除前备份命令", () => {
  it("先 cp 再 rm，用 && 串联 —— 备份失败就不会删", () => {
    const command = deleteWithBackupCommand("/srv/a.yaml", new Date(2026, 0, 2, 3, 4, 5).getTime());
    expect(command).toBe(
      "cp -a '/srv/a.yaml' '/srv/a.yaml.bls-bak.20260102030405' && rm -f '/srv/a.yaml' && echo \"backup: /srv/a.yaml.bls-bak.20260102030405\"",
    );
    // 顺序必须是 cp 在前。
    expect(command.indexOf("cp -a")).toBeLessThan(command.indexOf("rm -f"));
  });

  it("路径里的单引号不会破坏引号配对", () => {
    const command = deleteWithBackupCommand("/srv/o'ps/a.yaml");
    expect(command).toContain(`'/srv/o'\\''ps/a.yaml'`);
  });
});

describe("备份的查看与清理", () => {
  it("列出备份是只读的（没有 -delete）", () => {
    const command = listBackupsCommand("/srv/ops");
    expect(command).toContain("find '/srv/ops'");
    expect(command).toContain(BACKUP_MARK);
    expect(command).not.toContain("-delete");
    expect(command).not.toContain("rm ");
  });

  it("清理命令只删带标记的文件", () => {
    const command = purgeBackupsCommand("/srv/ops");
    expect(command).toContain("-name '*" + BACKUP_MARK + "*'");
    expect(command).toContain("-delete");
    // 不能变成"删整个目录"。
    expect(command).not.toMatch(/rm\s+-rf\s+'\/srv\/ops'/);
  });

  it("解析 find 输出：只保留带标记的行", () => {
    const entries = parseBackups(
      [
        "/srv/ops/a.yaml.bls-bak.20260102030405",
        "",
        "/srv/ops/readme.md",
        "/srv/ops/b.conf.bls-bak.20260102030406",
      ].join("\n"),
    );
    expect(entries).toEqual([
      { path: "/srv/ops/a.yaml.bls-bak.20260102030405", original: "/srv/ops/a.yaml" },
      { path: "/srv/ops/b.conf.bls-bak.20260102030406", original: "/srv/ops/b.conf" },
    ]);
  });
});

describe("权限说明", () => {
  it("三种模式都有面向用户的一句话说明", () => {
    expect(PERMISSION_HINT.readonly).toContain("只读");
    expect(PERMISSION_HINT.ask).toContain("确认");
    expect(PERMISSION_HINT.full).toContain("删除");
    // 完全访问也要说清备份标记与严重操作仍确认。
    expect(PERMISSION_HINT.full).toContain(BACKUP_MARK);
    expect(PERMISSION_HINT.full).toContain("严重操作");
  });
});
