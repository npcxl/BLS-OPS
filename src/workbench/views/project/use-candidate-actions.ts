/**
 * 项目卡片右键菜单的动作集合。
 *
 * 拆出来的原因：`CandidateCard` 只负责渲染，菜单里的每条动作都要碰
 * 「工作台标签页 / 远程会话 / 反馈提示」这些别处的状态，放回组件里会把
 * 一张卡片写成控制器。这里统一收口，卡片只传路径与容器名。
 *
 * 约束（与全局一致）：前端只传结构化标识（路径、容器名、动作名），
 * 命令串由 Rust 侧拼；容器操作会改服务器状态，菜单里先确认再调。
 */
import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import { copyText } from "@/lib/clipboard";
import { isInspectionMode } from "@/stores/inspection-store";
import { opsApi, toErrorMessage, type ContainerConfig } from "@/api/ops-api";
import { useDomainStore } from "@/stores/domain-store";
import { useWorkbenchStore } from "@/stores/workbench-store";
import type { WorkbenchPane, WorkspaceTab } from "@/workbench/types";

/** 菜单动作的可视反馈：成功用 success，失败原样抛后端文案。 */
export interface CandidateNotice {
  tone: "success" | "danger";
  text: string;
}

/** 在任意 pane 里找这台服务器已开的终端，避免每次右键都新开一个 tab。 */
function findTerminalTab(pane: WorkbenchPane, serverId: string): WorkspaceTab | null {
  for (const tab of pane.tabs) {
    if (tab.type === "terminal" && tab.serverId === serverId) return tab;
  }
  for (const child of pane.children ?? []) {
    const hit = findTerminalTab(child, serverId);
    if (hit) return hit;
  }
  return null;
}

/** 收集所有终端页签的标题（跨 pane），新建时用来避开重名。 */
export function collectTerminalTitles(pane: WorkbenchPane, into: Set<string>): void {
  for (const tab of pane.tabs) {
    if (tab.type === "terminal") into.add(tab.title);
  }
  for (const child of pane.children ?? []) collectTerminalTitles(child, into);
}

/**
 * 同名终端依次编号：`web` → `web (2)` → `web (3)`。
 *
 * 两台服务器同名（生产常见）时，光看标题分不出是哪一个终端，编号是唯一
 * 不依赖服务器名的区分方式。
 */
export function uniqueTerminalTitle(taken: Set<string>, base: string): string {
  if (!taken.has(base)) return base;
  let index = 2;
  while (taken.has(`${base} (${index})`)) index += 1;
  return `${base} (${index})`;
}

export function useCandidateActions(serverId: string, sessionId: string) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  // 终端页签用**服务器自己的名字**，不用"Server"这种通用词：并列几个 tab 时
  // 要能一眼看出连的是哪台机器。
  const serverName = useDomainStore(
    (s) => s.servers.find((server) => server.id === serverId)?.name ?? null,
  );
  const [notice, setNotice] = useState<CandidateNotice | null>(null);
  const [config, setConfig] = useState<ContainerConfig | null>(null);
  const [configOpen, setConfigOpen] = useState(false);

  /** 统一跑一个会改服务器状态的动作：busy + 失败转提示，绝不静默。 */
  const run = useCallback(
    async (task: () => Promise<CandidateNotice | null>) => {
      setBusy(true);
      setNotice(null);
      try {
        setNotice(await task());
      } catch (cause) {
        setNotice({ tone: "danger", text: toErrorMessage(cause) });
      } finally {
        setBusy(false);
      }
    },
    [],
  );

  const copyPath = useCallback(
    async (path: string) => {
      const ok = await copyText(path);
      setNotice(
        ok
          ? { tone: "success", text: t("Path copied") }
          : { tone: "danger", text: t("Copy failed") },
      );
    },
    [t],
  );

  /**
   * 在终端里跟踪到该目录：已有同服务器的终端就复用它（保留 shell 与文件
   * 面板状态），只把 `initialPath` 换掉；否则新开一个终端 tab。
   *
   * 新 tab 的标题是服务器名；同名服务器再开一个时依次变成 `名称 (2)`、
   * `名称 (3)`，一排 tab 不会出现两个一模一样的标题。
   *
   * `nonce` 是必须的 —— 对同一个目录连续右键两次，只看 path 的话第二次的
   * 依赖没变化，`cd` 不会执行。
   */
  const openInTerminal = useCallback(
    (path: string) => {
      const store = useWorkbenchStore.getState();
      const nonce = Date.now();
      const existing = findTerminalTab(store.rootPane, serverId);
      if (existing && existing.serverId) {
        store.updateTab(existing.id, { initialPath: { path, nonce } });
        store.openOrFocusServerTab(existing as WorkspaceTab & { serverId: string });
        return;
      }
      const taken = new Set<string>();
      collectTerminalTitles(store.rootPane, taken);
      store.openOrFocusServerTab({
        id: crypto.randomUUID(),
        type: "terminal",
        title: uniqueTerminalTitle(taken, serverName ?? t("Terminal")),
        subtitle: path,
        serverId,
        sessionId: crypto.randomUUID(),
        initialPath: { path, nonce },
      });
    },
    [serverId, serverName, t],
  );

  /**
   * 重启 Nginx：先 `nginx -t`，配置不通过就不 reload。
   *
   * 用 reload 而不是 restart —— 平滑接管连接，不会把正在访问的用户切掉；
   * `nginx -t` 失败时返回原文，让用户知道是哪一行配置坏了。
   */
  /**
   * 巡检模式闸门：**只拦会改服务器状态的入口**（重启 / 停止 / reload）。
   * 看容器配置、复制路径、在终端跟踪这些只读动作照常可用。
   */
  const blockedByInspection = useCallback((): boolean => {
    if (!isInspectionMode()) return false;
    setNotice({ tone: "danger", text: t("Inspection mode: changes are disabled") });
    return true;
  }, [t]);

  const reloadNginx = useCallback(
    () => {
      if (blockedByInspection()) return;
      void run(async () => {
        const test = await opsApi.nginxTest(sessionId);
        if (!test.success) {
          throw new Error(test.output || t("nginx -t failed; the running config was left untouched"));
        }
        await opsApi.nginxReload(sessionId);
        return { tone: "success", text: t("Nginx reloaded") };
      });
    },
    [blockedByInspection, run, sessionId, t],
  );

  const controlContainer = useCallback(
    (action: "stop" | "restart", container: string) => {
      if (blockedByInspection()) return;
      void run(async () => {
        await opsApi.dockerContainerAction(sessionId, action, container);
        return {
          tone: "success",
          text:
            action === "stop"
              ? t("Container {{name}} stopped", { name: container })
              : t("Container {{name}} restarted", { name: container }),
        };
      });
    },
    [blockedByInspection, run, sessionId, t],
  );

  /** 读容器配置（只读）。内容进弹窗，不在菜单里回显 —— 字段多，塞不下。 */
  const inspectContainer = useCallback(
    (container: string) =>
      run(async () => {
        const data = await opsApi.dockerInspectContainer(sessionId, container);
        setConfig(data);
        setConfigOpen(true);
        return null;
      }),
    [run, sessionId],
  );

  const closeConfig = useCallback(() => setConfigOpen(false), []);

  return {
    busy,
    notice,
    clearNotice: () => setNotice(null),
    config,
    configOpen,
    closeConfig,
    copyPath,
    openInTerminal,
    reloadNginx,
    controlContainer,
    inspectContainer,
  };
}
