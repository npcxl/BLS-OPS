import { describe, expect, it } from "vitest";
import {
  panelTitle,
  parsePanelAction,
  probeCommand,
  probeSucceeded,
  safeAbsolutePath,
  safeResourceName,
  stripPanelAction,
} from "../panel-target";

describe("解析面板动作", () => {
  it("文件日志的短形态", () => {
    expect(parsePanelAction("[[panel:logs:/var/log/nginx/access.log]]")).toEqual({
      tab: "logs",
      source: {
        kind: "file",
        path: "/var/log/nginx/access.log",
        label: "/var/log/nginx/access.log",
      },
    });
  });

  it("systemd 与 Docker 来源", () => {
    expect(parsePanelAction("[[panel:logs:journal:nginx]]")).toMatchObject({
      source: { kind: "journal", unit: "nginx" },
    });
    expect(parsePanelAction("[[panel:logs:docker:bls-nginx]]")).toMatchObject({
      source: { kind: "docker", container: "bls-nginx" },
    });
  });

  it("JSON 形态（模型更容易对齐引号）", () => {
    expect(
      parsePanelAction(
        '[[panel:logs:{"kind":"docker","name":"bls-nginx","label":"nginx 访问日志"}]]',
      ),
    ).toEqual({
      tab: "logs",
      source: { kind: "docker", container: "bls-nginx", label: "nginx 访问日志" },
    });
  });

  it("Kubernetes：pod 与 namespace/pod 两种写法", () => {
    expect(parsePanelAction("[[panel:logs:k8s:web-7d9f]]")).toMatchObject({
      source: { kind: "k8s", pod: "web-7d9f", namespace: null },
    });
    expect(parsePanelAction("[[panel:logs:k8s:prod/web-7d9f]]")).toMatchObject({
      source: { kind: "k8s", pod: "web-7d9f", namespace: "prod" },
    });
    expect(
      parsePanelAction('[[panel:logs:{"kind":"k8s","name":"web-7d9f","namespace":"prod"}]]'),
    ).toMatchObject({ source: { kind: "k8s", pod: "web-7d9f", namespace: "prod" } });
    // 非法命名空间不放过。
    expect(parsePanelAction("[[panel:logs:k8s:-bad/pod]]")).toBeNull();
  });

  it("远程文件与命令输出", () => {
    expect(parsePanelAction("[[panel:files:/var/www/app]]")).toEqual({
      tab: "files",
      path: "/var/www/app",
    });
    expect(parsePanelAction("[[panel:output]]")).toEqual({ tab: "output" });
  });

  it("非法目标一律拒绝，不猜", () => {
    for (const text of [
      "[[panel:logs:relative/path.log]]",
      "[[panel:logs:/var/log/../../../etc/shadow]]",
      "[[panel:logs:journal:-rf]]",
      "[[panel:logs:docker:]]",
      "[[panel:shell:/tmp]]",
      "[[panel:logs:{\"kind\":\"bogus\"}]]",
      "[[panel:logs:{not json}]]",
    ]) {
      expect(parsePanelAction(text), text).toBeNull();
    }
  });

  it("没有动作时不误判", () => {
    expect(parsePanelAction("我看一下 nginx 的日志")).toBeNull();
  });
});

describe("路径与名字校验", () => {
  it("只接受绝对路径且不含 ..", () => {
    expect(safeAbsolutePath("/var/log/a.log")).toBe("/var/log/a.log");
    expect(safeAbsolutePath("var/log/a.log")).toBeNull();
    expect(safeAbsolutePath("/var/log/../etc/passwd")).toBeNull();
    expect(safeAbsolutePath("/var/log/a\nb")).toBeNull();
  });

  it("资源名不允许以 - 开头（会被当成命令行选项）", () => {
    expect(safeResourceName("bls-nginx")).toBe("bls-nginx");
    expect(safeResourceName("-rf")).toBeNull();
    expect(safeResourceName("a b")).toBeNull();
  });
});

describe("打开前的探测", () => {
  it("文件日志：test -f；目录：test -d", () => {
    const file = parsePanelAction("[[panel:logs:/var/log/nginx/access.log]]")!;
    expect(probeCommand(file)).toContain("test -f");
    const dir = parsePanelAction("[[panel:files:/var/www]]")!;
    expect(probeCommand(dir)).toContain("test -d");
  });

  it("systemd 与 Docker 各自查一种清单", () => {
    const journal = parsePanelAction("[[panel:logs:journal:nginx]]")!;
    expect(probeCommand(journal)).toContain("systemctl list-unit-files");
    const docker = parsePanelAction("[[panel:logs:docker:bls-nginx]]")!;
    expect(probeCommand(docker)).toContain("docker ps -a");
  });

  it("探测结果判定", () => {
    const file = parsePanelAction("[[panel:logs:/var/log/a.log]]")!;
    expect(probeSucceeded(file, "yes\n")).toBe(true);
    expect(probeSucceeded(file, "no\n")).toBe(false);
    const docker = parsePanelAction("[[panel:logs:docker:bls-nginx]]")!;
    expect(probeSucceeded(docker, "1\n")).toBe(true);
    expect(probeSucceeded(docker, "0\n")).toBe(false);
  });

  it("引号被正确转义（路径里带单引号也不会跑偏）", () => {
    const request = parsePanelAction("[[panel:files:/tmp/bls'quoted]]")!;
    expect(probeCommand(request)).toContain(`'/tmp/bls'\\''quoted'`);
  });
});

describe("展示与剥离", () => {
  it("气泡里不显示动作标记", () => {
    const text = "已经打开日志。\n[[panel:logs:docker:bls-nginx]]";
    expect(stripPanelAction(text)).toBe("已经打开日志。");
  });

  it("标题取来源标签", () => {
    const request = parsePanelAction('[[panel:logs:{"kind":"docker","name":"x","label":"访问日志"}]]')!;
    expect(panelTitle(request)).toBe("访问日志");
  });
});
