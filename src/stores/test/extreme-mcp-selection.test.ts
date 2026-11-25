import { beforeEach, describe, expect, it } from "vitest";
import {
  chosen,
  mcpSessionKey,
  useExtremeMcpSelection,
} from "@/stores/extreme-mcp-selection";

const KEY = "bls-ops.extreme-mcp-selection.v1";

describe("MCP 勾选记忆", () => {
  beforeEach(() => {
    localStorage.clear();
    useExtremeMcpSelection.setState({ bySession: {} });
  });

  it("默认跟随可用性，显式取消优先并持久化", () => {
    const key = mcpSessionKey("w1", "s1");
    expect(chosen(useExtremeMcpSelection.getState(), key, "builtin:docker", true)).toBe(true);
    useExtremeMcpSelection.getState().setChoice(key, "builtin:docker", false);
    expect(chosen(useExtremeMcpSelection.getState(), key, "builtin:docker", true)).toBe(false);
    const saved = JSON.parse(localStorage.getItem(KEY) ?? "{}");
    expect(saved[key]["builtin:docker"]).toBe(false);
  });

  it("不同服务器与会话各存一份", () => {
    const a = mcpSessionKey("w1", "s1");
    const b = mcpSessionKey("w1", "s2");
    useExtremeMcpSelection.getState().setChoice(a, "builtin:docker", false);
    useExtremeMcpSelection.getState().setChoice(b, "builtin:docker", true);
    const state = useExtremeMcpSelection.getState();
    expect(chosen(state, a, "builtin:docker", true)).toBe(false);
    expect(chosen(state, b, "builtin:docker", true)).toBe(true);
  });
});
