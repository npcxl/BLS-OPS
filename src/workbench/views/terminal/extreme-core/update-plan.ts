import type { DeployStep } from "./deploy-plan";

/**
 * 「更新现有服务」的计划生成。
 *
 * 与 `deploy-plan`（从 compose 起一套新服务）不同，这里是**改一个已经在跑
 * 的服务**：把一个 ZIP 的内容替换到它真正在读的目录里，然后重启并做健康检查。
 *
 * 全部基于真实命令输出解析，不做猜测：
 * * 服务列表来自 `docker ps`；
 * * 线上目录来自 `docker inspect` 的 `Mounts`（容器挂载）或镜像内置路径；
 * * 健康检查来自 `docker inspect` 的 `State.Health`。
 *
 * 生成步骤**不执行任何写操作**：先备份，再替换，失败时把回滚命令写清楚。
 */

/** 一台主机上的候选服务。 */
export interface ServiceCandidate {
  /** 容器名。 */
  name: string;
  image: string;
  /** `docker ps` 里的端口映射原文，形如 `0.0.0.0:8080->80/tcp`。 */
  ports: string;
  /** 容器挂载：宿主机目录 → 容器内路径。 */
  mounts: { source: string; destination: string }[];
  /** 健康检查命令（有才代表能做"就绪"判定）。 */
  healthcheck?: string;
}

/** `docker ps --format '{{.Names}}\t{{.Image}}\t{{.Ports}}'` 的解析。 */
export function parseDockerPs(stdout: string): ServiceCandidate[] {
  const out: ServiceCandidate[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const cells = line.split("\t").map((cell) => cell.trim());
    if (cells.length < 2 || !cells[0]) continue;
    out.push({
      name: cells[0],
      image: cells[1] ?? "",
      ports: cells[2] ?? "",
      mounts: [],
    });
  }
  return out;
}

/**
 * `docker inspect --format '{{json .Mounts}}' <name>` 的解析。
 *
 * 只认 `bind` 与 `volume`：`tmpfs` 没有宿主机路径，替换它没有意义。
 */
export function parseInspectMounts(stdout: string): { source: string; destination: string }[] {
  try {
    const parsed = JSON.parse(stdout.trim()) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((entry) => {
      if (typeof entry !== "object" || entry === null) return [];
      const record = entry as Record<string, unknown>;
      const type = typeof record.Type === "string" ? record.Type : "";
      const source = typeof record.Source === "string" ? record.Source : "";
      const destination = typeof record.Destination === "string" ? record.Destination : "";
      if (!source || !destination) return [];
      if (type && type !== "bind" && type !== "volume") return [];
      return [{ source, destination }];
    });
  } catch {
    return [];
  }
}

/**
 * 从候选服务里挑出"可能就是这个站点"的那些。
 *
 * 命中规则很保守：容器名 / 镜像名里包含用户给的关键词，或端口里出现常见
 * 的 80/443/8080。**宁可多给选项让用户挑，也不自作主张选一个**。
 */
export function matchServices(
  services: ServiceCandidate[],
  keyword: string,
): ServiceCandidate[] {
  const needle = keyword.trim().toLowerCase();
  if (!needle) return services;
  return services.filter((service) => {
    const haystack = `${service.name} ${service.image} ${service.ports}`.toLowerCase();
    return haystack.includes(needle);
  });
}

/** 静态目录的候选：优先常见的 web 根，其次任意挂载点。 */
export function pickDeployDirs(service: ServiceCandidate): string[] {
  const common = /(^|\/)(www|html|public|dist|static|htdocs|site|web)(\/|$)/i;
  const preferred = service.mounts.filter((mount) => common.test(mount.destination) || common.test(mount.source));
  const list = preferred.length > 0 ? preferred : service.mounts;
  return list.map((mount) => mount.source);
}

/**
 * 生成更新步骤。
 *
 * 顺序刻意是「先校验、再备份、后替换」：
 * 1. `unzip -t` 先确认 ZIP 没坏 —— 解压到一半失败比不开始更麻烦；
 * 2. `cp -a` 备份整个线上目录，**备份失败就停**，绝不带着"没备份"继续覆盖；
 * 3. 解压到暂存目录，再逐层复制进线上目录（不用 `--delete`，避免误删运行时
 *    生成的文件，比如上传目录、缓存）；
 * 4. 重启容器，再读一次健康状态。
 */
export function buildUpdatePlan(input: {
  /**
   * 目标服务。
   *
   * `name` 为空表示**宿主机直接托管**（整台机器没有 Docker）：这时不重启任何
   * 容器，只替换文件并用原域名验证页面。
   */
  service: ServiceCandidate;
  /** 服务器上 ZIP 的绝对路径。 */
  zipPath: string;
  /** 要替换的线上目录（宿主机路径）。 */
  deployDir: string;
  /** 站点域名：宿主机模式下用它做 Host 头验证。 */
  domain?: string;
  /** 暂存目录，默认跟在线上目录旁边。 */
  stagingDir?: string;
  /** 备份目录，默认 `<deployDir>.bak-<时间戳>`。 */
  backupDir?: string;
  now?: number;
}): DeployStep[] {
  const { service, zipPath, deployDir } = input;
  const stamp = new Date(input.now ?? Date.now())
    .toISOString()
    .replace(/[-:T]/g, "")
    .slice(0, 14);
  const staging = input.stagingDir ?? `${deployDir}.staging-${stamp}`;
  const backup = input.backupDir ?? `${deployDir}.bak-${stamp}`;
  const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;

  return [
    {
      id: "check-zip",
      kind: "up",
      title: "校验 ZIP 完整性",
      detail: `unzip -t ${zipPath}（只读，不落盘）`,
      command: `unzip -t ${quote(zipPath)} >/dev/null && echo ok`,
      state: "pending",
    },
    {
      id: "backup",
      kind: "up",
      title: "备份线上目录",
      detail: `${deployDir} → ${backup}（失败则中止，不会覆盖）`,
      command: `cp -a ${quote(deployDir)} ${quote(backup)} && echo ok`,
      // 备份成功之后任何一步失败，都能用这条命令换回去。
      rollback: buildRollback(service.name, deployDir, backup),
      state: "pending",
    },
    {
      id: "extract",
      kind: "up",
      title: "解压到暂存目录",
      detail: `${zipPath} → ${staging}（此时线上目录还没动）`,
      command: `rm -rf ${quote(staging)} && mkdir -p ${quote(staging)} && unzip -oq ${quote(zipPath)} -d ${quote(staging)} && echo ok`,
      state: "pending",
    },
    {
      id: "replace",
      kind: "up",
      title: "替换线上目录内容",
      detail: `把 ${staging} 的内容复制到 ${deployDir}（不删除多余文件，保留运行时数据）`,
      command: `cp -a ${quote(staging)}/. ${quote(deployDir)}/ && echo ok`,
      state: "pending",
    },
    /*
     * 只有**容器托管**才重启进程。
     *
     * 宿主机 nginx 直接读磁盘上的静态文件：替换完就生效，重启 nginx 纯属多余
     * （还会短暂中断同机其它站点）。所以宿主机模式下这一步整段跳过，
     * 验证改成带 Host 头访问原域名。
     */
    ...(service.name
      ? ([
          {
            id: "restart",
            kind: "up",
            title: `重启服务 ${service.name}`,
            detail: `docker restart ${service.name}`,
            command: `docker restart ${quote(service.name)}`,
            state: "pending",
          },
        ] as DeployStep[])
      : []),
    service.name
      ? {
          id: "verify",
          kind: "verify",
          title: "检查容器状态",
          detail: service.healthcheck
            ? `等待健康检查通过：${service.healthcheck}`
            : "没有健康检查，退化为确认容器在 running",
          command: `docker ps --filter ${quote(`name=^/${service.name}$`)} --format '{{.Names}}\t{{.State}}\t{{.Status}}'`,
          state: "pending",
        }
      : {
          id: "verify",
          // 用 `up` 而不是 `verify`：`verify` 走容器状态判定，这里要的是 HTTP 码。
          kind: "up",
          title: "验证页面",
          detail: `本机带 Host: ${input.domain ?? "（未指定域名）"} 请求首页，只看 HTTP 状态`,
          command: `curl -fsS -o /dev/null -w '%{http_code}\\n' -H ${quote(`Host: ${input.domain ?? "localhost"}`)} http://127.0.0.1/`,
          state: "pending",
        },
    {
      id: "cleanup",
      kind: "up",
      title: "清理暂存目录",
      detail: `rm -rf ${staging}（备份 ${backup} 保留，确认无误后再手动删）`,
      command: `rm -rf ${quote(staging)} && echo ok`,
      state: "pending",
    },
  ];
}

/**
 * 回滚命令：把备份换回去并重启。
 *
 * **不自动执行** —— 失败时把它显示给用户，由用户决定是否回滚。自动回滚在
 * "新版本其实是对的、只是健康检查慢"的场景里会帮倒忙。
 */
export function buildRollback(serviceName: string, deployDir: string, backupDir: string): string {
  const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;
  return `rm -rf ${quote(deployDir)} && mv ${quote(backupDir)} ${quote(deployDir)} && docker restart ${quote(serviceName)}`;
}
