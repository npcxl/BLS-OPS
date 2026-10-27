/**
 * 项目卡片右键菜单的条目构造。
 *
 * 纯函数（除了取 t）：输入是候选项目的事实（路径、部署实例、网关路由），
 * 输出是菜单项。**没有事实就不给入口** —— 没有 Docker 实例不出容器菜单，
 * 没有宿主机 Nginx 不出「重启 Nginx」，也不拿"可能"去猜。
 */
import { Copy, FileCode2, RefreshCw, RotateCw, Square, TerminalSquare } from "lucide-react";
import type { ContextMenuItem } from "@/components/ui/context-menu";
import type { CandidateInstance, DeploymentInstance, GatewayRoute } from "@/api/ops-api";

export interface CandidateMenuTarget {
  path: string;
  /** 该候选关联到的部署实例（容器 / systemd / nginx / k8s）。 */
  instances: CandidateInstance[];
  /** 后端按 `linked_project_id` 关联到该项目的 Nginx 路由。 */
  routes: GatewayRoute[];
}

export function buildCandidateMenuItems({
  target,
  busy,
  t,
  onCopyPath,
  onOpenTerminal,
  onReloadNginx,
  onContainerAction,
  onStopContainer,
  onInspectContainer,
  onOpenPath,
}: {
  target: CandidateMenuTarget;
  busy: boolean;
  t: (key: string, options?: Record<string, unknown>) => string;
  onCopyPath: (path: string) => void;
  /** 终端页签的标题由调用方取服务器名（不是项目名），这里只给路径。 */
  onOpenTerminal: (path: string) => void;
  onReloadNginx: () => void;
  onContainerAction: (action: "stop" | "restart", container: string) => void;
  /** 停容器要二次确认，交给卡片弹 ConfirmDialog。 */
  onStopContainer: (container: string) => void;
  onInspectContainer: (container: string) => void;
  onOpenPath: (path: string) => void;
}): ContextMenuItem[] {
  const { path, instances, routes } = target;

  const dockerContainers = instances.filter((instance) => instance.kind === "docker");
  // 只有 `nginx` 网关实例才是宿主机 nginx（由 `nginx -T` 发现）；容器里的
  // nginx 归 docker 收集器，对它执行 `nginx -s reload` 无效，只能重启容器。
  // 光有路由不算 —— 路由可能由容器里的 nginx 提供。
  const hostNginx = instances.some((instance) => instance.kind === "nginx");

  const nginxConfigs = Array.from(
    new Set([
      ...instances.filter((instance) => instance.kind === "nginx").flatMap((instance) => instance.config_files),
      ...instances.filter((instance) => instance.service?.id === "nginx").flatMap((instance) => instance.config_files),
      ...routes.map((route) => route.config_file).filter((file): file is string => Boolean(file)),
    ]),
  );

  const items: ContextMenuItem[] = [
    {
      id: "copy-path",
      label: t("Copy path"),
      icon: Copy,
      onSelect: () => onCopyPath(path),
    },
    {
      id: "open-terminal",
      label: t("Track in terminal"),
      icon: TerminalSquare,
      onSelect: () => onOpenTerminal(path),
    },
  ];

  if (hostNginx) {
    items.push({ id: "sep-nginx", separator: true });
    items.push({
      id: "nginx-reload",
      label: t("Reload Nginx"),
      icon: RefreshCw,
      disabled: busy,
      onSelect: onReloadNginx,
    });
  }

  if (nginxConfigs.length > 0) {
    items.push(
      nginxConfigs.length === 1
        ? {
            id: "nginx-config",
            label: t("View Nginx config"),
            icon: FileCode2,
            onSelect: () => onOpenPath(nginxConfigs[0]),
          }
        : {
            id: "nginx-config",
            label: t("View Nginx config"),
            icon: FileCode2,
            children: nginxConfigs.map((file) => ({
              id: `nginx-config-${file}`,
              label: file.split("/").pop() ?? file,
              onSelect: () => onOpenPath(file),
            })),
          },
    );
  }

  if (dockerContainers.length > 0) {
    items.push({ id: "sep-docker", separator: true });
    // 只有一个容器时直接平铺，菜单不必多一层；多个容器才收进子菜单。
    if (dockerContainers.length === 1) {
      const container = dockerContainers[0].name;
      items.push(
        {
          id: "docker-restart",
          label: t("Restart container {{name}}", { name: container }),
          icon: RotateCw,
          disabled: busy,
          onSelect: () => onContainerAction("restart", container),
        },
        {
          id: "docker-stop",
          label: t("Stop container {{name}}", { name: container }),
          icon: Square,
          danger: true,
          disabled: busy,
          onSelect: () => onStopContainer(container),
        },
        {
          id: "docker-config",
          label: t("View container config"),
          icon: FileCode2,
          disabled: busy,
          onSelect: () => onInspectContainer(container),
        },
      );
    } else {
      items.push(
        {
          id: "docker-restart",
          label: t("Restart container"),
          icon: RotateCw,
          children: dockerContainers.map((instance) => ({
            id: `docker-restart-${instance.id}`,
            label: instance.name,
            disabled: busy,
            onSelect: () => onContainerAction("restart", instance.name),
          })),
        },
        {
          id: "docker-stop",
          label: t("Stop container"),
          icon: Square,
          danger: true,
          children: dockerContainers.map((instance) => ({
            id: `docker-stop-${instance.id}`,
            label: instance.name,
            disabled: busy,
            onSelect: () => onStopContainer(instance.name),
          })),
        },
        {
          id: "docker-config",
          label: t("View container config"),
          icon: FileCode2,
          children: dockerContainers.map((instance) => ({
            id: `docker-config-${instance.id}`,
            label: instance.name,
            disabled: busy,
            onSelect: () => onInspectContainer(instance.name),
          })),
        },
      );
    }
  }

  return items;
}

/**
 * 「应用服务 / 基础设施」列表里单个运行实例的右键菜单。
 *
 * 与项目卡片的差别：这里只有实例，没有项目路径。所以路径类动作取实例自己的
 * 工作目录 / 源码路径 / 配置文件；Docker 与 Nginx 的入口按实例类型给，
 * systemd / k8s 只保留路径相关动作 —— 没有的能力不给假入口。
 */
export function buildInstanceMenuItems({
  instance,
  busy,
  t,
  onCopyPath,
  onOpenTerminal,
  onReloadNginx,
  onContainerAction,
  onStopContainer,
  onInspectContainer,
  onOpenPath,
}: {
  instance: DeploymentInstance;
  busy: boolean;
  t: (key: string, options?: Record<string, unknown>) => string;
  onCopyPath: (path: string) => void;
  onOpenTerminal: (path: string) => void;
  onReloadNginx: () => void;
  onContainerAction: (action: "stop" | "restart", container: string) => void;
  onStopContainer: (container: string) => void;
  onInspectContainer: (container: string) => void;
  onOpenPath: (path: string) => void;
}): ContextMenuItem[] {
  const paths = Array.from(
    new Set([
      ...instance.working_directories,
      ...instance.source_paths,
      ...instance.config_files,
    ]),
  );
  // 跟踪用"它真正跑在哪儿"：优先工作目录（进程 cwd），其次源码路径。
  const trackPath = instance.working_directories[0] ?? instance.source_paths[0] ?? null;
  const nginxConfigs = instance.config_files.filter(
    (file) => file.toLowerCase().includes("nginx") || file.endsWith(".conf"),
  );

  const items: ContextMenuItem[] = [];

  if (paths.length === 1) {
    items.push({
      id: "copy-path",
      label: t("Copy path"),
      icon: Copy,
      onSelect: () => onCopyPath(paths[0]),
    });
  } else if (paths.length > 1) {
    items.push({
      id: "copy-path",
      label: t("Copy path"),
      icon: Copy,
      children: paths.map((path) => ({
        id: `copy-${path}`,
        label: path,
        onSelect: () => onCopyPath(path),
      })),
    });
  }

  items.push({
    id: "open-terminal",
    label: t("Track in terminal"),
    icon: TerminalSquare,
    disabled: trackPath === null,
    onSelect: () => {
      if (trackPath) onOpenTerminal(trackPath);
    },
  });

  if (instance.kind === "nginx") {
    items.push(
      { id: "sep-nginx", separator: true },
      {
        id: "nginx-reload",
        label: t("Reload Nginx"),
        icon: RefreshCw,
        disabled: busy,
        onSelect: onReloadNginx,
      },
    );
    if (nginxConfigs.length > 0) {
      items.push({
        id: "nginx-config",
        label: t("View Nginx config"),
        icon: FileCode2,
        children: nginxConfigs.map((file) => ({
          id: `nginx-config-${file}`,
          label: file.split("/").pop() ?? file,
          onSelect: () => onOpenPath(file),
        })),
      });
    }
  }

  if (instance.kind === "docker") {
    const container = instance.name;
    items.push(
      { id: "sep-docker", separator: true },
      {
        id: "docker-restart",
        label: t("Restart container {{name}}", { name: container }),
        icon: RotateCw,
        disabled: busy,
        onSelect: () => onContainerAction("restart", container),
      },
      {
        id: "docker-stop",
        label: t("Stop container {{name}}", { name: container }),
        icon: Square,
        danger: true,
        disabled: busy,
        onSelect: () => onStopContainer(container),
      },
      {
        id: "docker-config",
        label: t("View container config"),
        icon: FileCode2,
        disabled: busy,
        onSelect: () => onInspectContainer(container),
      },
    );
  }

  return items;
}
