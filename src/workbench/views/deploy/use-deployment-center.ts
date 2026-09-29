/**
 * 部署中心的数据层（**所有 IPC 都经过 `opsApi`**，组件里不出现 `invoke`）。
 *
 * 数据流是单向的：选服务器 → 载入应用；选应用 → 载入环境 / 服务 / 方案；
 * 选环境 → 载入版本记录。运行记录按应用载入（本阶段恒为空）。
 *
 * 写操作一律"先落库、再刷新"：成功后就地更新本地状态，避免整页重载导致的闪烁；
 * 失败把后端的中文错误原样展示（Rust 已经把校验信息写成用户能读的句子）。
 */

import { useCallback, useEffect, useMemo, useState } from "react";

import { opsApi, toErrorMessage } from "@/api/ops-api";
import type {
  DeploymentApplication,
  DeploymentEnvironment,
  DeploymentPlan,
  DeploymentPlanGraph,
  DeploymentRun,
  DeploymentServiceUnit,
  ReleaseRecord,
} from "@/api/types/deployment";
import { useDomainStore } from "@/stores/domain-store";

export interface DeploymentCenterStatus {
  state: "idle" | "loading" | "ready" | "error";
  message?: string;
}

export interface DeploymentCenter {
  servers: { id: string; name: string; host: string }[];
  serverId: string;
  setServerId: (id: string) => void;
  applicationId: string;
  setApplicationId: (id: string) => void;
  environmentId: string;
  setEnvironmentId: (id: string) => void;
  applications: DeploymentApplication[];
  environments: DeploymentEnvironment[];
  services: DeploymentServiceUnit[];
  plans: DeploymentPlan[];
  runs: DeploymentRun[];
  releases: ReleaseRecord[];
  /** 当前查看的方案图（点方案名载入）。 */
  planGraph: DeploymentPlanGraph | null;
  loadingPlanId: string | null;
  status: DeploymentCenterStatus;
  error: string | null;
  clearError: () => void;
  reload: () => Promise<void>;
  openPlan: (planId: string) => Promise<void>;
  saveApplication: (application: DeploymentApplication) => Promise<boolean>;
  deleteApplication: (id: string) => Promise<boolean>;
  saveEnvironment: (environment: DeploymentEnvironment) => Promise<boolean>;
  deleteEnvironment: (id: string) => Promise<boolean>;
  saveService: (unit: DeploymentServiceUnit) => Promise<boolean>;
  deleteService: (id: string) => Promise<boolean>;
  linkProject: (unitId: string, projectPath: string, projectId?: string) => Promise<boolean>;
  unlinkProject: (unitId: string) => Promise<boolean>;
  createPlan: (name: string) => Promise<boolean>;
  deletePlan: (id: string) => Promise<boolean>;
}

export function useDeploymentCenter(): DeploymentCenter {
  const servers = useDomainStore((state) => state.servers);
  const [serverId, setServerIdState] = useState("");
  const [applicationId, setApplicationIdState] = useState("");
  const [environmentId, setEnvironmentIdState] = useState("");
  const [applications, setApplications] = useState<DeploymentApplication[]>([]);
  const [environments, setEnvironments] = useState<DeploymentEnvironment[]>([]);
  const [services, setServices] = useState<DeploymentServiceUnit[]>([]);
  const [plans, setPlans] = useState<DeploymentPlan[]>([]);
  const [runs, setRuns] = useState<DeploymentRun[]>([]);
  const [releases, setReleases] = useState<ReleaseRecord[]>([]);
  const [planGraph, setPlanGraph] = useState<DeploymentPlanGraph | null>(null);
  const [loadingPlanId, setLoadingPlanId] = useState<string | null>(null);
  const [status, setStatus] = useState<DeploymentCenterStatus>({ state: "idle" });
  const [error, setError] = useState<string | null>(null);

  const serverOptions = useMemo(
    () => servers.map((server) => ({ id: server.id, name: server.name, host: server.host })),
    [servers],
  );

  /** 默认选第一台服务器，省掉一次点击（用户也可能就只有一台）。 */
  useEffect(() => {
    if (serverId === "" && serverOptions.length > 0) {
      setServerIdState(serverOptions[0].id);
    }
  }, [serverId, serverOptions]);

  /** 服务器/应用切换后，清掉不再成立的选中项。 */
  useEffect(() => {
    setApplicationIdState("");
    setEnvironmentIdState("");
    setPlanGraph(null);
    setEnvironments([]);
    setServices([]);
    setPlans([]);
    setRuns([]);
    setReleases([]);
  }, [serverId]);

  useEffect(() => {
    setEnvironmentIdState("");
    setPlanGraph(null);
    setEnvironments([]);
    setServices([]);
    setPlans([]);
    setRuns([]);
    setReleases([]);
  }, [applicationId]);

  useEffect(() => {
    setReleases([]);
  }, [environmentId]);

  const reload = useCallback(async () => {
    if (serverId === "") {
      setApplications([]);
      setStatus({ state: "idle" });
      return;
    }
    setStatus({ state: "loading" });
    try {
      const list = await opsApi.deploymentApplicationList(serverId);
      setApplications(list);
      setStatus({ state: "ready" });
    } catch (cause) {
      setStatus({ state: "error", message: toErrorMessage(cause) });
      setApplications([]);
    }
  }, [serverId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  /** 应用 → 环境 / 服务 / 方案 / 运行记录。 */
  const loadApplicationScope = useCallback(async () => {
    if (applicationId === "") return;
    try {
      const [loadedEnvironments, loadedServices, loadedPlans, loadedRuns] = await Promise.all([
        opsApi.deploymentEnvironmentList(applicationId),
        opsApi.deploymentServiceUnitList(applicationId),
        opsApi.deploymentPlanList(applicationId),
        opsApi.deploymentRunList(applicationId),
      ]);
      setEnvironments(loadedEnvironments);
      setServices(loadedServices);
      setPlans(loadedPlans);
      setRuns(loadedRuns);
      setStatus({ state: "ready" });
    } catch (cause) {
      setStatus({ state: "error", message: toErrorMessage(cause) });
    }
  }, [applicationId]);

  useEffect(() => {
    void loadApplicationScope();
  }, [loadApplicationScope]);

  /** 环境 → 版本记录。 */
  useEffect(() => {
    let cancelled = false;
    if (environmentId === "") {
      setReleases([]);
      return () => {
        cancelled = true;
      };
    }
    void (async () => {
      try {
        const list = await opsApi.deploymentReleaseList(environmentId);
        if (!cancelled) setReleases(list);
      } catch (cause) {
        if (!cancelled) setError(toErrorMessage(cause));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [environmentId]);

  const setServerId = useCallback((id: string) => setServerIdState(id), []);
  const setApplicationId = useCallback((id: string) => setApplicationIdState(id), []);
  const setEnvironmentId = useCallback((id: string) => setEnvironmentIdState(id), []);

  /** 包一层：统一错误展示 + 统一刷新。 */
  const run = useCallback(
    async (action: () => Promise<void>, after?: () => Promise<void>): Promise<boolean> => {
      try {
        await action();
        if (after) await after();
        return true;
      } catch (cause) {
        setError(toErrorMessage(cause));
        return false;
      }
    },
    [],
  );

  const saveApplication = useCallback(
    (application: DeploymentApplication) =>
      run(
        async () => {
          await opsApi.deploymentApplicationSave(application);
        },
        async () => {
          await reload();
        },
      ),
    [reload, run],
  );

  const deleteApplication = useCallback(
    (id: string) =>
      run(
        async () => {
          await opsApi.deploymentApplicationDelete(id);
        },
        async () => {
          if (id === applicationId) setApplicationIdState("");
          await reload();
        },
      ),
    [applicationId, reload, run],
  );

  const saveEnvironment = useCallback(
    (environment: DeploymentEnvironment) =>
      run(
        async () => {
          await opsApi.deploymentEnvironmentSave(environment);
        },
        loadApplicationScope,
      ),
    [loadApplicationScope, run],
  );

  const deleteEnvironment = useCallback(
    (id: string) =>
      run(
        async () => {
          await opsApi.deploymentEnvironmentDelete(id);
        },
        async () => {
          if (id === environmentId) setEnvironmentIdState("");
          await loadApplicationScope();
        },
      ),
    [environmentId, loadApplicationScope, run],
  );

  const saveService = useCallback(
    (unit: DeploymentServiceUnit) =>
      run(
        async () => {
          await opsApi.deploymentServiceUnitSave(unit);
        },
        loadApplicationScope,
      ),
    [loadApplicationScope, run],
  );

  const deleteService = useCallback(
    (id: string) =>
      run(
        async () => {
          await opsApi.deploymentServiceUnitDelete(id);
        },
        loadApplicationScope,
      ),
    [loadApplicationScope, run],
  );

  const linkProject = useCallback(
    (unitId: string, projectPath: string, projectId?: string) =>
      run(
        async () => {
          await opsApi.deploymentServiceUnitLinkProject(unitId, projectPath, projectId);
        },
        loadApplicationScope,
      ),
    [loadApplicationScope, run],
  );

  const unlinkProject = useCallback(
    (unitId: string) =>
      run(
        async () => {
          await opsApi.deploymentServiceUnitUnlinkProject(unitId);
        },
        loadApplicationScope,
      ),
    [loadApplicationScope, run],
  );

  /** 新建方案 = 一个空图（节点编辑留给后续阶段）。 */
  const createPlan = useCallback(
    (name: string) => {
      const now = Date.now();
      const graph: DeploymentPlanGraph = {
        plan: {
          id: "",
          application_id: applicationId,
          environment_id: environmentId,
          name,
          version: 1,
          status: "draft",
          proposal_source: "manual",
          risk_level: "low",
          notes: "",
          created_at: now,
          updated_at: now,
        },
        nodes: [],
        edges: [],
      };
      return run(
        async () => {
          await opsApi.deploymentPlanSave(graph);
        },
        loadApplicationScope,
      );
    },
    [applicationId, environmentId, loadApplicationScope, run],
  );

  const deletePlan = useCallback(
    (id: string) =>
      run(
        async () => {
          await opsApi.deploymentPlanDelete(id);
        },
        async () => {
          if (planGraph?.plan.id === id) setPlanGraph(null);
          await loadApplicationScope();
        },
      ),
    [loadApplicationScope, planGraph, run],
  );

  const openPlan = useCallback(async (planId: string) => {
    setLoadingPlanId(planId);
    try {
      const graph = await opsApi.deploymentPlanGet(planId);
      setPlanGraph(graph);
    } catch (cause) {
      setError(toErrorMessage(cause));
    } finally {
      setLoadingPlanId(null);
    }
  }, []);

  const clearError = useCallback(() => setError(null), []);

  return {
    servers: serverOptions,
    serverId,
    setServerId,
    applicationId,
    setApplicationId,
    environmentId,
    setEnvironmentId,
    applications,
    environments,
    services,
    plans,
    runs,
    releases,
    planGraph,
    loadingPlanId,
    status,
    error,
    clearError,
    reload,
    openPlan,
    saveApplication,
    deleteApplication,
    saveEnvironment,
    deleteEnvironment,
    saveService,
    deleteService,
    linkProject,
    unlinkProject,
    createPlan,
    deletePlan,
  };
}
