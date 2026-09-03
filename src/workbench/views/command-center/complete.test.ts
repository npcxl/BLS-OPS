import { describe, expect, it } from "vitest";
import {
  canAutoFill,
  completionKeys,
  fillPlaceholder,
  hasUnresolvedPlaceholder,
  placeholdersIn,
} from "./complete";

describe("占位符识别", () => {
  it("识别 unit 占位符并归一成参数种类", () => {
    const found = placeholdersIn("journalctl -u <unit> -n 200 --no-pager");
    expect(found).toEqual([{ token: "<unit>", name: "unit", kind: "unit" }]);
  });

  it("识别中文占位符（<容器> / <路径>）", () => {
    expect(placeholdersIn("docker logs --tail 200 <容器>")[0].kind).toBe("container");
    expect(placeholdersIn("git -C <路径> status")[0].kind).toBe("path");
  });

  it("认不出的占位符返回 null（无自动数据源，不能开选择器）", () => {
    expect(placeholdersIn("journalctl --since <时间>")[0].kind).toBeNull();
  });

  it("按出现顺序返回全部占位符", () => {
    const found = placeholdersIn("docker cp <容器>:<路径> .");
    expect(found.map((f) => f.kind)).toEqual(["container", "path"]);
  });

  it("无占位符的命令返回空数组", () => {
    expect(placeholdersIn("docker ps -a")).toEqual([]);
  });
});

describe("占位符拦截（安全底线）", () => {
  it("含占位符的语法禁止写入终端", () => {
    // 这是本次修复的核心：`<unit>` 原样进 shell 会被 bash 当成输入重定向。
    expect(completionKeys("journalctl", "journalctl -u <unit> -n 200")).toBeNull();
    expect(completionKeys("", "systemctl status <unit>")).toBeNull();
  });

  it("已替换成真值的语法可以正常写入", () => {
    expect(completionKeys("journalctl", "journalctl -u nginx.service -n 200")).toBe(
      " -u nginx.service -n 200",
    );
    expect(completionKeys("", "docker ps -a")).toBe("docker ps -a");
  });

  it("hasUnresolvedPlaceholder 是发送前的最后一道拦截", () => {
    expect(hasUnresolvedPlaceholder("journalctl -u <unit>")).toBe(true);
    expect(hasUnresolvedPlaceholder("journalctl -u nginx.service")).toBe(false);
    expect(hasUnresolvedPlaceholder("docker ps -a")).toBe(false);
  });

  it("只能自动补全认得出的占位符", () => {
    expect(canAutoFill("systemctl status <unit>")).toBe(true);
    expect(canAutoFill("journalctl --since <时间>")).toBe(false);
    expect(canAutoFill("docker ps -a")).toBe(false);
  });
});

describe("占位符替换", () => {
  it("替换指定占位符，其余保留供下一轮", () => {
    const syntax = "docker cp <容器>:<路径> .";
    const [container, path] = placeholdersIn(syntax);
    const filled = fillPlaceholder(syntax, container.token, "web");
    expect(filled).toBe("docker cp web:<路径> .");
    expect(fillPlaceholder(filled, path.token, "/var/log")).toBe("docker cp web:/var/log .");
  });

  it("空值或含空格的值不替换（多半是取消或非法输入）", () => {
    expect(fillPlaceholder("systemctl status <unit>", "<unit>", "  ")).toBe(
      "systemctl status <unit>",
    );
    expect(fillPlaceholder("systemctl status <unit>", "<unit>", "nginx service")).toBe(
      "systemctl status <unit>",
    );
  });

  it("值里的替换模式（$&）不会被当成正则", () => {
    expect(fillPlaceholder("cat <路径>", "<路径>", "/tmp/$&")).toBe("cat /tmp/$&");
  });
});
