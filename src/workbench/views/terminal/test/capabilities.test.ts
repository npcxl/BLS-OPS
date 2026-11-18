import { describe, expect, it } from "vitest";
import {
  CAPABILITIES,
  deriveFacts,
  matchingCapabilities,
  primaryCapability,
  suggestNextProbe,
  type EnvironmentFacts,
} from "../extreme-core/capabilities";

/** 一台"什么都没有"的机器，测试按需覆盖。 */
const BASE: EnvironmentFacts = {
  hasDocker: false,
  hasKubernetes: false,
  hasSystemd: true,
  hasNginx: false,
  files: [],
};

const facts = (patch: Partial<EnvironmentFacts>): EnvironmentFacts => ({ ...BASE, ...patch });

describe("能力注册的通用性", () => {
  it("同一个判定函数对三种环境给出不同路径", () => {
    // ① 已有 K8s 集群
    expect(
      primaryCapability(facts({ hasKubernetes: true, files: ["Chart.yaml", "templates/deploy.yaml"] }))?.id,
    ).toBe("kubernetes");

    // ② 已有 Compose 服务
    expect(
      primaryCapability(facts({ hasDocker: true, files: ["compose.yaml", "Dockerfile"] }))?.id,
    ).toBe("compose");

    // ③ 普通 Linux 项目（没有任何容器 / 集群标记）
    expect(primaryCapability(facts({ files: ["main.go", "Makefile", "README.md"] }))?.id).toBe("bare-linux");
  });

  it("纯静态站点在有 nginx 的机器上判为静态托管", () => {
    expect(
      primaryCapability(facts({ hasNginx: true, files: ["index.html", "static/app.css"] }))?.id,
    ).toBe("static-nginx");
  });

  it("用户指定 K8s 但服务器上还没装 kubectl：仍按 K8s 处理（要装或换机器）", () => {
    // `applies` 是「有 kubectl」或「仓库里有清单」—— 后者成立就命中，
    // 后续探测会明确报「kubectl 不可用」，而不是悄悄换成别的部署方式。
    expect(primaryCapability(facts({ hasKubernetes: false, files: ["k8s/deployment.yaml"] }))?.id).toBe(
      "kubernetes",
    );
  });

  it("清单与 Compose 同时存在时，K8s 优先（更具体）", () => {
    const both = facts({ hasDocker: true, hasKubernetes: true, files: ["Chart.yaml", "compose.yaml"] });
    expect(primaryCapability(both)?.id).toBe("kubernetes");
    // 但也报告得出来"其实也能用 compose"。
    expect(matchingCapabilities(both).map((capability) => capability.id)).toContain("compose");
  });

  it("完全不认识的项目：不猜部署方式，先去读自述与监听端口", () => {
    const unknown = facts({ files: ["weird.bin", "notes.txt"] });
    const { capability, commands } = suggestNextProbe(unknown);
    expect(capability).toBeNull();
    expect(commands.join(" ")).toContain("README");
    expect(commands.join(" ")).toContain("ss -ltnp");
  });

  it("命中能力后，探测命令是只读的（不含 rm / mv / 重定向写入）", () => {
    for (const capability of CAPABILITIES) {
      for (const command of capability.probe) {
        expect(command).not.toMatch(/(^|\s)(rm|mv|dd|truncate)\s/);
        expect(command).not.toMatch(/>\s*\/(?!dev\/null)/);
      }
    }
  });

  it("变更影响四件事都不为空，且恢复方案是具体动作", () => {
    for (const capability of CAPABILITIES) {
      const impact = capability.impact({ target: "<target>" });
      expect(impact.target.length).toBeGreaterThan(0);
      expect(impact.scope.length).toBeGreaterThan(0);
      expect(impact.verify.length).toBeGreaterThan(0);
      expect(impact.recover.length).toBeGreaterThan(0);
      // 恢复方案必须说清"怎么退回去"，不能只写"注意风险"。
      expect(impact.recover).toMatch(/回滚|换回|undo|restart|恢复/);
    }
  });

  it("注册表里没有写死任何项目名或固定文件名作为『唯一目标』", () => {
    // 判定只依赖技术栈约定，不依赖 dist.zip / ops / 某个域名。
    const serialized = CAPABILITIES.map((capability) => capability.probe.join(" ")).join(" ");
    expect(serialized).not.toMatch(/ops\.|dist\.zip|\bops\b/);
  });
});

describe("deriveFacts", () => {
  it("preflight 说 docker 可用 → hasDocker 为真", () => {
    const facts = deriveFacts({ files: [], docker: { state: "checked" } });
    expect(facts.hasDocker).toBe(true);
  });

  it("docker ps 跑通过也算（preflight 可能还没跑）", () => {
    expect(deriveFacts({ files: [], containersProbed: true }).hasDocker).toBe(true);
  });

  it("docker 缺失时不假装有", () => {
    expect(deriveFacts({ files: [], docker: { state: "missing" } }).hasDocker).toBe(false);
  });

  it("没有探测过 Kubernetes / Nginx 时保持未知（false），不凭空假设", () => {
    const facts = deriveFacts({ files: ["Chart.yaml"] });
    expect(facts.hasKubernetes).toBe(false);
    expect(facts.hasNginx).toBe(false);
    /*
     * 但能力判定仍能从**仓库文件**认出这是 K8s 项目 —— 事实为 false 与
     * 判定为 `kubernetes` 并不矛盾：前者是"服务器有没有 kubectl"，
     * 后者是"该项目该按 K8s 的路子处理"。
     */
    expect(primaryCapability(facts)?.id).toBe("kubernetes");
  });

  it("工具探测结论会覆盖默认值", () => {
    const facts = deriveFacts({
      files: [],
      probed: { kubernetes: true, nginx: true, systemd: false },
    });
    expect(facts.hasKubernetes).toBe(true);
    expect(facts.hasNginx).toBe(true);
    expect(facts.hasSystemd).toBe(false);
  });
});
