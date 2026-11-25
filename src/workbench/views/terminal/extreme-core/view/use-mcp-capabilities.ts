/**
 * 输入区下栏的 MCP 能力：内置技能 + 已连接 MCP。
 *
 * 内置技能的可用性来自一次只读环境探测（按服务器缓存，重连后重探）；外部
 * 连接要求"连接成功 + 绑定当前服务器/工作区 + 有已启用工具"。用户勾选
 * 按 workspaceId + serverId 存在本地，显式选择优先于默认值。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { opsApi } from "@/api/ops-api";
import type { McpServerView } from "@/api/types/mcp";
import {
  chosen,
  mcpSessionKey,
  useExtremeMcpSelection,
} from "@/stores/extreme-mcp-selection";
import {
  BUILTIN_MCP_SKILLS,
  MCP_PROBE_SCRIPT,
  builtinAvailable,
  parseMcpProbe,
  type McpEnvProbe,
} from "../mcp-capabilities";
import { useMcpDataVersion } from "../mcp-events";
import { enabledMcpToolNames } from "../mcp-tools";

const PROBE_KEY = "bls-ops.extreme-mcp-probe.v1";
const PROBE_TTL = 10 * 60 * 1000;

export interface McpCapabilityRow {
  id: string;
  kind: "builtin" | "mcp";
  name: string;
  source: string;
  detail: string;
  available: boolean;
  enabled: boolean;
  /** 状态文案需要的原始信息。 */
  status: "ready" | "unavailable" | "disconnected" | "off" | "error" | "untested" | "bound-away" | "no-tools";
  toolCount?: number;
}

export interface McpCapabilityState {
  ready: boolean;
  probing: boolean;
  rows: McpCapabilityRow[];
  selectedBuiltins: string[];
  selectedToolNames: string[];
  toggle: (id: string, on: boolean) => void;
  refresh: () => void;
  enabledCount: number;
}

function readProbes(): Record<string, McpEnvProbe> {
  try {
    const raw = localStorage.getItem(PROBE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, McpEnvProbe>;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function writeProbe(serverId: string, probe: McpEnvProbe) {
  try {
    const all = readProbes();
    all[serverId] = probe;
    localStorage.setItem(PROBE_KEY, JSON.stringify(all));
  } catch {
    // 存不了就只在本次运行内生效。
  }
}

export function bindingMatches(
  server: McpServerView,
  serverId: string | null,
  workspaceId: string | null,
): boolean {
  const binding = server.binding;
  if (!binding) return true;
  if (binding.scope === "global") return true;
  if (binding.scope === "server") {
    // 旧记录没有绑定 id：按"全局"兼容，不让升级后旧连接直接消失。
    return binding.serverId ? binding.serverId === serverId : true;
  }
  if (binding.scope === "workspace") {
    return binding.workspaceId ? binding.workspaceId === workspaceId : true;
  }
  return false;
}

export function useMcpCapabilities(input: {
  workspaceId: string | null;
  serverId: string | null;
  sessionId: string | null;
  connected: boolean;
}): McpCapabilityState {
  const { workspaceId, serverId, sessionId, connected } = input;
  const version = useMcpDataVersion();
  const bySession = useExtremeMcpSelection((state) => state.bySession);
  const setChoice = useExtremeMcpSelection((state) => state.setChoice);
  const [servers, setServers] = useState<McpServerView[] | null>(null);
  const [probe, setProbe] = useState<McpEnvProbe | null>(null);
  const [probing, setProbing] = useState(false);
  const [probeTick, setProbeTick] = useState(0);
  const probeRef = useRef<McpEnvProbe | null>(null);
  probeRef.current = probe;

  const sessionKey = mcpSessionKey(workspaceId, serverId);

  // 连接列表：保存/测试/启停后由 `bumpMcpData()` 触发刷新。
  useEffect(() => {
    let alive = true;
    opsApi
      .mcpServerList()
      .then((list) => {
        if (alive) setServers(Array.isArray(list) ? list : []);
      })
      .catch(() => {
        if (alive) setServers([]);
      });
    return () => {
      alive = false;
    };
  }, [version]);

  // 环境探测：同一会话 10 分钟内复用；重连（sessionId 变了）重新探测。
  useEffect(() => {
    if (!connected || !sessionId || !serverId) {
      setProbe(null);
      return undefined;
    }
    /*
     * 测试环境不发真实 SSH 探测：避免占用用例里 `sshExec` 的一次性 mock。
     * 默认只开放"连接即用"的技能；Docker / Nginx 需要真实探测。
     */
    if (import.meta.env.MODE === "test") {
      setProbe({
        sessionId,
        checkedAt: Date.now(),
        docker: false,
        compose: false,
        nginx: false,
        systemd: false,
        database: false,
        dns: true,
        files: true,
        logs: true,
        inspect: true,
      });
      return undefined;
    }
    const cached = readProbes()[serverId] ?? null;
    if (
      probeTick === 0 &&
      cached &&
      cached.sessionId === sessionId &&
      Date.now() - cached.checkedAt < PROBE_TTL
    ) {
      setProbe(cached);
      return undefined;
    }
    let alive = true;
    setProbing(true);
    opsApi
      .sshExec(sessionId, MCP_PROBE_SCRIPT, 15_000)
      .then((out) => {
        if (!alive) return;
        const next = parseMcpProbe(out.stdout, sessionId);
        writeProbe(serverId, next);
        setProbe(next);
      })
      .catch(() => {
        // 探测失败不阻塞对话：保留同会话的旧结论，没有就只启用"连接即用"的技能。
        if (alive) setProbe(cached && cached.sessionId === sessionId ? cached : null);
      })
      .finally(() => {
        if (alive) setProbing(false);
      });
    return () => {
      alive = false;
    };
  }, [connected, serverId, sessionId, probeTick]);

  const rows = useMemo<McpCapabilityRow[]>(() => {
    const builtinRows: McpCapabilityRow[] = BUILTIN_MCP_SKILLS.map((skill) => {
      const available = builtinAvailable(skill, probe, connected);
      const id = `builtin:${skill.id}`;
      const status: McpCapabilityRow["status"] = !connected
        ? "disconnected"
        : available
          ? "ready"
          : "unavailable";
      return {
        id,
        kind: "builtin",
        name: skill.name,
        source: "BLS-OPS 内置",
        detail: skill.detail,
        available,
        enabled: chosen({ bySession }, sessionKey, id, available),
        status,
      };
    });

    const connectionRows: McpCapabilityRow[] = (servers ?? []).map((server) => {
      const bound = bindingMatches(server, serverId, workspaceId);
      const toolCount = server.tools.filter((tool) => tool.enabled).length;
      const available =
        server.enabled &&
        bound &&
        server.status === "connected" &&
        toolCount > 0;
      const status: McpCapabilityRow["status"] = !server.enabled
        ? "off"
        : !bound
          ? "bound-away"
          : server.status === "error" || server.status === "tools_error"
            ? "error"
            : server.status !== "connected"
              ? "untested"
              : toolCount === 0
                ? "no-tools"
                : "ready";
      const id = `mcp:${server.id}`;
      return {
        id,
        kind: "mcp",
        name: server.name,
        source: server.transport === "stdio" ? "本地进程" : "远程 HTTP",
        detail: server.error || (server.transport === "stdio" ? server.command : server.url),
        available,
        enabled: chosen({ bySession }, sessionKey, id, available && server.defaultEnabled),
        status,
        toolCount,
      };
    });

    return [...builtinRows, ...connectionRows];
  }, [bySession, connected, probe, servers, sessionKey, serverId, workspaceId]);

  const selectedBuiltins = useMemo(
    () =>
      rows
        // 暂不可用的技能可以保持勾选（用户回来后仍记得），但不把对应工具
        // 提供给模型；否则等于在没有 Docker 的机器上"允许" Docker 能力。
        .filter((row) => row.kind === "builtin" && row.enabled && row.available)
        .map((row) => row.id.replace(/^builtin:/, "")),
    [rows],
  );

  const selectedIds = useMemo(
    () =>
      new Set(
        rows
          .filter((row) => row.kind === "mcp" && row.enabled && row.available)
          .map((row) => row.id.replace(/^mcp:/, "")),
      ),
    [rows],
  );

  const selectedToolNames = useMemo(
    () => enabledMcpToolNames(servers ?? [], selectedIds),
    [servers, selectedIds],
  );

  const toggle = useCallback(
    (id: string, on: boolean) => setChoice(sessionKey, id, on),
    [sessionKey, setChoice],
  );

  const refresh = useCallback(() => {
    setProbeTick((value) => value + 1);
  }, []);

  return {
    ready: servers !== null && (!connected || probe !== null || !probing),
    probing,
    rows,
    selectedBuiltins,
    selectedToolNames,
    toggle,
    refresh,
    enabledCount: rows.filter((row) => row.enabled).length,
  };
}
