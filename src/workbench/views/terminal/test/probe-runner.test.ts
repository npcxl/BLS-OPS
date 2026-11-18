import { describe, expect, it } from "vitest";
import {
  checksFromProbe,
  parseProbe,
  probeCommand,
} from "../extreme-core/probe-runner";

// 真实 `ss -ltn` + `df -Pk` 的输出形状（缩进与列宽都照实写）。
const SAMPLE = [
  "@@@disk",
  "/dev/vda1 41152736 20000000 19000000 52% /",
  "@@@ports",
  "0.0.0.0:22",
  "0.0.0.0:80",
  "[::]:443",
  "@@@write",
  "yes",
  "@@@self",
  "203.0.113.42",
  "@@@hostname",
  "10.0.0.5",
  "@@@dns",
  "203.0.113.42",
].join("\n");

describe("probeCommand", () => {
  it("五条只读命令合成一次往返，用 @@@ 分段", () => {
    const command = probeCommand("/srv/ops");
    for (const tag of ["disk", "ports", "write", "self", "hostname"]) {
      expect(command).toContain(`@@@${tag}`);
    }
    // 只读：不写文件、不改配置、不重启。
    expect(command).not.toMatch(/(^|;|\s)(rm|mv|dd|systemctl|docker)\s/);
    expect(command).not.toMatch(/>\s*\/(?!dev\/null)/);
  });

  it("传了域名才查 DNS", () => {
    expect(probeCommand("/srv")).not.toContain("dig");
    expect(probeCommand("/srv", { domain: "ops.example.com" })).toContain(
      "dig +short 'ops.example.com'",
    );
  });

  it("路径里的单引号不会破坏引号配对", () => {
    expect(probeCommand("/srv/o'ps")).toContain(`'/srv/o'\\''ps'`);
  });
});

describe("parseProbe", () => {
  it("按标记切段，逐项解析", () => {
    const result = parseProbe(SAMPLE);
    expect(result.diskAvailable).toBe(19000000 * 1024);
    expect(result.listening).toEqual(["0.0.0.0:22", "0.0.0.0:80", "[::]:443"]);
    expect(result.writable).toBe(true);
    expect(result.selfAddress).toBe("203.0.113.42");
    expect(result.resolved).toEqual(["203.0.113.42"]);
  });

  it("缺段时保持未知，不编造", () => {
    const result = parseProbe("@@@write\nno");
    expect(result.writable).toBe(false);
    expect(result.diskAvailable).toBeNull();
    expect(result.listening).toEqual([]);
    expect(result.selfAddress).toBeUndefined();
    expect(result.resolved).toBeUndefined();
  });

  it("df 输出异常（只有表头）时给 null 而不是 0", () => {
    expect(parseProbe("@@@disk\nFilesystem 1024-blocks Used Available Capacity Mounted").diskAvailable).toBeNull();
  });

  it("拿不到对外地址时退回 hostname -I 的第一个", () => {
    const result = parseProbe("@@@hostname\n10.0.0.5");
    expect(result.selfAddress).toBe("10.0.0.5");
  });

  it("`self` 优先于 `hostname`（前者是对外路由地址）", () => {
    const result = parseProbe("@@@self\n203.0.113.42\n@@@hostname\n10.0.0.5");
    expect(result.selfAddress).toBe("203.0.113.42");
  });
});

describe("checksFromProbe", () => {
  const at = new Date(2026, 10, 16, 12, 0, 0).getTime();

  it("生成目录可写、磁盘余量、端口三项", () => {
    const items = checksFromProbe({
      probe: parseProbe(SAMPLE),
      path: "/srv/ops",
      needBytes: 100 * 1024 * 1024,
      port: 8080,
      at,
    });
    expect(items.map((item) => item.id)).toEqual(["write:/srv/ops", "disk:/srv/ops", "port:8080"]);
    expect(items.every((item) => item.at === at)).toBe(true);
  });

  it("端口已被占用时给出阻塞原因", () => {
    const items = checksFromProbe({
      probe: parseProbe(SAMPLE),
      path: "/srv/ops",
      needBytes: 1,
      port: 80,
      at,
    });
    const port = items.find((item) => item.id === "port:80")!;
    expect(port.status).toBe("unmet");
    expect(port.blockedBy).toContain("占用");
  });

  it("没传端口就不生成端口检查，不造「不适用」", () => {
    const items = checksFromProbe({ probe: parseProbe(SAMPLE), path: "/srv", needBytes: 1, at });
    expect(items.some((item) => item.id.startsWith("port:"))).toBe(false);
  });

  it("探测被截断时相关项落到「无法验证」而不是失败", () => {
    const items = checksFromProbe({
      probe: parseProbe("@@@ports\n0.0.0.0:22"),
      path: "/srv",
      needBytes: 1,
      at,
    });
    const write = items.find((item) => item.id === "write:/srv")!;
    const disk = items.find((item) => item.id === "disk:/srv")!;
    expect(write.status).toBe("unverified");
    expect(disk.status).toBe("unverified");
  });
});
