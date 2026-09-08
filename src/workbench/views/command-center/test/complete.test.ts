import { describe, expect, it } from "vitest";
import {
  canAutoFill,
  commandBody,
  completionKeys,
  fillPlaceholder,
  hasUnresolvedPlaceholder,
  inlineGhost,
  placeholdersIn,
} from "../complete";
import type { CommandSearchHit } from "@/api/ops-api";

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

  it("候选与已输入内容一致 → 空串（= 填入是空操作，这次回车必须执行）", () => {
    // 用户手打完整命令后按回车：若"填入"是空操作却仍吞掉回车，命令永远
    // 发不出去（表现为"结果面板不出现"）。调用方据此改走执行分支。
    expect(completionKeys("docker ps", "docker ps")).toBe("");
    expect(completionKeys("systemctl status nginx", "systemctl status nginx")).toBe("");
    // 有差异就不是空操作
    expect(completionKeys("docker ps", "docker ps -a")).toBe(" -a");
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

describe("行内 ghost 提示", () => {
  const hit = { syntax: "docker ps -a" } as CommandSearchHit;

  it("输入是前缀（忽略大小写）→ 只提示剩余部分", () => {
    expect(inlineGhost("docker p", hit)).toBe("s -a");
    expect(inlineGhost("DOCKER ", hit)).toBe("ps -a");
  });

  it("场景/别名命中（非前缀）→ 提示整条语法", () => {
    expect(inlineGhost("容器列表", hit)).toBe("docker ps -a");
  });

  it("空输入或无命中 → 空串（空白输入不出现建议）", () => {
    expect(inlineGhost("", hit)).toBe("");
    expect(inlineGhost("   ", hit)).toBe("");
    expect(inlineGhost("docker", undefined)).toBe("");
  });

  it("完整输入等于语法 → 空串（没有可提示的剩余）", () => {
    expect(inlineGhost("docker ps -a", hit)).toBe("");
  });
});

describe("命令主体（手填参数场景）", () => {
  it("取第一个占位符之前的字面部分，保留尾随空格", () => {
    expect(commandBody("unzip <包名.zip> -d <目标目录>")).toBe("unzip ");
    expect(commandBody("docker cp <容器>:<路径> .")).toBe("docker cp ");
  });

  it("主体绝不含占位符（可安全写入 shell）", () => {
    const body = commandBody("unzip <包名.zip> -d <目标目录>");
    expect(hasUnresolvedPlaceholder(body)).toBe(false);
  });

  it("无占位符返回整条语法，起始即占位符返回空串", () => {
    expect(commandBody("docker ps -a")).toBe("docker ps -a");
    expect(commandBody("<容器> logs")).toBe("");
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
