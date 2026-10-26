/**
 * 工具探测缓存。
 *
 * 钉住五条容易被改坏的规则：
 * 1. 只探未知项（关键词变化不该重探已确定的工具）；
 * 2. 同代次并发合并（一次关键词抖动不产生多组远程探测）；
 * 3. **探测失败 ≠ 未安装**（保持 unknown，交给后端执行前校验）；
 * 4. **连接代次变化必须重新探测**（重连后装了 docker 不能还被置灰）；
 * 5. 手动失效后重新探测。
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const probeMock = vi.fn();

vi.mock("@/api/ops-api", () => ({
  opsApi: {
    commandProbeTools: (...args: unknown[]) => probeMock(...args),
  },
}));

import { ensureToolsProbed, forgetSessionTools } from "../tool-cache";

beforeEach(() => {
  probeMock.mockReset();
});

describe("工具探测缓存", () => {
  it("只探测未知项", async () => {
    probeMock.mockResolvedValue(["docker"]);
    await ensureToolsProbed("s1", 1, ["docker", "nginx"]);
    expect(probeMock).toHaveBeenLastCalledWith("s1", ["docker", "nginx"]);

    // 关键词变化让工具集合扩大：只补新的那个。
    probeMock.mockResolvedValue([]);
    const known = await ensureToolsProbed("s1", 1, ["docker", "nginx", "systemctl"]);
    expect(probeMock).toHaveBeenCalledTimes(2);
    expect(probeMock).toHaveBeenLastCalledWith("s1", ["systemctl"]);
    expect(known.get("docker")).toBe("installed");
    expect(known.get("nginx")).toBe("missing");
    expect(known.get("systemctl")).toBe("missing");
  });

  it("同一代次的并发请求合并成一次探测", async () => {
    probeMock.mockResolvedValue(["docker"]);
    await Promise.all([
      ensureToolsProbed("s1-merge", 1, ["docker"]),
      ensureToolsProbed("s1-merge", 1, ["docker"]),
    ]);
    expect(probeMock).toHaveBeenCalledTimes(1);
  });

  it("探测失败保持 unknown，绝不标成 missing", async () => {
    probeMock.mockRejectedValue(new Error("network unreachable"));
    const known = await ensureToolsProbed("s2", 1, ["docker"]);
    expect(known.has("docker")).toBe(false);
    expect(known.get("docker")).not.toBe("missing");
  });

  it("连接代次变化后重新探测（重连不能沿用旧状态）", async () => {
    // 第一次连接：docker 未安装。
    probeMock.mockResolvedValue([]);
    const before = await ensureToolsProbed("s4", 1, ["docker"]);
    expect(before.get("docker")).toBe("missing");

    // 用户装好 docker 后重连：sessionId 不变，但代次 +1。
    probeMock.mockResolvedValue(["docker"]);
    const after = await ensureToolsProbed("s4", 2, ["docker"]);
    expect(probeMock).toHaveBeenCalledTimes(2);
    expect(after.get("docker")).toBe("installed");
  });

  it("失效后重新探测（含所有代次）", async () => {
    probeMock.mockResolvedValue(["docker"]);
    await ensureToolsProbed("s3", 1, ["docker"]);
    forgetSessionTools("s3");
    probeMock.mockResolvedValue([]);
    const known = await ensureToolsProbed("s3", 1, ["docker"]);
    expect(probeMock).toHaveBeenCalledTimes(2);
    expect(known.get("docker")).toBe("missing");
  });
});
