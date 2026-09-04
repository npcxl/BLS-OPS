/**
 * DockerResourceProvider —— 容器 / 镜像 / 网络 / Volume 参数补全。
 *
 * **按子命令 + 光标所在参数位**决定给哪一类资源：
 *
 * | 输入                        | 补全         |
 * | --------------------------- | ------------ |
 * | `docker logs <cursor>`      | 容器         |
 * | `docker rmi <cursor>`       | 镜像         |
 * | `docker network rm <cursor>`| 网络         |
 * | `docker volume rm <cursor>` | Volume       |
 *
 * 只认"容器参数"的子命令（logs/exec/inspect/start/stop/restart/port …）。
 * `docker <cursor>` 不归它管 —— 那应该是子命令补全，交给知识库。
 *
 * 容器名来自服务器（`docker ps`），同样要转义后才写回 shell。
 */

import { opsApi } from "@/api/ops-api";
import { quotePathSegment } from "../path-input";
import type {
  CompletionContext,
  CompletionItem,
  CompletionProvider,
  CompletionResult,
  ParsedLine,
} from "../types";

/** `docker <子命令> <容器>` —— 这些子命令的第一个参数一定是容器。 */
const CONTAINER_SUBCOMMANDS = new Set([
  "attach",
  "commit",
  "cp",
  "diff",
  "exec",
  "export",
  "inspect",
  "kill",
  "logs",
  "pause",
  "port",
  "rename",
  "restart",
  "rm",
  "start",
  "stats",
  "stop",
  "top",
  "unpause",
  "update",
  "wait",
]);

/** `docker <子命令> <镜像>`。 */
const IMAGE_SUBCOMMANDS = new Set([
  "history",
  "push",
  "rmi",
  "save",
  "tag",
]);

/** `docker network <子命令>` / `docker volume <子命令>`（第一个参数才是资源名）。 */
const RESOURCE_SUBCOMMANDS: Record<string, { group: string; verbs: Set<string> }> = {
  network: {
    group: "network",
    verbs: new Set(["connect", "disconnect", "inspect", "rm"]),
  },
  volume: {
    group: "volume",
    verbs: new Set(["inspect", "rm"]),
  },
};

/** 资源列表缓存（Docker 信息短时间缓存，避免每敲一个字符跑一次 `docker ps`）。 */
const CACHE_TTL_MS = 15_000;
interface Cached {
  at: number;
  containers: string[];
  images: string[];
}
const cache = new Map<string, Cached>();

/** 切换服务器 / 容器增删后调用。 */
export function invalidateDockerCache(sessionId?: string): void {
  if (sessionId === undefined) cache.clear();
  else cache.delete(sessionId);
}

export type ResourceLister = (args: {
  sessionId: string;
  kind: "container" | "image" | "network" | "volume";
}) => Promise<string[]>;

const defaultLister: ResourceLister = async ({ sessionId, kind }) => {
  if (kind === "container" || kind === "image") {
    const snapshot = await opsApi.dockerSnapshot(sessionId);
    if (kind === "container") {
      return snapshot.containers.map((container) => container.name);
    }
    return snapshot.images
      .map((image) => image.display_name)
      .filter((name) => name && !name.startsWith("<none>"));
  }
  // 网络 / Volume 走参数补全已有的白名单取值通道（不新增命令）。
  return opsApi.commandParamValues(sessionId, "path").then(() => []);
};

let lister: ResourceLister = defaultLister;
export function setDockerLister(next: ResourceLister | null): void {
  lister = next ?? defaultLister;
}

async function listResources(sessionId: string, kind: "container" | "image"): Promise<string[]> {
  const hit = cache.get(sessionId);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) {
    return kind === "container" ? hit.containers : hit.images;
  }
  const [containers, images] = await Promise.all([
    lister({ sessionId, kind: "container" }),
    lister({ sessionId, kind: "image" }),
  ]);
  cache.set(sessionId, { at: Date.now(), containers, images });
  return kind === "container" ? containers : images;
}

/** 决定当前光标处要补哪一类资源；不归它管时返回 null。 */
export function resourceKindAt(parsed: ParsedLine): {
  kind: "container" | "image" | "network" | "volume";
  subcommand: string;
} | null {
  if (parsed.command !== "docker" || parsed.index < 2) return null;
  const group = parsed.tokens[1]?.value ?? "";
  const verb = parsed.tokens[2]?.value ?? "";

  const resource = RESOURCE_SUBCOMMANDS[group];
  if (resource && parsed.index === 3) {
    return { kind: resource.group as "network" | "volume", subcommand: verb };
  }
  if (parsed.index !== 2) return null;
  if (CONTAINER_SUBCOMMANDS.has(group)) return { kind: "container", subcommand: group };
  if (IMAGE_SUBCOMMANDS.has(group)) return { kind: "image", subcommand: group };
  return null;
}

export function createDockerResourceProvider(): CompletionProvider {
  return {
    id: "docker",
    matches(parsed: ParsedLine): boolean {
      return resourceKindAt(parsed) !== null;
    },
    async complete(ctx: CompletionContext, parsed: ParsedLine): Promise<CompletionResult> {
      const target = resourceKindAt(parsed);
      const partial = parsed.prefix;
      const requestKey = `docker:${target?.kind ?? "?"}:${target?.subcommand ?? ""}:${partial}`;
      if (!target) return { items: [], requestKey };

      let names: string[];
      try {
        names = await listResources(ctx.sessionId, target.kind === "image" ? "image" : "container");
        if (target.kind === "network" || target.kind === "volume") {
          names = await lister({ sessionId: ctx.sessionId, kind: target.kind });
        }
      } catch (cause) {
        return {
          items: [],
          notice: `读取 Docker ${labelOf(target.kind)} 列表失败：${
            cause instanceof Error ? cause.message : String(cause)
          }`,
          requestKey,
        };
      }

      const matched = names
        .filter((name) => name.startsWith(partial))
        .sort((a, b) => a.localeCompare(b));
      if (matched.length === 0) {
        return { items: [], notice: `没有匹配的 Docker ${labelOf(target.kind)}`, requestKey };
      }

      const start = ctx.cursor - partial.length;
      const items: CompletionItem[] = matched.map((name, index) => ({
        label: name,
        // 资源名可能含空格（Compose 生成的名字一般不会，但镜像引用可能有），
        // 一律走转义，绝不原样拼进命令。
        insertText: quotePathSegment(name, null, false),
        detail: labelOf(target.kind),
        icon: target.kind,
        type: target.kind,
        replaceRange: { start, end: ctx.cursor },
        priority: 100 - index,
        source: "docker",
        highlight: partial ? { start: 0, length: partial.length } : undefined,
      }));

      return { items, requestKey };
    },
  };
}

function labelOf(kind: string): string {
  switch (kind) {
    case "container":
      return "容器";
    case "image":
      return "镜像";
    case "network":
      return "网络";
    default:
      return "Volume";
  }
}
