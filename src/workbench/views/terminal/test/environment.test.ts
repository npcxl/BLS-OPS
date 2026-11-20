import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { i18n } from "@/i18n";
import {
  TOOL_PROBE_COMMAND,
  describeDnsVerdict,
  judgeDns,
  parseResolved,
  parseTools,
  renderEnvironmentReport,
  summarizeProjectTree,
} from "../extreme-core/environment";

// 环境报告按界面语言生成；这些用例断言的是中文措辞，测试环境默认英文。
const originalLanguage = i18n.language;
beforeAll(async () => {
  await i18n.changeLanguage("zh-CN");
});
afterAll(async () => {
  await i18n.changeLanguage(originalLanguage);
});

describe("工具探测", () => {
  it("一次命令覆盖常见工具，且用 command -v（最小化镜像里没有 which）", () => {
    expect(TOOL_PROBE_COMMAND).toContain("command -v");
    expect(TOOL_PROBE_COMMAND).not.toContain("which ");
    for (const tool of ["docker", "kubectl", "systemctl", "nginx", "unzip", "dig", "openssl"]) {
      expect(TOOL_PROBE_COMMAND).toContain(tool);
    }
  });

  it("只收有输出的工具，去重", () => {
    expect(parseTools("docker\nnginx\ndocker\n\n")).toEqual(["docker", "nginx"]);
    expect(parseTools("\n\n")).toEqual([]);
  });
});

describe("域名解析的三种结论", () => {
  it("解析到本机", () => {
    expect(judgeDns(["203.0.113.42"], "203.0.113.42")).toBe("points-here");
  });

  it("解析到别的主机 —— 不能在本机瞎改", () => {
    expect(judgeDns(["198.51.100.7"], "203.0.113.42")).toBe("points-elsewhere");
  });

  it("解析不到记录", () => {
    expect(judgeDns([], "203.0.113.42")).toBe("unresolved");
  });

  it("拿不到本机地址时不猜", () => {
    expect(judgeDns(["203.0.113.42"], undefined)).toBe("unknown");
  });

  it("每个结论都有面向用户的说明", () => {
    for (const verdict of ["points-here", "points-elsewhere", "unresolved", "unknown"] as const) {
      expect(describeDnsVerdict(verdict).length).toBeGreaterThan(6);
    }
    // 「指向别处」必须明确提醒：改完也访问不到。
    expect(describeDnsVerdict("points-elsewhere")).toContain("确认");
  });

  it("解析结果去掉末尾的点、去重", () => {
    expect(parseResolved("example.com.\nexample.com.\n")).toEqual(["example.com"]);
  });
});

describe("项目结构折叠", () => {
  it("只给顶层目录与文件数，不平铺三百个文件", () => {
    const files = [
      "index.html",
      "static/css/app.css",
      "static/js/app.js",
      "static/img/logo.png",
      "README.md",
    ];
    // 按字典序（大小写不敏感），目录带文件数。
    expect(summarizeProjectTree(files)).toEqual([
      "index.html",
      "README.md",
      "static/  (3 个文件)",
    ]);
  });

  it("顶层项太多时截断并给出剩余数", () => {
    const files = Array.from({ length: 60 }, (_, index) => `dir${index}/a.txt`);
    const lines = summarizeProjectTree(files, 10);
    expect(lines).toHaveLength(11);
    expect(lines[10]).toContain("另有 50 项");
  });
});

describe("渲染事实段落", () => {
  it("只给事实，不给『建议先做什么』", () => {
    const text = renderEnvironmentReport({
      os: "Ubuntu 24.04",
      arch: "x86_64",
      user: "ubuntu",
      isRoot: false,
      tools: ["docker", "nginx", "unzip"],
      projectFiles: ["index.html", "static/css/app.css"],
      attachmentCount: 2,
      attachmentBytes: 2048,
      dns: { domain: "ops.example.com", resolved: ["203.0.113.42"], selfAddress: "203.0.113.42", verdict: "points-here" },
      listening: ["0.0.0.0:80"],
    });

    expect(text).toContain("Ubuntu 24.04");
    expect(text).toContain("docker、nginx、unzip");
    expect(text).toContain("附件：2 个文件");
    expect(text).toContain("static/  (1 个文件)");
    expect(text).toContain("ops.example.com");
    expect(text).toContain("指向本机");
    expect(text).toContain("0.0.0.0:80");

    // 这是关键：事实包里**不能**夹带流程指令。
    expect(text).not.toMatch(/建议先查|第一步|请先执行|按以下步骤/);
  });

  it("什么都没探测到时也如实说，不编造", () => {
    const text = renderEnvironmentReport({ tools: [], projectFiles: [] });
    expect(text).toContain("未探测到");
    expect(text).not.toContain("docker");
  });
});
