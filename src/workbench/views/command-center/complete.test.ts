import { describe, expect, it } from "vitest";
import type { CommandSearchHit } from "@/api/ops-api";
import { completionKeys, needsParams } from "./complete";
import { executability } from "./executability";

function hit(overrides: Partial<CommandSearchHit> = {}): CommandSearchHit {
  return {
    id: "docker.ps.all",
    executable: "docker",
    subcommand: "ps",
    title: "查看所有容器",
    description: "显示运行中和已停止的容器",
    category: "container",
    syntax: "docker ps -a",
    risk: "read_only",
    mutability: "read",
    output_adapter: "docker-container-table",
    requires: ["docker"],
    required_params: [],
    can_execute: true,
    favorite: false,
    score: 100,
    ...overrides,
  };
}

describe("completionKeys（终端内联补全）", () => {
  it("目标是草稿的延续时只补差异", () => {
    expect(completionKeys("docker p", "docker ps")).toBe("s");
    expect(completionKeys("docker ps", "docker ps -a")).toBe(" -a");
    // 完全一致 → 不写入任何按键。
    expect(completionKeys("docker ps", "docker ps")).toBe("");
  });

  it("非前缀关系（中文查询）先 Ctrl+U 清行再整条写入", () => {
    // 用 Ctrl+U 而非逐个退格：多字节输入的删除次数无法可靠计算。
    expect(completionKeys("查看容器", "docker ps -a")).toBe("\x15docker ps -a");
  });

  it("草稿为空时直接写入整条命令", () => {
    expect(completionKeys("", "docker ps -a")).toBe("docker ps -a");
  });
});

describe("needsParams", () => {
  it("按后端 required_params 判定", () => {
    expect(needsParams(hit())).toBe(false);
    expect(needsParams(hit({ required_params: ["container"] }))).toBe(true);
  });

  it("不可执行的知识条目不需要参数（不会走到执行流程）", () => {
    expect(needsParams(hit({ can_execute: false, required_params: ["unit"] }))).toBe(false);
  });
});

describe("executability（检索与执行解耦）", () => {
  it("未连接服务器时可检索但不可执行", () => {
    const state = executability(hit(), false, new Set(["docker"]));
    expect(state.ok).toBe(false);
    if (!state.ok) expect(state.reason).toContain("未连接");
  });

  it("已连接且工具已安装 → 可执行", () => {
    expect(executability(hit(), true, new Set(["docker"])).ok).toBe(true);
  });

  it("已连接但工具未安装 → 不可执行并说明缺什么", () => {
    const state = executability(hit(), true, new Set());
    expect(state.ok).toBe(false);
    if (!state.ok) expect(state.reason).toBe("服务器未安装 docker");
  });

  it("探测失败（null）不拦截，交给后端硬校验", () => {
    // 探测失败不该把所有命令误判成"未安装"。
    expect(executability(hit(), true, null).ok).toBe(true);
  });

  it("仅知识展示的条目永不执行", () => {
    const state = executability(hit({ can_execute: false }), true, new Set());
    expect(state.ok).toBe(false);
    if (!state.ok) expect(state.reason).toContain("仅知识展示");
  });

  it("无需工具的条目（系统自带）不受探测结果影响", () => {
    expect(executability(hit({ requires: [] }), true, new Set()).ok).toBe(true);
  });
});
