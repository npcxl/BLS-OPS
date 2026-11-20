import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { i18n } from "@/i18n";
import {
  checkCertificate,
  checkDisk,
  checkDns,
  checkPort,
  checkUpstream,
  checkWritable,
  parseDiskAvailable,
  renderChecks,
  statusLabel,
  summarizeChecks,
  type CheckItem,
} from "../extreme-core/checks";

// 结论文案按界面语言生成；这些用例断言中文，测试环境默认英文。
const originalLanguage = i18n.language;
beforeAll(async () => {
  await i18n.changeLanguage("zh-CN");
});
afterAll(async () => {
  await i18n.changeLanguage(originalLanguage);
});

const at = new Date(2026, 10, 16, 10, 0, 0).getTime();

describe("五种结论", () => {
  it("每种都有面向用户的中文，且互不相同", () => {
    const labels = (["passed", "unmet", "denied", "unverified", "not-applicable"] as const).map(
      statusLabel,
    );
    expect(new Set(labels).size).toBe(5);
    expect(labels[0]).toBe("已验证");
    expect(labels[1]).toBe("条件未满足");
    expect(labels[2]).toBe("无权限");
    expect(labels[3]).toBe("无法验证");
    expect(labels[4]).toBe("不适用");
  });
});

describe("DNS 检查", () => {
  it("指向本机 → 已验证", () => {
    const item = checkDns({
      domain: "ops.example.com",
      resolved: ["203.0.113.42"],
      selfAddress: "203.0.113.42",
      at,
    });
    expect(item.status).toBe("passed");
    expect(item.evidence).toContain("203.0.113.42");
  });

  it("指向别的主机 → 条件未满足，并说明要改哪条记录", () => {
    const item = checkDns({
      domain: "ops.example.com",
      resolved: ["198.51.100.7"],
      selfAddress: "203.0.113.42",
      at,
    });
    expect(item.status).toBe("unmet");
    expect(item.blockedBy).toContain("A 记录");
    // 这条必须让用户明白"改完才访问得到"。
    expect(item.evidence).toContain("确认");
  });

  it("没有记录 → 条件未满足", () => {
    expect(
      checkDns({ domain: "a.test", resolved: [], selfAddress: "203.0.113.42", at }).status,
    ).toBe("unmet");
  });

  it("拿不到本机地址 → 无法验证（不是失败）", () => {
    expect(checkDns({ domain: "a.test", resolved: ["203.0.113.42"], at }).status).toBe("unverified");
  });
});

describe("端口检查", () => {
  it("已在监听 → 条件未满足", () => {
    const item = checkPort({ port: 80, listening: ["0.0.0.0:80", "0.0.0.0:22"], at });
    expect(item.status).toBe("unmet");
    expect(item.blockedBy).toContain("占用");
  });

  it("未被占用 → 已验证", () => {
    expect(checkPort({ port: 8080, listening: ["0.0.0.0:80"], at }).status).toBe("passed");
  });

  it("端口号相邻不会误判（80 不会命中 8080）", () => {
    expect(checkPort({ port: 80, listening: ["0.0.0.0:8080"], at }).status).toBe("passed");
    // IPv6 写法 [::]:80 也要认出来。
    expect(checkPort({ port: 80, listening: ["[::]:80"], at }).status).toBe("unmet");
  });
});

describe("目录与磁盘", () => {
  it("没测过 `test -w` 就不能说可写", () => {
    expect(checkWritable({ path: "/srv/ops", at }).status).toBe("unverified");
    expect(checkWritable({ path: "/srv/ops", writable: true, at }).status).toBe("passed");
    expect(checkWritable({ path: "/srv/ops", writable: false, at }).status).toBe("denied");
  });

  it("解析 df 的可用空间", () => {
    // Filesystem 1024-blocks Used Available Capacity Mounted
    expect(parseDiskAvailable("Filesystem 1024-blocks Used Available Capacity Mounted\n/dev/sda1 41152736 20000000 19000000 52% /\n")).toBe(
      19000000 * 1024,
    );
    expect(parseDiskAvailable("")).toBeNull();
  });

  it("余量不足 → 条件未满足；读不到 → 无法验证", () => {
    expect(
      checkDisk({ path: "/", availableBytes: 100 * 1024 * 1024, needBytes: 500 * 1024 * 1024, at }).status,
    ).toBe("unmet");
    expect(checkDisk({ path: "/", availableBytes: null, needBytes: 1, at }).status).toBe("unverified");
    expect(
      checkDisk({ path: "/", availableBytes: 1024 * 1024 * 1024, needBytes: 1024, at }).status,
    ).toBe("passed");
  });
});

describe("证书检查", () => {
  const future = new Date(Date.now() + 86400_000).toUTCString();

  it("SAN 覆盖且未过期 → 已验证", () => {
    const item = checkCertificate({
      domain: "ops.example.com",
      details: `subject=CN=ops.example.com\nX509v3 Subject Alternative Name:\n    DNS:ops.example.com, DNS:www.ops.example.com\nnotAfter=${future}`,
      at,
    });
    expect(item.status).toBe("passed");
  });

  it("SAN 不覆盖 → 条件未满足，并列出证书实际覆盖的域名", () => {
    const item = checkCertificate({
      domain: "ops.example.com",
      details: `DNS:other.example.com\nnotAfter=${future}`,
      at,
    });
    expect(item.status).toBe("unmet");
    expect(item.evidence).toContain("other.example.com");
  });

  it("过期 → 条件未满足", () => {
    const item = checkCertificate({
      domain: "ops.example.com",
      details: `DNS:ops.example.com\nnotAfter=${new Date(Date.now() - 86400_000).toUTCString()}`,
      at,
    });
    expect(item.status).toBe("unmet");
    expect(item.evidence).toContain("过期");
  });

  it("通配符证书覆盖子域", () => {
    const item = checkCertificate({
      domain: "ops.example.com",
      details: `DNS:*.example.com\nnotAfter=${future}`,
      at,
    });
    expect(item.status).toBe("passed");
  });

  it("没有证书 → 不适用（不是失败）", () => {
    expect(checkCertificate({ domain: "a.test", at }).status).toBe("not-applicable");
  });
});

describe("上游可达性", () => {
  it("2xx/4xx 算通（4xx 说明服务在，只是路径或鉴权问题）", () => {
    expect(checkUpstream({ url: "http://127.0.0.1:9000/health", httpCode: 200, at }).status).toBe("passed");
    expect(checkUpstream({ url: "http://127.0.0.1:9000/x", httpCode: 404, at }).status).toBe("passed");
  });

  it("5xx 或没有响应 → 条件未满足 / 无法验证", () => {
    expect(checkUpstream({ url: "http://u/", httpCode: 502, at }).status).toBe("unmet");
    expect(checkUpstream({ url: "http://u/", at }).status).toBe("unverified");
  });
});

describe("汇总与渲染", () => {
  // 检查项在构造时按界面语言定标签；必须在用例里（语言切好之后）再构造。
  const makeItems = (): CheckItem[] => [
    checkDns({ domain: "ops.example.com", resolved: ["203.0.113.42"], selfAddress: "203.0.113.42", at }),
    checkPort({ port: 80, listening: ["0.0.0.0:80"], at }),
    checkWritable({ path: "/srv/ops", writable: false, at }),
    checkCertificate({ domain: "ops.example.com", at }),
  ];

  it("只把「条件未满足」和「无权限」算阻塞", () => {
    const summary = summarizeChecks(makeItems());
    expect(summary.passed).toBe(1);
    expect(summary.unmet).toBe(1);
    expect(summary.denied).toBe(1);
    expect(summary.blocked).toHaveLength(2);
    expect(summary.ready).toBe(false);
  });

  it("「无法验证」不算阻塞", () => {
    const summary = summarizeChecks([
      checkWritable({ path: "/a", at }),
      checkUpstream({ url: "http://u/", at }),
    ]);
    expect(summary.unverified).toBe(2);
    expect(summary.blocked).toHaveLength(0);
    expect(summary.ready).toBe(true);
  });

  it("渲染只给事实与结论，不夹带步骤编排", () => {
    const text = renderChecks(makeItems());
    expect(text).toContain("前置条件检查");
    expect(text).toContain("有 2 项阻塞");
    expect(text).toContain("域名解析");
    expect(text).toContain("需要：");
    expect(text).not.toMatch(/第 1 步|请依次|下一步先执行/);
  });

  it("空列表不渲染任何内容", () => {
    expect(renderChecks([])).toBe("");
  });
});
