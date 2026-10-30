/**
 * 首页的"项目资产"数据源。
 *
 * 项目模块没有全局 Store：已确认项目按 `server_id` 存在本地 SQLite
 * （`confirmed_projects` 表），只能逐台服务器读。这里只读本地库，不建 SSH
 * 会话、不触发扫描 —— 首页挂载时绝不碰远端。
 *
 * 读失败时 `failed = true` 且列表保持为空：调用方必须显示"读取失败/—"，
 * **不能把失败当成 0 个项目**。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import {
  opsApi,
  toErrorMessage,
  type ConfirmedProject,
  type ConfirmedScanState,
  type ServerRecord,
} from "@/api/ops-api";

export interface ProjectAsset {
  key: string;
  name: string;
  path: string;
  serverId: string;
  serverName: string;
  /** 上一次扫描对这条已确认项目的结论（active / missing / …）。 */
  scanState: ConfirmedScanState;
  confirmedAt: number;
}

interface ProjectAssetsState {
  projects: ProjectAsset[];
  loading: boolean;
  /** 至少一台服务器读不出来：总数未知。 */
  failed: boolean;
  error: string | null;
  reload: () => void;
}

function flatten(server: ServerRecord, records: ConfirmedProject[]): ProjectAsset[] {
  return records.map((record) => ({
    key: `${server.id}\u0001${record.canonical_path}`,
    name: record.name || record.canonical_path,
    path: record.canonical_path,
    serverId: server.id,
    serverName: server.name,
    scanState: record.scan_state,
    confirmedAt: record.confirmed_at,
  }));
}

export function useProjectAssets(servers: ServerRecord[]): ProjectAssetsState {
  // 初始即"读取中"：第一次读盘完成前不能把 0 当成真实数量显示。
  const [state, setState] = useState<Omit<ProjectAssetsState, "reload">>({
    projects: [],
    loading: true,
    failed: false,
    error: null,
  });

  // 服务器列表变了才重读；Store 更新导致的数组新引用不触发额外 IPC。
  const signature = servers.map((server) => server.id).join("\u0001");
  const serversRef = useRef(servers);
  serversRef.current = servers;
  const requestRef = useRef(0);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const load = useCallback(async () => {
    const request = ++requestRef.current;
    const targets = serversRef.current;

    if (targets.length === 0) {
      setState({ projects: [], loading: false, failed: false, error: null });
      return;
    }

    setState((current) => ({ ...current, loading: true }));
    const results = await Promise.all(
      targets.map(async (server) => {
        try {
          const records = await opsApi.projectConfirmedList(server.id);
          if (!Array.isArray(records)) throw new Error("confirmed_projects_list did not return a list");
          return { server, records, error: null as string | null };
        } catch (cause) {
          return { server, records: [] as ConfirmedProject[], error: toErrorMessage(cause) };
        }
      }),
    );

    if (!mountedRef.current || request !== requestRef.current) return;
    const failures = results.filter((result) => result.error !== null);
    setState({
      projects: results.flatMap((result) => flatten(result.server, result.records)),
      loading: false,
      failed: failures.length > 0,
      error: failures[0]?.error ?? null,
    });
  }, []);

  useEffect(() => {
    void load();
  }, [signature, load]);

  return { ...state, reload: () => void load() };
}
