/**
 * **能力注册表**：把"目标上有什么、下一步该做什么"做成数据，而不是写死流程。
 *
 * 之前的超能只认 `compose.yaml`：项目里换一种部署方式（K8s、systemd、
 * 纯静态目录、自建 Dockerfile），代码里没有任何分支能接住它。
 *
 * 这里的原则：
 * * 只看**技术栈的通用约定**（`Dockerfile`、`compose.yaml`、`Chart.yaml`、
 *   `k8s/`、`package.json`、`pom.xml`…），不看项目名、不假设某个服务的名字；
 * * 一条能力 = 适用条件 + 只读探测 + 变更前要讲清的四件事；
 * * **新增一种环境只加一条注册项**，聊天、任务卡、状态流转都不动。
 */

/** 从仓库文件与原机探测里得到的**事实**，不含任何判断。 */
export interface EnvironmentFacts {
  /** 服务器上 `docker ps` 能跑（有 Docker 且有权限）。 */
  hasDocker: boolean;
  /** 服务器上有 kubeconfig / `kubectl` 可用。 */
  hasKubernetes: boolean;
  /** 服务器上跑着 systemd（普通 Linux 一定有，容器里常见没有）。 */
  hasSystemd: boolean;
  /** 服务器上有 nginx（宿主机或容器）。 */
  hasNginx: boolean;
  /** 附件 / 仓库里的相对路径（只用来判断技术栈，不假设内容）。 */
  files: string[];
}

/** 变更前必须在对话里讲清的四件事。 */
export interface ChangeImpact {
  /** 改哪个目标的哪个部分。 */
  target: string;
  /** 会动到什么（文件、服务、端口）。 */
  scope: string;
  /** 怎么算成功。 */
  verify: string;
  /** 出问题怎么恢复。 */
  recover: string;
}

export interface Capability {
  id: string;
  /** 展示给用户的名字。 */
  label: string;
  /** 适用条件：只用事实判断，不猜。 */
  applies: (facts: EnvironmentFacts) => boolean;
  /**
   * 这个能力下**先做的只读事**（命令或工具名）。
   *
   * 顺序有意义：先确认"是不是这种部署方式"，再决定要不要变更。
   */
  probe: string[];
  /** 这类变更的确认要点模板；具体目标由执行器填。 */
  impact: (input: { target: string }) => ChangeImpact;
}

/** 只看文件名判断是否像 K8s 清单 / Helm chart。 */
function looksLikeKubernetes(files: string[]): boolean {
  return files.some(
    (file) =>
      /(^|\/)(Chart\.yaml|kustomization\.ya?ml)$/i.test(file) ||
      /(^|\/)(deployment|statefulset|daemonset|service|ingress)\.ya?ml$/i.test(file) ||
      /(^|\/)k8s\//i.test(file) ||
      /(^|\/)manifests\//i.test(file),
  );
}

/** 只看文件名判断是否像 Compose 项目。 */
function looksLikeCompose(files: string[]): boolean {
  return files.some((file) => /(^|\/)(docker-)?compose(\.[\w-]+)?\.ya?ml$/i.test(file));
}

/** 有 Dockerfile 但不一定有 compose。 */
function looksLikeDockerfile(files: string[]): boolean {
  return files.some((file) => /(^|\/)Dockerfile(\.[\w-]+)?$/i.test(file));
}

/** 纯前端 / 静态产物：有入口页但没有任何服务端配置。 */
function looksLikeStatic(files: string[]): boolean {
  const hasEntry = files.some((file) => /(^|\/)index\.html?$/i.test(file));
  return hasEntry && !looksLikeCompose(files) && !looksLikeDockerfile(files) && !looksLikeKubernetes(files);
}

/**
 * 注册表。**顺序即优先级**：越具体的越靠前。
 *
 * 每个 `applies` 都只看事实，不看项目名 —— 所以换成任何一个没见过的仓库，
 * 判定结果仍然成立。
 */
export const CAPABILITIES: Capability[] = [
  {
    id: "kubernetes",
    label: "Kubernetes 工作负载",
    applies: (facts) => facts.hasKubernetes || looksLikeKubernetes(facts.files),
    probe: [
      "kubectl config current-context",
      "kubectl get deploy,sts,svc,ingress -A -o wide",
      "kubectl get pods -A --field-selector=status.phase!=Running",
    ],
    impact: ({ target }) => ({
      target: `Kubernetes 工作负载 ${target}`,
      scope: "更新镜像 / 配置，滚动重启 Pod；旧 ReplicaSet 保留",
      verify: "rollout status 通过，且入口 URL 返回预期状态码",
      recover: "kubectl rollout undo deploy/<name> 回到上一个版本",
    }),
  },
  {
    id: "compose",
    label: "Docker Compose 服务",
    applies: (facts) => looksLikeCompose(facts.files) || (facts.hasDocker && looksLikeDockerfile(facts.files)),
    probe: [
      "docker compose config --services",
      "docker compose ps",
      "docker inspect --format '{{json .Mounts}}' <容器名>",
    ],
    impact: ({ target }) => ({
      target: `Compose 服务 ${target}`,
      scope: "重建容器；数据卷保留，绑定挂载的目录会被新内容覆盖（先备份）",
      verify: "容器 running，且健康检查 / 入口 URL 通过",
      recover: "备份目录回滚 + docker compose up -d 重建上一个版本",
    }),
  },
  {
    id: "static-nginx",
    label: "静态站点（Nginx 托管）",
    applies: (facts) => looksLikeStatic(facts.files) && facts.hasNginx,
    probe: [
      "nginx -T 2>&1 | head -n 400",
      "ss -ltnp 2>/dev/null | head -n 40",
    ],
    impact: ({ target }) => ({
      target: `静态目录 ${target}`,
      scope: "替换目录内容；不改 Nginx 配置，无需 reload",
      verify: "带原域名的 Host 头请求首页与关键静态资源",
      recover: "备份目录换回原位（cp -a <target>.bak-<ts> <target>）",
    }),
  },
  {
    id: "systemd",
    label: "systemd 服务",
    applies: (facts) => facts.hasSystemd && facts.files.some((file) => /(^|\/)\.?[\w-]+\.service$/i.test(file)),
    probe: ["systemctl list-units --type=service --state=running --no-pager", "journalctl -u <unit> -n 80 --no-pager"],
    impact: ({ target }) => ({
      target: `systemd 单元 ${target}`,
      scope: "替换程序文件并 restart；配置变更才 daemon-reload",
      verify: "systemctl is-active + 入口 URL 或端口探测",
      recover: "保留上一版程序文件，`systemctl restart` 回到旧版本",
    }),
  },
  {
    id: "bare-linux",
    label: "普通 Linux 项目",
    /*
     * **只有看到构建或入口痕迹才算"普通 Linux 项目"**。
     *
     * 早先这里是无条件兜底：任何一堆陌生文件都会被判成"普通 Linux 项目"，
     * 等于凭空猜了一种部署方式。现在认不出来就返回 `null`，让
     * `suggestNextProbe` 先去读 README、看监听端口 —— 证据够了再判断。
     */
    applies: (facts) => {
      if (looksLikeCompose(facts.files) || looksLikeKubernetes(facts.files) || looksLikeStatic(facts.files)) {
        return false;
      }
      const hasBuildOrEntry = facts.files.some((file) =>
        /(^|\/)(Makefile|CMakeLists\.txt|build\.gradle(\.kts)?|pom\.xml|package\.json|pyproject\.toml|requirements\.txt|go\.mod|Cargo\.toml|Gemfile|composer\.json)$/i.test(
          file,
        ) ||
        /(^|\/)(main|app|server|index)\.(go|rs|py|rb|php|java|kt|cs|js|ts|sh)$/i.test(file) ||
        /(^|\/)README(\.\w+)?$/i.test(file),
      );
      return hasBuildOrEntry;
    },
    probe: ["ls -la", "ls -la <目标目录>", "ss -ltnp 2>/dev/null | head -n 40", "ps aux --sort=-%cpu | head -n 20"],
    impact: ({ target }) => ({
      target: `目录 / 进程 ${target}`,
      scope: "按项目自带的说明安装依赖并启动；不接管系统包管理器",
      verify: "进程在跑 + 端口可连 + 入口 URL 可达",
      recover: "保留旧文件与原有启动方式，可随时恢复回上一版",
    }),
  },
];

/**
 * 从现有状态推断事实。
 *
 * 只读**已经拿到的**信息，不做额外探测：
 * * `files` 来自附件清单；
 * * `docker` / `compose` 来自 `preflight`（它的 `state` 就是"命令是否存在"）；
 * * `containersProbed` 表示 `docker ps` 跑通过。
 *
 * **`hasKubernetes` / `hasNginx` / `hasSystemd` 默认按"未知"处理**（false /
 * true 的保守值），由后续工具探测再修正 —— 宁可少判一种能力，也不凭空假设
 * 服务器上有什么。
 */
export function deriveFacts(input: {
  /** 附件与仓库里的相对路径。 */
  files: string[];
  /** preflight 里 docker 的检查结果。 */
  docker?: { state: string };
  /** preflight 里 compose 的检查结果。 */
  compose?: { state: string };
  /** 是否已经成功执行过 `docker ps`。 */
  containersProbed?: boolean;
  /** 工具的探测结论（只读工具跑过才有）。 */
  probed?: {
    kubernetes?: boolean;
    nginx?: boolean;
    systemd?: boolean;
  };
}): EnvironmentFacts {
  const dockerPresent = input.docker?.state === "checked" || Boolean(input.containersProbed);
  return {
    hasDocker: dockerPresent,
    // 只有"实际跑过 kubectl"才算有集群；仓库里有清单只影响能力判定，不影响这条。
    hasKubernetes: input.probed?.kubernetes === true,
    hasNginx: input.probed?.nginx === true,
    // Linux 一定有 systemd（容器里通常没有，但那要工具确认过才排除）。
    hasSystemd: input.probed?.systemd ?? true,
    files: input.files,
  };
}

/**
 * 从事实推断**首要能力**（最具体的那条）。
 *
 * 一条都不匹配时返回 `null`：这时该做的是**继续只读探测**（读 README、
 * 构建配置、依赖），而不是直接猜一种部署方式。
 */
export function primaryCapability(facts: EnvironmentFacts): Capability | null {
  return CAPABILITIES.find((capability) => capability.applies(facts)) ?? null;
}

/** 所有命中的能力（用户指定了某种方式时，可能同时有多种）。 */
export function matchingCapabilities(facts: EnvironmentFacts): Capability[] {
  return CAPABILITIES.filter((capability) => capability.applies(facts));
}

/**
 * 给模型的**下一步建议**：先用哪种能力、先跑哪几条只读探测。
 *
 * 返回的是"该查什么"，不是"该执行什么"——变更永远要经过确认。
 */
export function suggestNextProbe(facts: EnvironmentFacts): { capability: Capability | null; commands: string[] } {
  const capability = primaryCapability(facts);
  if (!capability) {
    return {
      capability: null,
      commands: [
        // 没有明显技术栈：先读项目自述与构建配置，再决定。
        "ls -la",
        "head -n 80 README.md 2>/dev/null",
        "ss -ltnp 2>/dev/null | head -n 40",
      ],
    };
  }
  return { capability, commands: capability.probe };
}
