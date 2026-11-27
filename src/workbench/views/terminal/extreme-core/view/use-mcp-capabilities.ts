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
import { useExtremeStore } from "@/stores/extreme-store";
import {
  BUILTIN_MCP_SKILLS,
  MCP_PROBE_SCRIPT,
  builtinAvailable,
  parseMcpProbe,
  type McpEnvProbe,
} from "../mcp-capabilities";
import { bumpMcpHealth, checkMcpServer, useMcpDataVersion } from "../mcp-events";
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
  /** bound-away 时具体绑在哪个服务器 / 任务。 */
  bindingTarget?: string;
  canEditBinding?: boolean;
}

export type McpSelectionResult =
  | { status: "ready"; builtins: string[]; tools: string[] }
  | { status: "loading" | "error"; message: string };

export interface McpCapabilityState {
  ready: boolean;
  probing: boolean;
  serversLoading: boolean;
  serversError: string | null;
  rows: McpCapabilityRow[];
  selectedBuiltins: string[];
  selectedToolNames: string[];
  toggle: (id: string, on: boolean) => void;
  refresh: () => void;
  /** 按请求归属读取勾选；连接列表仍在加载时会短暂等待，失败返回可展示原因。 */
  ensureSelection: (
    workspaceId: string | null,
    serverId: string | null,
  ) => Promise<McpSelectionResult>;
  enabledCount: number;
  checkingMcp?: boolean;
  checkMcp?: (id?: string) => Promise<void>;
  checkErrors?: Record<string, string>;
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

/**
 * 纯函数版本的勾选计算：测试和首条消息都按传入的归属计算，不读 React 闭包。
 */
export function selectionForScope(input: {
  workspaceId: string | null;
  serverId: string | null;
  servers: McpServerView[];
  bySession: Record<string, Record<string, boolean>>;
  probe: McpEnvProbe | null;
  connected: boolean;
}): McpSelectionResult {
  const key = mcpSessionKey(input.workspaceId, input.serverId);
  const builtins = BUILTIN_MCP_SKILLS.filter((skill) => {
    const available = builtinAvailable(skill, input.probe, input.connected);
    return (
      available &&
      chosen({ bySession: input.bySession }, key, `builtin:${skill.id}`, available)
    );
  }).map((skill) => skill.id);
  const selected = new Set(
    input.servers
      .filter(
        (server) =>
          server.enabled &&
          server.status === "connected" &&
          server.tools.some((tool) => tool.enabled) &&
          bindingMatches(server, input.serverId, input.workspaceId),
      )
      .filter((server) =>
        chosen(
          { bySession: input.bySession },
          key,
          `mcp:${server.id}`,
          server.defaultEnabled,
        ),
      )
      .map((server) => server.id),
  );
  return {
    status: "ready",
    builtins,
    tools: enabledMcpToolNames(input.servers, selected),
  };
}

/** MCP 现在只有全局作用域；保留函数签名兼容调用方与旧测试。 */
export function bindingMatches(
  _server: McpServerView,
  _serverId: string | null,
  _workspaceId: string | null,
): boolean {
  return true;
}

export function useMcpCapabilities(input: {
  workspaceId: string | null;
  serverId: string | null;
  sessionId: string | null;
  connected: boolean;
  active?: boolean;
}): McpCapabilityState {
  const { workspaceId, serverId, sessionId, connected, active = true } = input;
  const version = useMcpDataVersion();
  const bySession = useExtremeMcpSelection((state) => state.bySession);
  const setChoice = useExtremeMcpSelection((state) => state.setChoice);
  const [servers, setServers] = useState<McpServerView[] | null>(null);
  const [serversLoading, setServersLoading] = useState(true);
  const [serversError, setServersError] = useState<string | null>(null);
  const [checkingMcp, setCheckingMcp] = useState(false);
  const [checkErrors, setCheckErrors] = useState<Record<string, string>>({});
  const checkRun = useRef(false);
  const [probe, setProbe] = useState<McpEnvProbe | null>(null);
  const [probing, setProbing] = useState(false);
  const [probeTick, setProbeTick] = useState(0);
  const probeRef = useRef<McpEnvProbe | null>(null);
  probeRef.current = probe;
  const serversRef = useRef<McpServerView[] | null>(null);
  serversRef.current = servers;
  const loadRef = useRef<Promise<McpServerView[]> | null>(null);

  const sessionKey = mcpSessionKey(workspaceId, serverId);

  const loadServers = useCallback(async () => {
    setServersLoading(true);
    setServersError(null);
    const request = opsApi
      .mcpServerList()
      .then((list) => {
        const next = Array.isArray(list) ? list : [];
        // 先写 ref：首条消息会在 await 之后立刻读它，不能等下一帧重渲染。
        serversRef.current = next;
        setServers(next);
        return next;
      })
      .catch((cause: unknown) => {
        setServersError(
          cause instanceof Error ? cause.message : String(cause),
        );
        throw cause;
      })
      .finally(() => {
        setServersLoading(false);
      });
    loadRef.current = request;
    return request;
  }, []);

  // 连接列表：保存/测试/启停后由 `bumpMcpData()` 触发刷新。
  useEffect(() => {
    void loadServers().catch(() => undefined);
  }, [version, loadServers]);

  const checkMcp = useCallback(async (id?: string) => {
    if (checkRun.current) return;
    checkRun.current = true;
    setCheckingMcp(true);
    try {
      const list = serversRef.current ?? await loadServers();
      for (const server of list) {
        if (!server.enabled || (id && server.id !== id)) continue;
        try {
          await checkMcpServer(server.id);
          setCheckErrors((current) => {
            const next = { ...current };
            delete next[server.id];
            return next;
          });
        } catch (cause) {
          setCheckErrors((current) => ({ ...current, [server.id]: cause instanceof Error ? cause.message : String(cause) }));
        }
      }
    } catch {
      // loadServers exposes the list failure separately.
    } finally {
      checkRun.current = false;
      setCheckingMcp(false);
      bumpMcpHealth();
    }
  }, [loadServers]);

  useEffect(() => {
    if (!active || import.meta.env.MODE === "test") return undefined;
    let lastCheck = 0;
    const run = () => {
      if (document.visibilityState === "hidden" || Date.now() - lastCheck < 10 * 60_000) return;
      lastCheck = Date.now();
      void checkMcp();
    };
    run();
    const timer = window.setInterval(run, 60_000);
    window.addEventListener("focus", run);
    document.addEventListener("visibilitychange", run);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", run);
      document.removeEventListener("visibilitychange", run);
    };
  }, [active, checkMcp]);

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

  /**
   * 按**目标对话 / 服务器**计算勾选，而不是读当前渲染的 sessionKey。
   * 新任务首条消息、排队任务和恢复执行都靠它拿到归属正确的工具。
   */
  const selectionFor = useCallback(
    (
      targetWorkspaceId: string | null,
      targetServerId: string | null,
      list: McpServerView[],
    ): McpSelectionResult => {
      const targetConnected = Boolean(
        targetServerId
          ? useExtremeStore.getState().connections[targetServerId]?.sessionId
          : null,
      );
      const targetProbe =
        targetServerId && targetServerId === serverId
          ? probeRef.current
          : targetServerId
            ? (readProbes()[targetServerId] ?? null)
            : null;
      return selectionForScope({
        workspaceId: targetWorkspaceId,
        serverId: targetServerId,
        servers: list,
        bySession: useExtremeMcpSelection.getState().bySession,
        probe: targetProbe,
        connected: targetConnected || (targetServerId === serverId && connected),
      });
    },
    [connected, serverId],
  );

  const ensureSelection = useCallback(
    async (
      targetWorkspaceId: string | null,
      targetServerId: string | null,
    ): Promise<McpSelectionResult> => {
      if (serversRef.current === null && !serversError) {
        try {
          await (loadRef.current ?? loadServers());
        } catch (cause) {
          return {
            status: "error",
            message:
              cause instanceof Error
                ? cause.message
                : "MCP 连接列表读取失败，请稍后重试",
          };
        }
      }
      if (serversError) {
        return {
          status: "error",
          message: `MCP 连接列表读取失败：${serversError}`,
        };
      }
      const list = serversRef.current;
      if (list === null) {
        return { status: "loading", message: "正在加载 MCP 连接…" };
      }
      return selectionFor(targetWorkspaceId, targetServerId, list);
    },
    [loadServers, selectionFor, serversError],
  );

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
    void loadServers().catch(() => undefined);
  }, [loadServers]);

  return {
    // 列表加载完成才算 ready；加载失败仍保留错误态，不能当成“没有工具”。
    ready: servers !== null && !serversLoading && !serversError,
    probing,
    serversLoading,
    serversError,
    rows,
    selectedBuiltins,
    selectedToolNames,
    toggle,
    refresh,
    checkingMcp,
    checkMcp,
    checkErrors,
    ensureSelection,
    enabledCount: rows.filter((row) => row.enabled && row.available).length,
  };
}
