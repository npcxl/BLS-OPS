import type { ContextUsage } from "@/api/types/agent";
import type { ExtremeMessage, ExtremeSessionContext } from "@/stores/extreme-store";

/**
 * 一条**对话**（workspace）。
 *
 * 四个标识各管一件事，混用就是串会话的根源：
 * * `serverId` —— 服务器配置（同名 / 同地址不同账号靠它区分）；
 * * `sessionId` —— 一次 SSH 连接（重连会变）；
 * * `id` —— 这条对话本身；
 * * `taskId`（在消息与任务卡上）—— 一次执行。
 *
 * 旧版本只存了 `serverKey`（服务器名 + 地址）。那种记录**无法证明**属于哪台
 * 配置，迁移后一律 `serverId = null`（未关联）：可以查看，但不会自动绑定到
 * 任意一台服务器上继续执行。
 */
export interface ExtremeWorkspace {
  id: string;
  /** 服务器配置 id；`null` = 未关联（旧记录 / 服务器已删除）。 */
  serverId: string | null;
  /** 展示名（服务器名，取不到时用地址）。 */
  server: string;
  /** 地址 / 账号，用于同名服务器消歧。 */
  host: string | null;
  /** 旧版本的兼容键 —— 只用于读旧数据，不再是身份。 */
  serverKey: string;
  sessionId: string;
  folders: string[];
  messages: ExtremeMessage[];
  /** 未发送的草稿（切走再回来要还原）。 */
  draft: string;
  /** 用户改过的标题（空 = 用第一条用户消息）。 */
  title?: string;
  /** 最近活跃时间：左栏排序与"上次那条对话"靠它。 */
  updatedAt: number;
  context?: ExtremeSessionContext;
}

const STORAGE_KEY = "bls-ops.extreme-workspaces.v2";
/** 旧版键：只读一次，用来迁移。 */
const LEGACY_KEY = "bls-ops.extreme-workspaces.v1";
/** 任务级用量（按 taskId）。单独一键：对话历史很大，不该为它反复重写。 */
const TASK_USAGE_KEY = "bls-ops.extreme-task-usage.v1";
const TASK_USAGE_LIMIT = 80;
/**
 * 每台服务器上次选中的对话。
 *
 * 单独一个键、按 **serverId** 存：它比对话本身更"轻"，不该因为某条对话内容
 * 很大而跟着重写；而且它必须独立于 sessionId —— 重连 / 改名都还要能找回来。
 */
const LAST_KEY = "bls-ops.extreme-last-workspace.v1";

/** 从旧的 `serverKey`（`[name, host]`）里拆出展示名与地址。 */
function splitServerKey(serverKey: string): { server: string; host: string | null } {
  try {
    const parsed = JSON.parse(serverKey) as unknown;
    if (Array.isArray(parsed)) {
      const server = typeof parsed[0] === "string" ? parsed[0] : "";
      const host = typeof parsed[1] === "string" && parsed[1] ? parsed[1] : null;
      return { server: server || host || "", host };
    }
  } catch {
    // 不是 JSON：当成纯名字。
  }
  return { server: serverKey, host: null };
}

function normalize(entry: Record<string, unknown>): ExtremeWorkspace | null {
  if (!entry || typeof entry.id !== "string") return null;
  const serverKey = typeof entry.serverKey === "string" ? entry.serverKey : "[]";
  const legacy = splitServerKey(serverKey);
  const messages = Array.isArray(entry.messages) ? (entry.messages as ExtremeMessage[]) : [];
  return {
    id: entry.id,
    // 旧记录没有 serverId：保留为"未关联"，绝不猜一台绑上去。
    serverId: typeof entry.serverId === "string" && entry.serverId ? entry.serverId : null,
    server: typeof entry.server === "string" && entry.server ? entry.server : legacy.server,
    host: typeof entry.host === "string" ? entry.host : legacy.host,
    serverKey,
    sessionId: typeof entry.sessionId === "string" ? entry.sessionId : "",
    folders: Array.isArray(entry.folders) ? (entry.folders as string[]) : [],
    messages,
    draft: typeof entry.draft === "string" ? entry.draft : "",
    title:
      typeof entry.title === "string" && entry.title.trim() ? entry.title.trim() : undefined,
    updatedAt: typeof entry.updatedAt === "number" ? entry.updatedAt : 0,
  };
}

export function readWorkspaces(): ExtremeWorkspace[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY) ?? localStorage.getItem(LEGACY_KEY) ?? "[]";
    const entries: unknown = JSON.parse(raw);
    if (!Array.isArray(entries)) return [];
    return entries
      .map((entry) => normalize(entry as Record<string, unknown>))
      .filter((entry): entry is ExtremeWorkspace => entry !== null);
  } catch {
    return [];
  }
}

/**
 * 写入全部对话。
 *
 * **不再吞掉错误**：配额满 / 被禁用时返回原因，由界面明确告诉用户
 * "当前能看，重开后可能没有" —— 静默失败是最难排查的一类历史丢失。
 */
export function writeWorkspaces(entries: ExtremeWorkspace[]): string | null {
  try {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify(
        entries.map((entry) => ({
          id: entry.id,
          serverId: entry.serverId,
          server: entry.server,
          host: entry.host,
          serverKey: entry.serverKey,
          sessionId: entry.sessionId,
          folders: entry.folders,
          draft: entry.draft,
          title: entry.title,
          updatedAt: entry.updatedAt,
          messages: entry.messages
            // 只有工具、没有正文的一轮（直接调用命令）也要留下来：
            // 丢掉它，重开会话后命令顺序就断了一截。
            .filter((message) => message.text || message.parts?.length)
            .map(({ tools: _tools, ...message }) => message),
        })),
      ),
    );
    return null;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return `本地缓存保存失败（${detail}）。对话会继续尝试写入本地数据库；若数据库也不可用，重启后可能丢失。`;
  }
}

/** 读任务级用量。坏数据直接忽略，不让一条脏记录拖垮整个面板。 */
export function readTaskUsage(): Record<string, ContextUsage> {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(TASK_USAGE_KEY) ?? "{}");
    if (!parsed || typeof parsed !== "object") return {};
    const out: Record<string, ContextUsage> = {};
    for (const [taskId, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (value && typeof value === "object") out[taskId] = value as ContextUsage;
    }
    return out;
  } catch {
    return {};
  }
}

export function writeTaskUsage(map: Record<string, ContextUsage>): void {
  try {
    const entries = Object.entries(map).slice(-TASK_USAGE_LIMIT);
    localStorage.setItem(TASK_USAGE_KEY, JSON.stringify(Object.fromEntries(entries)));
  } catch {
    // 用量是附加信息：写不进去不影响任务本身（历史失败由 writeWorkspaces 报）。
  }
}

export function workspaceTitle(messages: ExtremeMessage[]) {
  return messages.find((message) => message.role === "user")?.text.trim().split("\n")[0] || "";
}

/** 左栏显示什么：用户改过名就用名字，否则取第一条用户消息。 */
export function displayTitle(entry: ExtremeWorkspace, messages = entry.messages): string {
  return entry.title?.trim() || workspaceTitle(messages);
}

/** 读"每台服务器上次选中的对话"。 */
export function readLastWorkspaces(): Record<string, string> {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(LAST_KEY) ?? "{}");
    if (!parsed || typeof parsed !== "object") return {};
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value === "string" && value) out[key] = value;
    }
    return out;
  } catch {
    return {};
  }
}

export function writeLastWorkspaces(map: Record<string, string>) {
  try {
    localStorage.setItem(LAST_KEY, JSON.stringify(map));
  } catch {
    // 存不了就只保留在内存里，不影响当前会话。
  }
}

/**
 * 这台服务器最近使用的一条对话（按 `updatedAt`）。
 *
 * 上次选中的记录丢了（换机器 / 清了 localStorage / 老版本升级）时用它兜底：
 * **绝不能**因为"没有记录"就新建一条空对话。
 */
export function mostRecentForServer(
  entries: ExtremeWorkspace[],
  serverId: string | null,
): ExtremeWorkspace | undefined {
  if (!serverId) return undefined;
  return entries
    .filter((entry) => entry.serverId === serverId)
    .sort((a, b) => b.updatedAt - a.updatedAt)[0];
}

