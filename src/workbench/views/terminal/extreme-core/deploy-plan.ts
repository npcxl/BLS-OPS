/**
 * 超能模式的**部署计划**（确定性生成，不靠模型猜）。
 *
 * 规则按用户裁决的顺序：
 * 1. 附件里有 compose 文件 → 沿用它的服务定义（不给它编新配置）；
 * 2. 没有 compose 文件但有 Dockerfile → 交给用户确认后走 build（这一版只提示，不自动生成）；
 * 3. 都没有 → 不猜，明确让用户补文件。
 *
 * 每一步都写清**来源 / 目标 / 覆盖策略**，确认前不执行任何有副作用的动作。
 */

import { i18n } from "@/i18n";

export type StepKind = "upload" | "pull" | "up" | "verify" | "tool";

export type StepState = "pending" | "waiting" | "running" | "success" | "failed" | "skipped";

export interface DeployStep {
  id: string;
  kind: StepKind;
  /** 一句话动作（界面主行）。 */
  title: string;
  /** 具体目标：命令、目标路径、覆盖策略… */
  detail: string;
  /** 要执行的命令（upload 步骤为空）。 */
  command?: string;
  /**
   * 实际执行脚本（`cd` 包装、退出码回传、内部标记）。
   *
   * 只在"调试详情"里展开：主行与确认卡首屏永远用 `command`（可读命令）。
   */
  script?: string;
  /** upload 步骤要写入的文本内容。 */
  text?: string;
  /** upload 步骤要写入的二进制内容（base64，图片/字体/jar/归档）。 */
  data?: string;
  /** upload 步骤的目标路径。 */
  remotePath?: string;
  /**
   * Agent 工具步骤的风险等级（`tool` 步骤才有）。
   *
   * `read` 自动执行；`write` / `danger` 在普通权限下确认、完全权限下直接执行 ——
   * 卡片据此显示"已确认 / 待确认"，而不是把危险操作混进普通步骤。
   */
  risk?: "read" | "write" | "danger";
  /**
   * 写文件前落下的备份（服务器绝对路径）。
   *
   * 有它就在步骤里显示"备份：…"与回滚命令：用户能在事后把改坏的文件恢复，
   * 不用去翻日志猜备份叫什么。
   */
  backupPath?: string;
  /**
   * 这一步改坏了怎么恢复（可执行的完整命令）。
   *
   * 有回滚方案的步骤才填；失败时界面上直接给出来，让用户判断要不要回滚 ——
   * 自动回滚在"新版本其实是对的、只是健康检查慢"的场景里会帮倒忙。
   */
  rollback?: string;
  /**
   * 服务器**临时目录**里的源文件（附件已上传时才有）。
   *
   * 有它就不必再走一遍 base64：执行时直接在服务器上 `cp -a` 到目标，
   * 几百兆的目录也能秒级复制。
   */
  sourcePath?: string;
  state: StepState;
  stdout?: string;
  stderr?: string;
  exitCode?: number | null;
  /** 输出超过上限被截断（界面要说明，不能把半截当完整结果）。 */
  truncated?: boolean;
}

export interface ComposeService {
  name: string;
  image?: string;
  /** 有 `build:` 段，说明要现场构建。 */
  build?: boolean;
}

const COMPOSE_NAME = /^(docker-)?compose\.ya?ml$/i;
const PROJECT_DIR = "~/bls-deploy";

/** 从附件集合里找 compose 文件（取第一个）。 */
export function findCompose(
  files: { name: string; text?: string; remotePath?: string }[],
): {
  name: string;
  text: string;
  /** 已上传到服务器临时目录的副本（有就能直接 `cp`）。 */
  remotePath?: string;
} | null {
  const hit = files.find((file) => COMPOSE_NAME.test(file.name) && typeof file.text === "string");
  return hit ? { name: hit.name, text: hit.text ?? "", remotePath: hit.remotePath } : null;
}

/**
 * 极简 compose 解析：只取服务名、`image:` 和是否 `build:`。
 *
 * 不追求完整 YAML —— 目标是"说清楚会拉起哪些服务、用哪些镜像"，
 * 不需要理解 anchors / 多文档。
 */
export function parseComposeServices(text: string): ComposeService[] {
  const lines = text.split(/\r?\n/);
  const services: ComposeService[] = [];
  let inServices = false;
  let current: ComposeService | null = null;

  for (const line of lines) {
    if (/^services:\s*$/.test(line)) {
      inServices = true;
      continue;
    }
    if (!inServices) continue;
    // 回到顶层键（顶格且不是注释）→ 服务段结束。
    if (/^[A-Za-z_]/.test(line)) break;

    const serviceMatch = /^\s{2}([A-Za-z0-9_.-]+):\s*$/.exec(line);
    if (serviceMatch) {
      current = { name: serviceMatch[1] };
      services.push(current);
      continue;
    }
    if (!current) continue;
    const imageMatch = /^\s{4}image:\s*(.+?)\s*$/.exec(line);
    if (imageMatch) {
      current.image = imageMatch[1].replace(/^["']|["']$/g, "");
      continue;
    }
    if (/^\s{4}build:/.test(line)) current.build = true;
  }
  return services;
}

/** 项目目录名：取 compose 文件名去掉扩展名，转成安全片段。 */
function projectSlug(composeName: string): string {
  return (
    composeName
      .replace(/\.ya?ml$/i, "")
      .replace(/^(docker-)?compose$/i, "")
      .replace(/[^A-Za-z0-9_.-]/g, "-")
      .replace(/^-+|-+$/g, "") || "app"
  );
}

/**
 * 生成部署计划。**没有任何有副作用的动作在这一步发生。**
 *
 * 返回 `{ plan, blocked }`：`blocked` 非空表示计划不完整，界面要说明原因
 * （例如没有 compose 文件），而不是硬着头皮生成一堆命令。
 */
export function buildDeployPlan(
  input: {
    name: string;
    /** 相对路径（拖入文件夹时带层级）。 */
    path?: string;
    text?: string;
    /** 二进制内容的 base64（图片 / 字体 / jar / 归档）。 */
    data?: string;
    /** 已上传到服务器临时目录的路径（有它部署时改走 `cp -a`）。 */
    remotePath?: string;
  }[],
  options: { projectHint?: string } = {},
): { plan: DeployStep[]; blocked: string | null; services: ComposeService[] } {
  const compose = findCompose(input);
  if (!compose) {
    return {
      plan: [],
      blocked: i18n.t(
        "没有找到 compose.yaml / docker-compose.yml。请先把它拖进来，或告诉我用别的方式部署。",
      ),
      services: [],
    };
  }

  const services = parseComposeServices(compose.text);
  if (services.length === 0) {
    return {
      plan: [],
      blocked: i18n.t("compose 文件里没有解析到 services，请检查缩进或内容是否完整。"),
      services,
    };
  }

  const slug = options.projectHint || projectSlug(compose.name);
  const remoteDir = `${PROJECT_DIR}/${slug}`;
  const remotePath = `${remoteDir}/${compose.name}`;
  const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;
  const composeArgs = `-f ${quote(remotePath)}`;
  const hasImage = services.some((service) => service.image);
  const hasBuild = services.some((service) => service.build);

  /*
   * compose 之外的附件：项目里的脚本、配置、静态资源、jar、图片……
   *
   * 它们和 compose 一样属于"要放到服务器上"的东西，所以也进计划 —— 但只在
   * 用户确认后才写，且逐个列出来源 / 目标 / 覆盖策略。二进制走 `data`。
   */
  const uploads: DeployStep[] = input
    .filter((file) => file.name !== compose.name && (file.text !== undefined || file.data))
    .map((file, index) => {
      const relative = file.path ?? file.name;
      return {
        id: `upload-${index}`,
        kind: "upload" as const,
        title: i18n.t("上传 {{name}}", { name: relative }),
        detail: `来源：本地附件 ${relative} · 目标：${remoteDir}/${relative} · 覆盖策略：覆盖同名文件（先建目录）`,
        ...(file.data ? { data: file.data } : { text: file.text }),
        remotePath: `${remoteDir}/${relative}`,
        // 附件已上传到临时目录 → 部署时直接 cp，不再走一遍 base64。
        sourcePath: file.remotePath,
        state: "pending" as const,
      };
    });

  const plan: DeployStep[] = [
    {
      id: "upload",
      kind: "upload",
      title: "上传 Compose 文件",
      detail: `来源：本地附件 ${compose.name} · 目标：${remotePath} · 覆盖策略：覆盖同名文件（先建目录）`,
      text: compose.text,
      remotePath,
      sourcePath: compose.remotePath,
      state: "pending",
    },
    {
      id: "mkdir",
      kind: "up",
      title: "准备部署目录",
      detail: `在服务器上创建 ${remoteDir}（已存在则保持不动）`,
      command: `mkdir -p ${quote(remoteDir)}`,
      state: "pending",
    },
  ];

  // 其余附件排在目录创建之后、镜像操作之前：先把文件放齐，再构建/启动。
  plan.push(...uploads);

  if (hasImage) {
    plan.push({
      id: "pull",
      kind: "pull",
      title: "拉取镜像",
      detail: services
        .filter((service) => service.image)
        .map((service) => `${service.name} → ${service.image}`)
        .join(" · "),
      command: `docker compose ${composeArgs} pull`,
      state: "pending",
    });
  }

  if (hasBuild) {
    plan.push({
      id: "build",
      kind: "up",
      title: "构建镜像",
      detail: "compose 里有 build 段，需要在服务器上构建（会下载依赖，耗时较长）",
      command: `docker compose ${composeArgs} build`,
      state: "pending",
    });
  }

  plan.push(
    {
      id: "up",
      kind: "up",
      title: "启动服务",
      detail: `服务：${services.map((service) => service.name).join(", ")} · 后台启动，移除已不存在于配置里的旧容器`,
      command: `docker compose ${composeArgs} up -d --remove-orphans`,
      state: "pending",
    },
    {
      id: "verify",
      kind: "verify",
      title: "验证容器状态",
      detail: "读取 compose 项目里每个容器的实际状态，非 running 即视为失败",
      command: `docker compose ${composeArgs} ps --format '{{.Name}} {{.State}} {{.Status}}'`,
      state: "pending",
    },
  );

  return { plan, blocked: null, services };
}

/** 验证步骤的结果解读：全部 running 才算通过。 */
export function verifyPassed(output: string): { ok: boolean; reason: string } {
  const lines = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0) return { ok: false, reason: "没有读到任何容器状态" };
  const bad = lines.filter((line) => !/\brunning\b/i.test(line));
  if (bad.length > 0) return { ok: false, reason: bad.join("\n") };
  return { ok: true, reason: `${lines.length} 个容器均为 running` };
}
