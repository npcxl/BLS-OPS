import { describe, expect, it } from "vitest";
import {
  ambiguityQuestion,
  discoveryCommand,
  intentTokens,
  isLogIntent,
  matchChoice,
  parseCandidates,
  pickLogSource,
} from "../log-discovery";

const SCAN = [
  "##docker",
  "bls-nginx",
  "mysql8",
  "##units",
  "nginx.service",
  "redis.service",
  "##files",
  "/var/log/nginx/access.log",
  "/var/log/nginx/error.log",
  "/var/log/syslog",
  "##k8s",
  "web-7d9f-abc",
].join("\n");

describe("是不是要看日志", () => {
  it("常见说法", () => {
    for (const text of [
      "实时看看 OPS 的访问日志",
      "跟踪 nginx 错误日志",
      "tail 一下 redis 的日志",
      "看看容器的 log",
    ]) {
      expect(isLogIntent(text), text).toBe(true);
    }
  });

  it("普通提问不算", () => {
    for (const text of ["磁盘还剩多少", "重启 nginx", "把标题改成 X"]) {
      expect(isLogIntent(text), text).toBe(false);
    }
  });
});

describe("扫描结果", () => {
  it("按段解析成候选，Docker 与 systemd 同名也算两个来源", () => {
    const list = parseCandidates(SCAN);
    expect(list.map((item) => `${item.kind}:${"container" in item ? item.container : "unit" in item ? item.unit : "path" in item ? item.path : item.pod}`)).toEqual([
      "docker:bls-nginx",
      "docker:mysql8",
      "journal:nginx",
      "journal:redis",
      "file:/var/log/nginx/access.log",
      "file:/var/log/nginx/error.log",
      "file:/var/log/syslog",
      "k8s:web-7d9f-abc",
    ]);
  });

  it("扫描命令只读（不写文件、不重启服务）", () => {
    const command = discoveryCommand();
    expect(command).toContain("docker ps");
    expect(command).toContain("systemctl list-units");
    expect(command).toContain("/var/log");
    expect(command).not.toMatch(/\brm\b|\bmv\b|restart|stop /);
  });
});

describe("按意图挑来源", () => {
  const list = parseCandidates(SCAN);

  it("「nginx 访问日志」→ 唯一文件", () => {
    const picked = pickLogSource(list, "实时看看 OPS 的访问日志 nginx");
    expect(picked.pick).toMatchObject({ kind: "file", path: "/var/log/nginx/access.log" });
  });

  it("「错误日志」→ nginx error.log 优先于 access.log", () => {
    const picked = pickLogSource(list, "跟踪 nginx 错误日志");
    expect(picked.pick).toMatchObject({ path: "/var/log/nginx/error.log" });
  });

  it("「看 redis」→ systemd 的 redis（唯一匹配）", () => {
    const picked = pickLogSource(list, "看看 redis 日志");
    expect(picked.pick).toMatchObject({ kind: "journal", unit: "redis" });
  });

  it("只说「nginx 日志」且 Docker 与 systemd 同名 → 歧义，不猜", () => {
    const dockerAndUnit = list.filter(
      (item) => item.kind === "docker" || item.kind === "journal",
    );
    const picked = pickLogSource(dockerAndUnit, "看看 nginx 日志");
    expect(picked.pick).toBeUndefined();
    expect(picked.choices.length).toBeGreaterThan(1);
  });

  it("没有线索且只有一个候选 → 直接开；多个 → 问", () => {
    expect(pickLogSource([list[0]], "看看日志").pick).toBeDefined();
    expect(pickLogSource(list, "看看日志").choices.length).toBeGreaterThan(1);
  });

  it("一个候选都没有时不硬开", () => {
    expect(pickLogSource([], "看看 nginx 日志").pick).toBeUndefined();
  });
});

describe("歧义只问一句 + 按回答选中", () => {
  const list = parseCandidates(SCAN);

  it("问题里点名候选", () => {
    const question = ambiguityQuestion(list.slice(0, 3));
    expect(question).toContain("要看哪一个");
    expect(question).toContain("docker:bls-nginx");
  });

  it("用户说到哪个就选哪个；同时说到两个就不猜", () => {
    expect(matchChoice("看 bls-nginx 的日志", list)).toMatchObject({
      kind: "docker",
      container: "bls-nginx",
    });
    expect(matchChoice("看 nginx 和 redis 的日志", list)).toBeNull();
    expect(matchChoice("随便", list)).toBeNull();
  });

  it("关键词抽取会归一化中文说法", () => {
    const tokens = intentTokens("实时看看 nginx 的访问日志");
    expect(tokens).toContain("nginx");
    expect(tokens).toContain("access");
  });
});
