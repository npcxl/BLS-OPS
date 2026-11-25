import { create } from "zustand";
import type { ContextUsage, FileChangeSummary } from "@/api/types/agent";
import type { DeployStep } from "@/workbench/views/terminal/extreme-core/deploy-plan";
import type { LogSource } from "@/workbench/views/terminal/extreme-core/panel-target";
import type { ExecutionReport } from "@/workbench/views/terminal/extreme-core/execution-report";
import type { PanelRequest, PanelTab } from "@/workbench/views/terminal/extreme-core/panel-target";
import type { TaskCardModel } from "@/workbench/views/terminal/extreme-core/task-view";
import {
  partsText,
  replaceTrailingText,
  type MessagePart,
} from "@/workbench/views/terminal/extreme-core/message-parts";
import {
  mostRecentForServer,
  readLastWorkspaces,
  readTaskUsage,
  readWorkspaces,
  writeLastWorkspaces,
  writeTaskUsage,
  writeWorkspaces,
  type ExtremeWorkspace,
} from "@/workbench/views/terminal/extreme-core/workspace-history";
import { loadWorkspacesFromDb, saveWorkspacesToDb } from "@/workbench/views/terminal/extreme-core/workspace-db";

/**
 * 超能模式（应用级工作台）的状态。
 *
 * 放在 store 而不是组件里，是因为它必须**跨卸载存活**：
 * - 退出超能回到终端时，工作台组件卸载，但已确认的部署任务要继续在服务器上跑；
 * - 再进来时要恢复对话、附件与日志；
 * - 切换到别的服务器时，A 的任务仍绑定 A 的会话，不能跟着界面走。
 *
 * # 四个标识
 *
 * * `serverId` —— 服务器配置（同名 / 同地址不同账号靠它区分）；
 * * `sessionId` —— 一次 SSH 连接（重连会变，不能当身份）；
 * * `workspaceId` —— 一条对话（左栏一项）；
 * * `taskId` —— 一次执行（消息与任务卡上的）。
 *
 * 所有异步回写都按 `workspaceId` 落库：后台任务可以更新**它自己那条**对话，
 * 但绝不能因为"当前显示的是 B"就把 A 的结果写进 B。
 */

/**
 * 随一条消息发出的附件**快照**。
 *
 * 发送那一刻定下来的一小份元信息：附件之后被移除、切到别的服务器、甚至重开
 * 应用，气泡上显示的仍是"当时发出去的那个文件"。正文不进来 —— 这里只用来
 * 展示与拼请求清单，模型要读内容自己按路径读。
 */
export interface SentAttachment {
  id: string;
  name: string;
  size: number;
  /** 服务器展示名：跨会话回看时知道这个文件属于哪台机器。 */
  server?: string | null;
  /** 服务器上的绝对路径（远程文件一定有）。 */
  remotePath?: string;
  /** 拖入文件夹时的相对路径。 */
  path?: string;
  /** 当时的读取结果：没有正文也能凭路径让工具读。 */
  read?: "text" | "binary" | "failed" | "pending";
}

export interface ExtremeMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  /**
   * 消息产生的时刻（毫秒）。由 push 入口统一补默认值，调用方不必逐个传。
   * 旧记录没有这个字段：界面不显示时间，绝不拿"现在"冒充历史时刻。
   */
  createdAt?: number;
  /** 真实模型名（本机提示没有）。 */
  model?: string;
  /**
   * 这条回复背后**实际执行过**的只读检查。
   *
   * 有记录才说明"查过"；空数组表示模型没调工具 —— 界面据此区分"结论有证据"
   * 与"纯属推测"。
   */
  tools?: {
    tool: string;
    args: Record<string, unknown>;
    command: string;
    exitCode: number | null;
    output: string;
    truncated: boolean;
    elapsedMs: number;
  }[];
  /** 本机生成的事实性提示，不伪装成模型回答。 */
  local?: boolean;
  /** 这条消息发起的任务：卡片渲染在消息下面，与历史共用同一个 taskId。 */
  taskId?: string;
  /**
   * 这一轮里**正文与工具步骤的真实顺序**（见 `message-parts.ts`）。
   *
   * 有它时按片段依次渲染：正文 → 命令 → 正文 → 命令 → 结论；没有它的旧记录
   * 仍按原来的"任务卡整块折叠"呈现。`text` 始终等于所有正文片段之和。
   */
  parts?: MessagePart[];
  /**
   * 这一轮是否强制先提交计划（用户选了 MAX）。
   *
   * 与 `effort` 分开记：供应商最高档可能只是 high，但重开 / 继续执行时仍要
   * 保持同一份门控。
   */
  planRequired?: boolean;
  /** 发起时用户实际选的强度（含 `max`）。 */
  effort?: string;
  /**
   * 重试时给模型的补充说明（不落库、不进气泡）。
   *
   * 只在这一轮请求的副本上带：告诉模型上次停在哪一步、先核对远端状态再继续。
   */
  retryNote?: string;
  /**
   * 平台执行结果（上传 / 计划 / 执行）回传给模型的回执。
   *
   * 只在这一轮请求的副本上带：它**不是**用户说的话，所以不能 push 成气泡、
   * 不能清草稿、也不能改会话标题 —— 界面上的呈现走 `reports`（执行结果）。
   */
  toolReport?: string;
  /**
   * 随这条消息一起发出的附件 id。
   *
   * 附件本体仍留在会话的 `attachments` 里（模型上下文、部署计划、右栏树都要
   * 用），这里只做"归属"：发出去之后就从输入区消失，改在气泡上显示。
   */
  attachmentIds?: string[];
  /**
   * 发出时的附件快照（与 `attachmentIds` 一一对应）。
   *
   * 气泡与请求都优先用它：附件后来被移除、或换到别的服务器回看历史，
   * 仍能显示"这条消息带了哪个文件、在服务器哪条路径"。
   */
  attachmentSnapshot?: SentAttachment[];
  /**
   * 这一轮没有正常跑完。
   *
   * `failed` / `startup` 保留用户已经看到的正文并给重试入口；`cancelled`
   * 是用户主动停止，同样保留正文但不当作错误。
   */
  interrupted?: "failed" | "cancelled" | "startup" | null;
  /** 中断原因（展示用；`cancelled` 时通常为空）。 */
  interruptReason?: string | null;
  /**
   * 用户消息没有送到后端（补充指令 / 重发失败）。
   *
   * 正文仍留在气泡里，旁边给出重发入口 —— 静默丢弃比报错更糟。
   */
  deliveryError?: string | null;
}

export interface ExtremeAttachment {
  id: string;
  name: string;
  size: number;
  /** 拖入文件夹时的相对路径（`web/src/index.js`）；单文件为空。 */
  path?: string;
  state: "pending" | "ready" | "failed";
  error?: string;
  /** 文本文件内容（供模型阅读）。 */
  text?: string;
  /** 二进制文件的 base64 内容（只用于上传，不发给模型）。 */
  data?: string;
  /** 是否为二进制（模型只看到元信息）。 */
  binary?: boolean;
  /** 已写到服务器临时目录后的绝对路径（AI 与部署计划引用它）。 */
  remotePath?: string;
  /**
   * 这个附件走到哪一步了。
   *
   * * `local` —— 只在本机读过（拖进来就有）；
   * * `uploading` —— 正在写服务器临时目录；
   * * `uploaded` —— 已落在临时目录，**部署时可以直接 `cp`，不必重传**；
   * * `deployed` —— 已经被某个部署步骤复制到目标目录。
   *
   * 和 `state`（读取状态）分开：读取成功不代表传上去了，传上去也不代表部署过。
   */
  uploadState?: "local" | "uploading" | "uploaded" | "deployed";
  /** 写服务器失败的原因（本机读取成功但上传失败时保留）。 */
  remoteError?: string;
}

/**
 * 右栏展示什么：默认收起。
 *
 * `panel` 是「服务器命令面板」（远程文件 / 实时日志 / 命令输出）。
 */
export type ExtremeRightTab = "preflight" | "steps" | "logs" | "panel";

/**
 * 右栏（会话工作区）的四个**固定**标签。
 *
 * 和以前那套"远程文件 / Inspector / 服务器面板 互斥"不同：右栏永远只有这一
 * 个工作区，标签位置固定，切标签只换内容，不再出现"打开面板就换了一整套入口"。
 */
/**
 * 右栏标签。
 *
 * 原来只有四个固定标签；现在按浏览器式工作区管理：日志与内置浏览器也是独立
 * 标签，标签可以关闭（最后一个关闭时收起右栏）。
 */
export type WorkspacePane =
  | "files"
  | "terminal"
  | "logs"
  | "attachments"
  | "plan"
  | "changes"
  | "browser";

import type {
  ContextMode,
  OutputStyle,
  PickedContext,
} from "@/workbench/views/terminal/extreme-core/chat-context";
import type { EffortChoice } from "@/workbench/views/terminal/extreme-core/model-choice";
import { useExtremeSettingsStore } from "@/stores/extreme-settings-store";
import {
  clearSendError,
  enqueueSend,
  forgetSends,
  markSendError,
  moveSendUp,
  removeSend,
  type QueuedSend,
} from "@/workbench/views/terminal/extreme-core/send-queue";

/** 右栏的三种形态：收起 / 分栏 / 占满内容区（类似 Codex 的展开视图）。 */
export type WorkspacePaneView = "hidden" | "split" | "expanded";

/** 「终端」标签内部的三段：执行输出 / 实时日志 / 手动终端。 */
/**
 * 「终端」标签内部的两段：执行输出（AI 步骤结果）与真实终端（PTY）。
 *
 * 原来的「实时日志」已去掉：日志监听改在真实终端里跑，`tail -F` 能一直
 * 留在屏幕上，也能被 AI 读取最近输出。
 */
export type TerminalPane = "output" | "manual";

const PANE_KEY = "bls-ops.extreme-pane.v1";
const PANE_VIEW_KEY = "bls-ops.extreme-pane-view.v1";
/** 每条对话自己的右栏开合；新任务默认值只写进新条目。 */
const PANE_VIEWS_KEY = "bls-ops.extreme-pane-views.v1";
const CHAT_PREFS_KEY = "bls-ops.extreme-chat-prefs.v1";
const MODEL_SETTINGS_KEY = "bls-ops.extreme-model-settings.v1";
/** 按会话覆盖的模型档位 / 预算；没有条目时沿用上面的模型默认值。 */
const MODEL_OVERRIDES_KEY = "bls-ops.extreme-model-overrides.v1";

/** 一条会话的输入偏好：上下文范围、输出形态、勾选的材料。 */
export interface ChatPrefs {
  context: ContextMode;
  output: OutputStyle;
  picked: PickedContext[];
  /** 选中的模型（provider id）；`null` = 用默认提供方。 */
  providerId: string | null;
  /** false = 跟随超能模式默认值（设置页改默认时同步跟着变）。 */
  contextCustom?: boolean;
  outputCustom?: boolean;
}

export const DEFAULT_CHAT_PREFS: ChatPrefs = {
  context: "session",
  output: "auto",
  picked: [],
  providerId: null,
  contextCustom: false,
  outputCustom: false,
};

/** 新任务 / 未单独设置过的会话：从超能模式默认值生成。 */
export function defaultChatPrefs(): ChatPrefs {
  const settings = useExtremeSettingsStore.getState();
  return {
    context: settings.defaultContext,
    output: settings.defaultOutput,
    picked: [],
    providerId: null,
    contextCustom: false,
    outputCustom: false,
  };
}

function normalizePrefs(value: unknown): ChatPrefs {
  const raw = (value ?? {}) as {
    context?: unknown;
    output?: unknown;
    picked?: unknown;
    providerId?: unknown;
    contextCustom?: unknown;
    outputCustom?: unknown;
  };
  const context =
    raw.context === "only" || raw.context === "picked" ? raw.context : ("session" as const);
  const output =
    raw.output === "brief" || raw.output === "detailed" || raw.output === "structured"
      ? raw.output
      : ("auto" as const);
  const picked = Array.isArray(raw.picked)
    ? (raw.picked as PickedContext[]).filter(
      (item) =>
        item &&
        typeof item.id === "string" &&
        typeof item.label === "string" &&
        (item.kind === "attachment" ||
          item.kind === "path" ||
          item.kind === "output" ||
          item.kind === "step"),
    )
    : [];
  const providerId =
    typeof raw.providerId === "string" && raw.providerId ? raw.providerId : null;
  // 旧记录没有标志：当时的值就是用户显式选的，按“自定义”保留。
  const contextCustom = raw.contextCustom === false ? false : true;
  const outputCustom = raw.outputCustom === false ? false : true;
  return { context, output, picked, providerId, contextCustom, outputCustom };
}

function readChatPrefs(): Record<string, ChatPrefs> {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(CHAT_PREFS_KEY) ?? "{}");
    if (!parsed || typeof parsed !== "object") return {};
    const out: Record<string, ChatPrefs> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      out[key] = normalizePrefs(value);
    }
    return out;
  } catch {
    return {};
  }
}

function writeChatPrefs(map: Record<string, ChatPrefs>) {
  try {
    localStorage.setItem(CHAT_PREFS_KEY, JSON.stringify(map));
  } catch {
    // 存不了就只在内存里生效。
  }
}

/** 一个模型的设置：思考强度 + 上下文预算。 */
export interface ModelSetting {
  /** 思考强度；`auto` = 供应商默认值。 */
  effort: EffortChoice;
  /** 上下文输入预算（tokens）；`null` = 自动。 */
  budget: number | null;
}

export const DEFAULT_MODEL_SETTING: ModelSetting = { effort: "auto", budget: null };

function normalizeModelSetting(value: unknown): ModelSetting {
  const raw = (value ?? {}) as { effort?: unknown; budget?: unknown };
  const effort =
    raw.effort === "low" ||
      raw.effort === "medium" ||
      raw.effort === "high" ||
      raw.effort === "max"
      ? raw.effort
      : ("auto" as const);
  const budget =
    typeof raw.budget === "number" && Number.isFinite(raw.budget) && raw.budget >= 16 * 1024
      ? Math.round(raw.budget)
      : null;
  return { effort, budget };
}

/**
 * 设置**按模型**记住：同一台服务器换模型后回来，沿用这个模型上次的档位。
 * 与 `ChatPrefs` 分开存，因为模型设置跨会话有效。
 */
function readModelSettings(): Record<string, ModelSetting> {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(MODEL_SETTINGS_KEY) ?? "{}");
    if (!parsed || typeof parsed !== "object") return {};
    const out: Record<string, ModelSetting> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      out[key] = normalizeModelSetting(value);
    }
    return out;
  } catch {
    return {};
  }
}

function writeModelSettings(map: Record<string, ModelSetting>) {
  try {
    localStorage.setItem(MODEL_SETTINGS_KEY, JSON.stringify(map));
  } catch {
    // 存不了就只在内存里生效。
  }
}

function readModelOverrides(): Record<string, Record<string, ModelSetting>> {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(MODEL_OVERRIDES_KEY) ?? "{}");
    if (!parsed || typeof parsed !== "object") return {};
    const out: Record<string, Record<string, ModelSetting>> = {};
    for (const [workspace, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (!value || typeof value !== "object") continue;
      const perModel: Record<string, ModelSetting> = {};
      for (const [key, setting] of Object.entries(value as Record<string, unknown>)) {
        perModel[key] = normalizeModelSetting(setting);
      }
      out[workspace] = perModel;
    }
    return out;
  } catch {
    return {};
  }
}

function writeModelOverrides(map: Record<string, Record<string, ModelSetting>>) {
  try {
    localStorage.setItem(MODEL_OVERRIDES_KEY, JSON.stringify(map));
  } catch {
    // 存不了就只在内存里生效。
  }
}

/** 当前会话实际使用的模型档位：会话覆盖 > 模型默认 > 内置默认。 */
export function effectiveModelSetting(
  state: Pick<ExtremeState, "workspaceId" | "modelSettings" | "modelSettingsByWorkspace">,
  key: string,
): ModelSetting {
  const override = state.workspaceId
    ? state.modelSettingsByWorkspace[state.workspaceId]?.[key]
    : undefined;
  if (override) return override;
  if (state.modelSettings[key]) return state.modelSettings[key];
  const settings = useExtremeSettingsStore.getState();
  return { effort: settings.defaultEffort, budget: settings.defaultBudget };
}

/** 把当前会话覆盖与模型默认合并成 Composer 用的 map。 */
export function mergedModelSettings(
  state: Pick<ExtremeState, "workspaceId" | "modelSettings" | "modelSettingsByWorkspace">,
): Record<string, ModelSetting> {
  const override = state.workspaceId
    ? state.modelSettingsByWorkspace[state.workspaceId] ?? {}
    : {};
  return { ...state.modelSettings, ...override };
}

const PANE_KINDS: WorkspacePane[] = [
  "files",
  "terminal",
  "logs",
  "attachments",
  "plan",
  "changes",
  "browser",
];

function isPane(value: unknown): value is WorkspacePane {
  return PANE_KINDS.includes(value as WorkspacePane);
}

interface PaneState {
  /** 每条对话当前选中的标签。 */
  active: Record<string, WorkspacePane>;
  /** 每条对话**已打开**的标签（顺序即标签顺序）。 */
  lists: Record<string, WorkspacePane[]>;
  /** 最近使用顺序：关闭当前标签后切到最近用过的那一个。 */
  mru: Record<string, WorkspacePane[]>;
  /** 每条对话的浏览器地址。 */
  browser: Record<string, string>;
  /** 每条对话上次看的日志来源（关掉标签再打开时接着看）。 */
  logs: Record<string, LogSource>;
  width: number;
}

function readPaneState(): PaneState {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(PANE_KEY) ?? "{}");
    const value = (parsed ?? {}) as {
      tabs?: unknown;
      lists?: unknown;
      mru?: unknown;
      browser?: unknown;
      logs?: unknown;
      width?: unknown;
    };
    const active: Record<string, WorkspacePane> = {};
    if (value.tabs && typeof value.tabs === "object") {
      for (const [key, tab] of Object.entries(value.tabs as Record<string, unknown>)) {
        if (isPane(tab)) active[key] = tab;
      }
    }
    const lists: Record<string, WorkspacePane[]> = {};
    if (value.lists && typeof value.lists === "object") {
      for (const [key, list] of Object.entries(value.lists as Record<string, unknown>)) {
        if (!Array.isArray(list)) continue;
        const panes = [...new Set(list.filter(isPane))];
        if (panes.length > 0) lists[key] = panes;
      }
    }
    const mru: Record<string, WorkspacePane[]> = {};
    if (value.mru && typeof value.mru === "object") {
      for (const [key, list] of Object.entries(value.mru as Record<string, unknown>)) {
        if (!Array.isArray(list)) continue;
        const panes = [...new Set(list.filter(isPane))];
        if (panes.length > 0) mru[key] = panes;
      }
    }
    const browser: Record<string, string> = {};
    if (value.browser && typeof value.browser === "object") {
      for (const [key, url] of Object.entries(value.browser as Record<string, unknown>)) {
        if (typeof url === "string" && /^https?:\/\//i.test(url)) browser[key] = url;
      }
    }
    const logs: Record<string, LogSource> = {};
    if (value.logs && typeof value.logs === "object") {
      for (const [key, source] of Object.entries(value.logs as Record<string, unknown>)) {
        if (source && typeof source === "object") logs[key] = source as LogSource;
      }
    }
    // 旧版本只存了"当前标签"：迁移成"已打开列表 + 当前标签"。
    for (const [key, tab] of Object.entries(active)) {
      if (!lists[key]) lists[key] = [tab];
      if (!mru[key]) mru[key] = [tab];
    }
    return {
      active,
      lists,
      mru,
      browser,
      logs,
      width: typeof value.width === "number" ? value.width : 360,
    };
  } catch {
    return { active: {}, lists: {}, mru: {}, browser: {}, logs: {}, width: 360 };
  }
}

function writePaneState(state: PaneState) {
  try {
    localStorage.setItem(
      PANE_KEY,
      JSON.stringify({
        tabs: state.active,
        lists: state.lists,
        mru: state.mru,
        browser: state.browser,
        logs: state.logs,
        width: state.width,
      }),
    );
  } catch {
    // 存不了就只在内存里生效。
  }
}

/* ---------------- 文件变更面板的阅读状态 ---------------- */

/**
 * 一次运行（或"待确认"）里的阅读状态。
 *
 * **按对话 + 变更批次**分开记：A 的对话看着 nginx 配置、B 的对话看着另一个文件，
 * 来回切换时筛选、打开的文件和滚动位置都必须各自回到原处。
 */
export interface ChangeViewState {
  /** `pending` = 待确认的变更；`run` = 某一次运行。 */
  mode: "pending" | "run";
  /** `run` 模式下选中的运行（taskId）；空 = 最新一次。 */
  taskId?: string;
  /** 选中的文件（changeId）。 */
  changeId?: string;
  /** 路径筛选。 */
  filter: string;
  /** 展开的未修改段（`${changeId}:${hunkIndex}`）。 */
  expanded: string[];
  scrollTop: number;
}

export const EMPTY_CHANGE_VIEW: ChangeViewState = {
  mode: "run",
  filter: "",
  expanded: [],
  scrollTop: 0,
};

const CHANGE_VIEW_KEY = "bls-ops.extreme-change-view.v1";

function readChangeViews(): Record<string, ChangeViewState> {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(CHANGE_VIEW_KEY) ?? "{}");
    if (!parsed || typeof parsed !== "object") return {};
    const out: Record<string, ChangeViewState> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      const raw = (value ?? {}) as Partial<ChangeViewState>;
      out[key] = {
        mode: raw.mode === "pending" ? "pending" : "run",
        taskId: typeof raw.taskId === "string" && raw.taskId ? raw.taskId : undefined,
        changeId: typeof raw.changeId === "string" && raw.changeId ? raw.changeId : undefined,
        filter: typeof raw.filter === "string" ? raw.filter : "",
        expanded: Array.isArray(raw.expanded)
          ? raw.expanded.filter((item): item is string => typeof item === "string")
          : [],
        scrollTop:
          typeof raw.scrollTop === "number" && Number.isFinite(raw.scrollTop)
            ? Math.max(0, raw.scrollTop)
            : 0,
      };
    }
    return out;
  } catch {
    return {};
  }
}

function writeChangeViews(map: Record<string, ChangeViewState>) {
  try {
    localStorage.setItem(CHANGE_VIEW_KEY, JSON.stringify(map));
  } catch {
    // 存不了就只在本次会话里生效。
  }
}

/**
 * 一条对话的**可持久上下文字段**。
 *
 * 注意不含 `messages` / `draft`：那两项单独存在 workspace 上，避免两份真相。
 */
export interface ExtremeSessionContext {
  messages: ExtremeMessage[];
  attachments: ExtremeAttachment[];
  plan: DeployStep[] | null;
  planSession: string | null;
  planTaskId: string | null;
  notice: string | null;
  model: string | null;
  executing: boolean;
}

const emptyContext = (): ExtremeSessionContext => ({
  messages: [],
  attachments: [],
  plan: null,
  planSession: null,
  planTaskId: null,
  notice: null,
  model: null,
  executing: false,
});

interface ExtremeState {
  active: boolean;
  /** 当前服务器配置 id（`null` = 这条对话未关联任何服务器）。 */
  serverId: string | null;
  /** 进入超能时绑定的服务器展示名。 */
  server: string | null;
  serverHost: string | null;
  /**
   * 当前绑定的 SSH 会话。
   *
   * `null` = 这条对话所属服务器现在**没有可用连接**：可以看历史，不能执行。
   */
  sessionId: string | null;

  /**
   * 每台服务器最近一次已知连接。
   *
   * 跨服务器打开一条旧对话时据此判断"能不能接着执行"：查不到就是未连接。
   * 重连会更新它，断开会删掉它。
   */
  connections: Record<string, { sessionId: string; host: string | null }>;
  /** 每台服务器上一次活跃的对话：重连 / 再次进入时恢复它。 */
  lastWorkspaceByServer: Record<string, string>;

  /**
   * 任务级用量（按 taskId，全局一份）。
   *
   * taskId 本身唯一，所以不必按会话再分一层；切会话 / 重进时按当前任务的
   * taskId 取回来，任务结束后保留最终值。
   */
  taskUsage: Record<string, ContextUsage>;
  setTaskUsage: (taskId: string, usage: ContextUsage | null | undefined) => void;
  /** 本地历史保存失败的原因（配额满 / 被禁用）；null = 正常。 */
  historyError: string | null;
  dismissHistoryError: () => void;
  /** 后台对话有新结果未读：左栏只画一个小圆点。 */
  unread: Record<string, boolean>;
  clearUnread: (workspaceId: string) => void;

  /**
   * 「完成后发送」的**对话队列**。
   *
   * 按 `workspaceId` 分桶、FIFO；每项入队时已锁定文字 / 附件 / 模型 / 范围。
   * 只放内存：它表示"马上要发"，应用重启后旧意图已经失效，恢复反而更危险。
   */
  queuedSends: QueuedSend[];
  /** 入队（同一对话连续排队时保持提交顺序）。 */
  queueSend: (item: QueuedSend) => void;
  /** 派发成功后出队。 */
  dropSend: (id: string) => void;
  /** 队列项上移一位（只在本对话内调整顺序）。 */
  moveSendUp: (id: string) => void;
  /** 断连 / 发送失败：保留队列项并标明原因。 */
  failSend: (id: string, reason: string) => void;
  /** 清掉错误，允许重新派发。 */
  retrySend: (id: string) => void;

  /**
   * 覆盖**指定对话**的上下文字段（后台动作回写用）。
   *
   * 计划 / 执行标记都是"当前镜像"，前台切走时它们属于原来那条对话：
   * 直接写镜像会把 A 的计划落到 B 上。
   */
  patchWorkspaceContext: (
    workspaceId: string,
    patch: Partial<ExtremeSessionContext>,
  ) => void;

  workspaces: ExtremeWorkspace[];
  workspaceId: string | null;
  /** 当前对话的草稿（切走时留在 workspace 上，切回来还原）。 */
  draft: string;
  openWorkspace: (id: string) => void;
  addWorkspace: (folders: string[], attachments?: ExtremeAttachment[]) => void;
  /** 往当前任务里追加文件夹（欢迎页的"选择本机文件夹"，不新建任务）。 */
  addFolders: (folders: string[]) => void;

  /** 下面是**当前会话**的镜像，供组件直接读写。 */
  messages: ExtremeMessage[];
  attachments: ExtremeAttachment[];
  plan: DeployStep[] | null;
  /** 生成计划时的会话（执行前校验，防跨机误发）。 */
  planSession: string | null;
  planTaskId: string | null;
  notice: string | null;
  /** 实际使用的模型名。 */
  model: string | null;
  /** 任务条（计划）是否展开。 */
  panelOpen: boolean;
  rightTab: ExtremeRightTab | null;
  /**
   * 服务器命令面板的当前标签与目标。
   *
   * 与 `rightTab` 分开：`rightTab` 决定"右栏显示哪一块"，这里决定
   * "面板里开的是哪个标签、看哪个资源"。隐藏面板**不清空**它 —— 再次打开
   * 要恢复到上次选中的标签（实时日志也继续在后台监听）。
   */
  panelTab: PanelTab;
  panelTarget: PanelRequest | null;
  /** 面板是否展开（`rightTab === "panel"` 时的显隐）。 */
  panelShown: boolean;
  /** 打开面板并切到某个标签；不传 target 时保留上次的资源。 */
  openPanel: (request: PanelRequest) => void;
  /** 只切换标签，不动资源与监听。 */
  setPanelTab: (tab: PanelTab) => void;
  /** 显示 / 隐藏（隐藏不停止日志流）。 */
  setPanelShown: (shown: boolean) => void;

  /** 统一右栏：当前会话选中的标签。 */
  paneTab: WorkspacePane;
  /** 每个会话各自记住的标签。 */
  paneByWorkspace: Record<string, WorkspacePane>;
  /** 每条会话**已打开**的标签（浏览器式，可关闭）。 */
  paneLists: Record<string, WorkspacePane[]>;
  /** 最近使用顺序（关闭当前标签后切到这里面的第一个）。 */
  paneMru: Record<string, WorkspacePane[]>;
  /** 每条会话的内置浏览器地址（按 workspaceId 恢复）。 */
  browserByWorkspace: Record<string, string>;
  /** 每条会话日志标签上次看的来源。 */
  logSourceByWorkspace: Record<string, LogSource>;
  /** 每条会话远程文件面板最后停留的目录。 */
  remotePathByWorkspace: Record<string, string>;
  setRemotePath: (workspaceId: string, path: string) => void;
  /**
   * 文件变更摘要（按 changeId）。
   *
   * 事件与 `agent_file_changes` 查询都写这里；Diff 正文按需取，**不放进 store**，
   * 否则一次任务能往内存里塞好几个完整文件。
   */
  fileChanges: Record<string, FileChangeSummary>;
  mergeFileChange: (change: FileChangeSummary) => void;
  mergeFileChanges: (changes: FileChangeSummary[]) => void;
  /** 变更面板的阅读状态：按 `${workspaceId}:${taskId || "pending"}` 分开记。 */
  changeViews: Record<string, ChangeViewState>;
  /** `persist: false` 用于滚动这种高频更新（松手 / 卸载时再落盘）。 */
  setChangeView: (
    key: string,
    patch: Partial<ChangeViewState>,
    options?: { persist?: boolean },
  ) => void;
  /** 立刻把阅读状态落盘（滚动结束时用）。 */
  flushChangeViews: () => void;
  /** 关掉一个标签；最后一个关掉时收起右栏。 */
  closePane: (tab: WorkspacePane) => void;
  /** 记下某条会话的浏览器地址。 */
  setBrowserUrl: (workspaceId: string, url: string) => void;
  /** 记下某条会话日志标签的来源。 */
  setLogSource: (workspaceId: string, source: LogSource) => void;
  /** 收起 / 分栏 / 展开视图。 */
  paneView: WorkspacePaneView;
  /** 每条对话自己的右栏开合；切换时恢复，不互相覆盖。 */
  paneViewByWorkspace: Record<string, WorkspacePaneView>;
  /** 分栏宽度（拖动分隔线后记住）。 */
  paneWidth: number;
  /** 正在拖右栏（内拖 / 外扩）：浏览器子视图要临时隐藏。 */
  paneDragging: boolean;
  setPaneDragging: (dragging: boolean) => void;
  /** 「终端」标签内部选中的一段。 */
  terminalPane: TerminalPane;
  /** 每条会话各自记住的终端子标签（执行输出 / 实时日志 / 手动终端）。 */
  terminalPaneByWorkspace: Record<string, TerminalPane>;
  /**
   * 切到某个标签**并展开右栏**：有内容要给人看时统一走它。
   *
   * 只 `setPaneTab` 不会把收起的右栏打开 —— 附件、AI 打开文件、上传完成这些
   * 场景必须同时展开，否则用户看到的是"操作生效了，但界面上什么都没有"。
   * 已经展开（含占满视图）时保持原形态，不把展开视图缩回分栏。
   */
  openPane: (tab: WorkspacePane, terminal?: TerminalPane) => void;
  setPaneTab: (tab: WorkspacePane) => void;
  setPaneView: (view: WorkspacePaneView) => void;
  /**
   * 右栏宽度。
   *
   * `persist: false` 只改内存里的宽度（拖动中的中间帧），松手时才写 localStorage
   * —— 以前每次 `pointermove` 都序列化一遍面板状态。
   */
  setPaneWidth: (width: number, options?: { persist?: boolean }) => void;
  setTerminalPane: (tab: TerminalPane) => void;

  /** 输入框底栏：当前会话的上下文范围 / 输出形态 / 勾选材料。 */
  chatPrefs: ChatPrefs;
  /** 每条会话各自记住一份。 */
  chatPrefsByWorkspace: Record<string, ChatPrefs>;
  setContextMode: (mode: ContextMode) => void;
  setOutputStyle: (style: OutputStyle) => void;
  /** 当前会话把某一项恢复成“跟随默认”。 */
  resetChatPreference: (field: "context" | "output") => void;
  /** 设置页改默认值后，让所有“跟随默认”的会话同步到新默认。 */
  applyDefaultChatPrefs: () => void;
  /** 加入一份/多份自选材料（同 id 去重）。 */
  addPicked: (items: PickedContext[]) => void;
  removePicked: (id: string) => void;
  clearPicked: () => void;
  /** 选模型：`null` = 默认提供方。下一条消息生效。 */
  setProviderId: (id: string | null) => void;
  /** 按模型记住的思考强度与上下文预算（跨会话默认值，key 见 `modelKey`）。 */
  modelSettings: Record<string, ModelSetting>;
  /** 当前会话对某个模型的覆盖（「自定义」）；没有条目 = 跟随模型默认。 */
  modelSettingsByWorkspace: Record<string, Record<string, ModelSetting>>;
  /** 会话内的选择：写会话覆盖。 */
  setModelSetting: (key: string, patch: Partial<ModelSetting>) => void;
  /** 设置页改“模型默认值”：只影响没有会话覆盖的会话。 */
  setDefaultModelSetting: (key: string, patch: Partial<ModelSetting>) => void;
  /** 当前会话恢复某个模型的默认档位。 */
  resetModelSetting: (key: string) => void;
  /**
   * 是否正在执行任务。
   *
   * **必须在 store 里**：执行循环跑在组件之外（async 函数不受卸载影响），
   * 退出超能再进来若读不到这个标记，就会允许"再点一次确认执行"，把
   * `docker compose up` 跑两遍。
   */
  executing: boolean;
  /** 桌面通知点开后要定位的任务；聊天区消费一次后清空。 */
  focusTaskId: string | null;
  setFocusTaskId: (taskId: string | null) => void;

  /**
   * 任务卡（按 taskId）。与 `plan` 的区别：`plan` 只是"当前这一版计划"，
   * 这里是**可渲染的卡片模型** —— 执行中的、已完成的、从历史打开的都走它，
   * 所以切服务器 / 收起面板后卡片内容不会丢。
   */
  tasks: Record<string, TaskCardModel>;
  /**
   * 每个任务的**递增版本**（任务卡是唯一写入方，历史/详情只读合并）。
   *
   * 事件可能乱序：`mergeTask` 只接受比已知版本更新的事件，所以"完成"不会被
   * 迟到的"执行中"覆盖回退。
   */
  taskVersions: Record<string, number>;
  /**
   * 平台执行结果（按 taskId）。
   *
   * 上传 / 生成计划 / 执行这些"平台替用户做的事"，结果挂在**发起它的那条
   * 任务**下面，而不是再往对话里插一条气泡。
   */
  reports: Record<string, ExecutionReport[]>;

  /**
   * 进入超能：`serverId` 是服务器配置，`sessionId` 是这次连接。
   *
   * * 同一台服务器（含重连）→ 恢复它上次那条对话，只换绑连接；
   * * 换到另一台 → 开一条**新的空白对话**（A 的对话与后台任务原样保留）。
   */
  enter: (
    serverId: string,
    server: string,
    sessionId: string,
    serverHost?: string | null,
  ) => void;
  /** 收起：回终端，对话 / 附件 / 任务全部保留。 */
  exit: () => void;
  /** 关闭：收起并**清空当前对话**的对话与附件（任务执行中只收起）。 */
  close: () => void;
  /** 连接断开：这台服务器进入"未连接"，正在看的对话随之只读。 */
  markDisconnected: (serverId: string) => void;

  pushMessage: (message: ExtremeMessage) => void;
  /** 往**指定对话**追加消息（后台任务回写用；不影响当前界面）。 */
  pushMessageTo: (workspaceId: string, message: ExtremeMessage) => void;
  setMessages: (messages: ExtremeMessage[]) => void;
  /** 流式增量：把一段新文字追加到指定消息末尾。 */
  appendToMessage: (id: string, delta: string) => void;
  /** 覆盖消息字段（流式结束用完整内容兜底，防止丢块）。 */
  patchMessage: (id: string, patch: Partial<ExtremeMessage>) => void;
  /** 覆盖**指定对话**里的消息字段（后台任务回写用）。 */
  patchMessageIn: (workspaceId: string, id: string, patch: Partial<ExtremeMessage>) => void;
  removeMessage: (id: string) => void;
  removeMessageIn: (workspaceId: string, id: string) => void;
  setAttachments: (updater: (current: ExtremeAttachment[]) => ExtremeAttachment[]) => void;
  /**
   * 覆盖**指定对话**的附件（异步回写用）。
   *
   * 远程文件的正文要等网络回来，中途切到别的服务器时镜像已经换人 ——
   * 直接写 `setAttachments` 会把 A 的文件塞进 B。
   */
  setAttachmentsIn: (
    workspaceId: string,
    updater: (current: ExtremeAttachment[]) => ExtremeAttachment[],
  ) => void;
  setPlan: (plan: DeployStep[] | null) => void;
  setPlanSession: (sessionId: string | null) => void;
  updatePlan: (updater: (current: DeployStep[]) => DeployStep[]) => void;
  setNotice: (notice: string | null) => void;
  setModel: (model: string | null) => void;
  setPanelOpen: (open: boolean) => void;
  setRightTab: (tab: ExtremeRightTab | null) => void;
  setExecuting: (executing: boolean) => void;
  /** 草稿：同时写镜像与当前 workspace（切走再回来要还原）。 */
  setDraftText: (draft: string) => void;
  /**
   * 按**对话**写执行标记。
   *
   * 任务可能跑在中途切走的对话上：结束时必须清掉它自己那条的标记，而不是
   * 清掉当前界面这条（那会把另一条永远停在"执行中"，也把这一条的按钮锁死）。
   */
  setExecutingFor: (workspaceId: string, executing: boolean) => void;
  /**
   * 保证当前有一条对话。
   *
   * 欢迎态（刚进入一台没有任何历史的服务器）不预先建记录：第一条消息发出时
   * 才落一条，避免"打开一次就多一条空对话"。
   */
  ensureWorkspace: () => string | null;
  /** 改标题（空串 = 恢复用第一条用户消息显示）。立即持久化。 */
  renameWorkspace: (id: string, title: string) => void;
  /**
   * 删除一条对话。
   *
   * 删的是**记录**，不是任务：正在跑的任务由调用方先拦下（提示用户处理）。
   * 删掉当前这条后打开同服务器最近的一条；一条都不剩就回到欢迎态。
   */
  removeWorkspace: (id: string) => void;
  /** 新建 / 覆盖一张任务卡（版本 +1）。 */
  upsertTask: (task: TaskCardModel) => void;
  /** 写一条执行结果：同一个 `report.id` 只保留一行（重复执行是更新，不是追加）。 */
  upsertReport: (taskId: string, report: ExecutionReport) => void;
  /** 接收外部更新（历史快照 / 事件）：版本不新就丢弃。 */
  mergeTask: (task: TaskCardModel, version: number) => void;
  /** 只更新变化字段（执行中逐步刷新用，避免整个卡片重建）。 */
  patchTask: (id: string, patch: Partial<TaskCardModel>) => void;
}

/** 把当前镜像收成一份上下文快照。 */
function snapshot(state: ExtremeState): ExtremeSessionContext {
  return {
    messages: state.messages,
    attachments: state.attachments,
    plan: state.plan,
    planSession: state.planSession,
    planTaskId: state.planTaskId,
    notice: state.notice,
    model: state.model,
    executing: state.executing,
  };
}

/**
 * 当前对话的消息镜像变了 → 同步写回 `workspaces` 里对应的那条。
 *
 * 左栏的摘要与排序读的是 `workspaces`，而流式/发送只改 `messages`；
 * 不同步就会出现"聊天里已有新消息，悬停摘要和时间还停在旧状态"。
 * 只动当前这一条，后台任务仍由 `patchMessageIn` / `pushMessageTo` 跨会话写。
 */
function withActiveMessages(
  state: ExtremeState,
  messages: ExtremeMessage[],
): ExtremeWorkspace[] {
  if (!state.workspaceId) return state.workspaces;
  return state.workspaces.map((entry) =>
    entry.id === state.workspaceId
      ? { ...entry, messages, updatedAt: Date.now() }
      : entry,
  );
}

/**
 * 覆盖正文时保持 `parts` 同步。
 *
 * 有顺序信息的一轮里，`text` 只是"所有正文片段之和"；终态 / 重试写回的是
 * **最后一段**的权威全文，前面几轮的过程记录（正文、命令）不能被整条覆盖。
 * 没有 `parts` 的旧记录照旧整体替换。
 */
function withPatchedText(
  message: ExtremeMessage,
  patch: Partial<ExtremeMessage>,
): ExtremeMessage {
  if (patch.parts !== undefined || patch.text === undefined || !message.parts?.length) {
    return { ...message, ...patch };
  }
  const parts = replaceTrailingText(message.parts, patch.text);
  return { ...message, ...patch, parts, text: partsText(parts) };
}

/**
 * 把镜像写回当前 workspace。
 *
 * `updatedAt` 只在对话内容真的变了时更新：切来切去不该把旧对话顶到最上面。
 */
function captureWorkspace(state: ExtremeState): ExtremeWorkspace[] {
  return state.workspaces.map((entry) => {
    if (entry.id !== state.workspaceId) return entry;
    const changed = entry.messages !== state.messages;
    return {
      ...entry,
      messages: state.messages,
      draft: state.draft,
      updatedAt: changed ? Date.now() : entry.updatedAt,
      context: snapshot(state),
    };
  });
}

/** 旧记录没有 `serverKey` 时补齐（新记录用它兼容旧版读取）。 */
function keyOf(server: string, host?: string | null) {
  return JSON.stringify([server, host ?? ""]);
}

function newWorkspace(input: {
  serverId: string | null;
  server: string;
  host: string | null;
  sessionId: string;
  folders: string[];
}): ExtremeWorkspace {
  return {
    id: crypto.randomUUID(),
    serverId: input.serverId,
    server: input.server,
    host: input.host,
    serverKey: keyOf(input.server, input.host),
    sessionId: input.sessionId,
    folders: input.folders,
    messages: [],
    draft: "",
    updatedAt: Date.now(),
  };
}

/** 打开一条已存在的对话：把它的上下文装回镜像。 */
function loadWorkspace(entry: ExtremeWorkspace) {
  const context = entry.context ?? { ...emptyContext(), messages: entry.messages };
  return {
    workspaceId: entry.id,
    serverId: entry.serverId,
    server: entry.server,
    serverHost: entry.host,
    messages: entry.messages,
    draft: entry.draft,
    attachments: context.attachments,
    plan: context.plan,
    planSession: context.planSession,
    planTaskId: context.planTaskId,
    notice: context.notice,
    model: context.model,
    executing: context.executing,
    rightTab: null as ExtremeRightTab | null,
  };
}

/** 收起 / 分栏 / 展开：跨重启保留，右下角"布局"才真的能恢复。 */
function readPaneView(): WorkspacePaneView {
  try {
    const value = localStorage.getItem(PANE_VIEW_KEY);
    return value === "split" || value === "expanded" ? value : "hidden";
  } catch {
    return "hidden";
  }
}

function writePaneView(view: WorkspacePaneView) {
  try {
    localStorage.setItem(PANE_VIEW_KEY, view);
  } catch {
    // 存不了就只在本次会话里生效。
  }
}

function readPaneViews(): Record<string, WorkspacePaneView> {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(PANE_VIEWS_KEY) ?? "{}");
    if (!parsed || typeof parsed !== "object") return {};
    const out: Record<string, WorkspacePaneView> = {};
    for (const [id, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (value === "split" || value === "expanded" || value === "hidden") {
        out[id] = value;
      }
    }
    return out;
  } catch {
    return {};
  }
}

function writePaneViews(map: Record<string, WorkspacePaneView>) {
  try {
    localStorage.setItem(PANE_VIEWS_KEY, JSON.stringify(map));
  } catch {
    // 存不了就只在本次会话里生效。
  }
}

const INITIAL_PANE = readPaneState();

export const useExtremeStore = create<ExtremeState>()((set, get) => ({
  active: false,
  serverId: null,
  server: null,
  serverHost: null,
  sessionId: null,
  connections: {},
  // 上次选中的对话要**跨应用重启**保留：它决定"打开超能时回到哪条"。
  lastWorkspaceByServer: readLastWorkspaces(),
  taskUsage: readTaskUsage(),
  historyError: null,
  unread: {},
  queuedSends: [],
  workspaces: readWorkspaces(),
  workspaceId: null,
  draft: "",
  messages: [],
  attachments: [],
  plan: null,
  planSession: null,
  planTaskId: null,
  notice: null,
  model: null,
  panelOpen: true,
  rightTab: null,
  panelTab: "status",
  panelTarget: null,
  panelShown: false,
  paneTab: "files",
  paneByWorkspace: INITIAL_PANE.active,
  paneLists: INITIAL_PANE.lists,
  paneMru: INITIAL_PANE.mru,
  browserByWorkspace: INITIAL_PANE.browser,
  logSourceByWorkspace: INITIAL_PANE.logs,
  remotePathByWorkspace: {},
  fileChanges: {},
  changeViews: readChangeViews(),
  paneView: readPaneView(),
  paneViewByWorkspace: readPaneViews(),
  paneWidth: INITIAL_PANE.width,
  paneDragging: false,
  terminalPane: "output",
  terminalPaneByWorkspace: {},
  chatPrefs: defaultChatPrefs(),
  chatPrefsByWorkspace: readChatPrefs(),
  modelSettings: readModelSettings(),
  modelSettingsByWorkspace: readModelOverrides(),
  executing: false,
  focusTaskId: null,
  tasks: {},
  taskVersions: {},
  reports: {},
  addWorkspace: (folders, attachments = []) => {
    const state = get();
    if (!state.sessionId || !state.server || state.executing) return;
    const entry = newWorkspace({
      serverId: state.serverId,
      server: state.server,
      host: state.serverHost,
      sessionId: state.sessionId,
      folders,
    });
    const prefs = defaultChatPrefs();
    const chatMap = { ...state.chatPrefsByWorkspace, [entry.id]: prefs };
    writeChatPrefs(chatMap);
    // 新任务默认右栏：设置页可选“收起 / 打开”；已有会话保留自己的。
    const newPane: WorkspacePaneView =
      useExtremeSettingsStore.getState().newTaskPane === "open" ? "split" : "hidden";
    const paneMap = { ...state.paneViewByWorkspace, [entry.id]: newPane };
    writePaneViews(paneMap);
    set({
      ...emptyContext(),
      attachments,
      draft: "",
      chatPrefs: prefs,
      chatPrefsByWorkspace: chatMap,
      workspaces: [entry, ...captureWorkspace(state)],
      workspaceId: entry.id,
      paneTab: "files",
      paneLists: { ...state.paneLists, [entry.id]: ["files"] },
      paneView: newPane,
      paneViewByWorkspace: paneMap,
      rightTab: null,
      lastWorkspaceByServer: state.serverId
        ? { ...state.lastWorkspaceByServer, [state.serverId]: entry.id }
        : state.lastWorkspaceByServer,
    });
  },
  addFolders: (folders) => {
    const state = get();
    if (!state.workspaceId || folders.length === 0) return;
    set({
      workspaces: state.workspaces.map((entry) =>
        entry.id === state.workspaceId
          ? { ...entry, folders: [...new Set([...entry.folders, ...folders])] }
          : entry,
      ),
    });
  },
  /**
   * 用户从左侧选中一条旧对话（可能属于另一台服务器）。
   *
   * 有可用连接就绑上去接着执行；没有就只读显示（`sessionId = null`），
   * 绝不借用当前这台服务器的连接。
   */
  openWorkspace: (id) => {
    const state = get();
    // 重复点当前会话：什么都不做，保留阅读位置（重新装载会把滚动条打回顶部）。
    if (state.workspaceId === id) {
      get().clearUnread(id);
      return;
    }
    get().clearUnread(id);
    const captured = captureWorkspace(state);
    const entry = captured.find((item) => item.id === id);
    if (!entry) return;
    const connection = entry.serverId ? state.connections[entry.serverId] : undefined;
    const sessionId = connection?.sessionId ?? "";
    const entryTab = state.paneByWorkspace[id] ?? "files";
    const entryList = state.paneLists[id]?.length ? state.paneLists[id] : [entryTab];
    const nextPrefs = state.chatPrefsByWorkspace[id] ?? defaultChatPrefs();
    set({
      ...loadWorkspace(entry),
      chatPrefs: nextPrefs,
      // 右栏开合按对话恢复：A 收起、B 打开，切回去仍是各自的样子。
      paneView: state.paneViewByWorkspace[id] ?? "hidden",
      sessionId: sessionId || null,
      // 右栏标签跟着对话走：A 开着文件和日志，切到 B 显示 B 自己的。
      paneTab: entryTab,
      paneLists: { ...state.paneLists, [id]: entryList },
      paneMru: {
        ...state.paneMru,
        [id]: state.paneMru[id]?.length ? state.paneMru[id] : [entryTab],
      },
      // 终端子标签跟着对话走：A 停在「真实终端」，切到 B 再回来仍是终端。
      terminalPane: state.terminalPaneByWorkspace[id] ?? "output",
      workspaces: captured.map((item) =>
        item.id === id && sessionId ? { ...item, sessionId } : item,
      ),
      // 换对话就不该继续展示上一条的面板：文件路径 / 日志来源都属于原来那条。
      panelShown: false,
      // 选中就记住，即使这条对话当前没有连接（历史仍可查看）。
      lastWorkspaceByServer: entry.serverId
        ? { ...state.lastWorkspaceByServer, [entry.serverId]: id }
        : state.lastWorkspaceByServer,
    });
  },

  /**
   * 进入超能（或切到另一台服务器）。
   *
   * 恢复顺序：**上次选中的** → **这台服务器最近使用的** → 欢迎态。
   *
   * 欢迎态**不建记录**：以前这里每次都会 `newWorkspace`，退出再进来就多一条
   * 空对话、应用重启后更是一条都找不回来（内存里的 last 映射丢了）。
   */
  enter: (serverId, server, sessionId, serverHost) => {
    const state = get();
    const workspaces = captureWorkspace(state);
    const connections = {
      ...state.connections,
      [serverId]: { sessionId, host: serverHost ?? null },
    };

    // 同一台 + 已经开着某条对话：只换绑连接（重连也不新建）。
    if (state.serverId === serverId && state.workspaceId) {
      set({
        active: true,
        server,
        serverHost: serverHost ?? null,
        sessionId,
        connections,
        workspaces: workspaces.map((entry) =>
          entry.id === state.workspaceId ? { ...entry, sessionId } : entry,
        ),
        lastWorkspaceByServer: { ...state.lastWorkspaceByServer, [serverId]: state.workspaceId },
      });
      return;
    }

    const remembered = state.lastWorkspaceByServer[serverId];
    const resume =
      (remembered
        ? workspaces.find((entry) => entry.id === remembered && entry.serverId === serverId)
        : undefined) ?? mostRecentForServer(workspaces, serverId);

    /*
     * 还没按 `serverId` 命中：**同一个连接目标**（账号@地址:端口）上的历史应该
     * 继续用，而不是当成"这台还没有对话"再开一条。
     *
     * 只接管两类，避免误绑：
     * * `quick:` 前缀 —— 没有服务器配置的临时连接，`tab.id` 每次都变，
     *   不按地址认就永远找不回历史；
     * * `serverId === null` 的旧记录 —— 它们本来就"未关联"，现在有确切地址
     *   可以确认。
     * 两台**配置不同**的服务器即使地址相同也不互相接管。
     */
    const adopted =
      resume || !serverHost
        ? undefined
        : workspaces.find(
          (entry) =>
            entry.host === serverHost &&
            (entry.serverId === null ||
              serverId.startsWith("quick:") ||
              entry.serverId === serverId),
        );
    const target = resume ?? adopted;
    // 接管旧记录：把归属补成当前这台的 serverId / 名字，下次直接按 id 命中。
    const rebound = target
      ? workspaces.map((entry) =>
        entry.id === target.id ? { ...entry, serverId, server } : entry,
      )
      : workspaces;

    if (!target) {
      // 这台服务器一条对话都没有：进欢迎态，等第一条消息再落记录。
      set({
        active: true,
        // 先把上一条对话的镜像写回（否则切走时新增的消息会丢）。
        workspaces,
        ...emptyContext(),
        serverId,
        server,
        serverHost: serverHost ?? null,
        sessionId,
        connections,
        workspaceId: null,
        draft: "",
        chatPrefs: defaultChatPrefs(),
        paneView: "hidden",
        rightTab: null,
        panelShown: false,
      });
      return;
    }

    const targetTab = state.paneByWorkspace[target.id] ?? "files";
    set({
      active: true,
      ...loadWorkspace(target),
      chatPrefs: state.chatPrefsByWorkspace[target.id] ?? defaultChatPrefs(),
      paneView: state.paneViewByWorkspace[target.id] ?? "hidden",
      server,
      serverHost: serverHost ?? null,
      sessionId,
      connections,
      paneTab: targetTab,
      paneLists: {
        ...state.paneLists,
        [target.id]: state.paneLists[target.id]?.length
          ? state.paneLists[target.id]
          : [targetTab],
      },
      paneMru: {
        ...state.paneMru,
        [target.id]: state.paneMru[target.id]?.length
          ? state.paneMru[target.id]
          : [targetTab],
      },
      terminalPane: state.terminalPaneByWorkspace[target.id] ?? "output",
      workspaces: [
        { ...target, serverId, server, sessionId },
        ...rebound.filter((entry) => entry.id !== target.id),
      ],
      lastWorkspaceByServer: { ...state.lastWorkspaceByServer, [serverId]: target.id },
    });
  },

  ensureWorkspace: () => {
    const state = get();
    if (state.workspaceId) return state.workspaceId;
    if (!state.serverId || !state.server || !state.sessionId) return null;
    const entry = newWorkspace({
      serverId: state.serverId,
      server: state.server,
      host: state.serverHost,
      sessionId: state.sessionId,
      folders: [],
    });
    const prefs = defaultChatPrefs();
    const chatMap = { ...state.chatPrefsByWorkspace, [entry.id]: prefs };
    writeChatPrefs(chatMap);
    const lazyPane: WorkspacePaneView =
      useExtremeSettingsStore.getState().newTaskPane === "open" ? "split" : "hidden";
    const paneMap = { ...state.paneViewByWorkspace, [entry.id]: lazyPane };
    writePaneViews(paneMap);
    set({
      workspaceId: entry.id,
      chatPrefs: prefs,
      chatPrefsByWorkspace: chatMap,
      workspaces: [entry, ...captureWorkspace(state)],
      paneTab: "files",
      paneLists: { ...state.paneLists, [entry.id]: ["files"] },
      paneMru: { ...state.paneMru, [entry.id]: ["files"] },
      // 懒创建也是新任务：按“新任务默认”决定右栏，已有会话切回时仍用各自的值。
      paneView: lazyPane,
      paneViewByWorkspace: paneMap,
      lastWorkspaceByServer: {
        ...state.lastWorkspaceByServer,
        [state.serverId]: entry.id,
      },
    });
    return entry.id;
  },

  renameWorkspace: (id, title) => {
    const clean = title.trim().slice(0, 80);
    set((state) => ({
      workspaces: state.workspaces.map((entry) =>
        entry.id === id
          ? { ...entry, title: clean || undefined, updatedAt: Date.now() }
          : entry,
      ),
    }));
  },

  removeWorkspace: (id) => {
    const state = get();
    const captured = captureWorkspace(state);
    const rest = captured.filter((entry) => entry.id !== id);
    /** 对话删了，它的右栏状态也一起清掉，免得 id 复用时恢复出旧标签。 */
    const forgetPane = () => {
      const drop = <T,>(map: Record<string, T>) => {
        const next = { ...map };
        delete next[id];
        return next;
      };
      const chatMap = drop(state.chatPrefsByWorkspace);
      writeChatPrefs(chatMap);
      const modelMap = drop(state.modelSettingsByWorkspace);
      writeModelOverrides(modelMap);
      const paneMap = drop(state.paneViewByWorkspace);
      writePaneViews(paneMap);
      return {
        chatPrefsByWorkspace: chatMap,
        modelSettingsByWorkspace: modelMap,
        paneViewByWorkspace: paneMap,
        paneByWorkspace: drop(state.paneByWorkspace),
        paneLists: drop(state.paneLists),
        paneMru: drop(state.paneMru),
        browserByWorkspace: drop(state.browserByWorkspace),
        logSourceByWorkspace: drop(state.logSourceByWorkspace),
        // 变更的阅读状态与摘要也一起清掉：id 复用时不至于恢复出别人的文件。
        changeViews: Object.fromEntries(
          Object.entries(state.changeViews).filter(([key]) => !key.startsWith(`${id}:`)),
        ),
        fileChanges: Object.fromEntries(
          Object.entries(state.fileChanges).filter(([, item]) => item.workspaceId !== id),
        ),
      };
    };
    // 对话删了，它排着的消息也没有"原对话"可发了。
    const queuedSends = forgetSends(state.queuedSends, id);
    if (state.workspaceId !== id) {
      set({ workspaces: rest, queuedSends, ...forgetPane() });
      return;
    }
    const next = mostRecentForServer(rest, state.serverId);
    const lastWorkspaceByServer = { ...state.lastWorkspaceByServer };
    if (state.serverId) {
      if (next) lastWorkspaceByServer[state.serverId] = next.id;
      else delete lastWorkspaceByServer[state.serverId];
    }
    if (!next) {
      // 一条都不剩：回到欢迎态，**不新建**记录。
      set({
        workspaces: rest,
        queuedSends,
        workspaceId: null,
        ...emptyContext(),
        draft: "",
        chatPrefs: defaultChatPrefs(),
        lastWorkspaceByServer,
        ...forgetPane(),
      });
      return;
    }
    set({
      workspaces: rest,
      queuedSends,
      ...loadWorkspace(next),
      chatPrefs: state.chatPrefsByWorkspace[next.id] ?? defaultChatPrefs(),
      paneView: state.paneViewByWorkspace[next.id] ?? "hidden",
      sessionId: state.sessionId,
      lastWorkspaceByServer,
      ...forgetPane(),
    });
  },

  exit: () => {
    const state = get();
    set({ active: false, workspaces: captureWorkspace(state) });
  },

  close: () => {
    const state = get();
    // 任务在跑时只收起：清掉上下文会让执行结果无处可写。
    if (state.executing) {
      state.exit();
      return;
    }
    const rest = state.workspaces.filter((entry) => entry.id !== state.workspaceId);
    set({
      active: false,
      workspaceId: null,
      workspaces: rest,
      messages: [],
      attachments: [],
      draft: "",
      plan: null,
      planSession: null,
      planTaskId: null,
      notice: null,
      model: null,
      executing: false,
    });
  },

  markDisconnected: (serverId) => {
    const state = get();
    const connections = { ...state.connections };
    delete connections[serverId];
    set({
      connections,
      // 正在看的这条对话属于断开的服务器：进入只读（历史仍可查看）。
      sessionId:
        state.serverId === serverId && state.sessionId
          ? null
          : state.sessionId,
    });
  },

  pushMessage: (message) =>
    set((state) => {
      const messages = [...state.messages, { createdAt: Date.now(), ...message }];
      return { messages, workspaces: withActiveMessages(state, messages) };
    }),
  pushMessageTo: (workspaceId, message) =>
    set((state) => {
      // 时间戳在入口统一补：两个 push 共用同一份，气泡与落库看到的是同一个值。
      const stamped = { createdAt: Date.now(), ...message };
      const workspaces = state.workspaces.map((entry) =>
        entry.id === workspaceId
          ? { ...entry, messages: [...entry.messages, stamped], updatedAt: Date.now() }
          : entry,
      );
      return {
        workspaces,
        messages:
          state.workspaceId === workspaceId
            ? [...state.messages, stamped]
            : state.messages,
      };
    }),
  setMessages: (messages) =>
    set((state) => ({ messages, workspaces: withActiveMessages(state, messages) })),
  appendToMessage: (id, delta) =>
    set((state) => {
      const messages = state.messages.map((message) =>
        message.id === id ? { ...message, text: message.text + delta } : message,
      );
      return { messages, workspaces: withActiveMessages(state, messages) };
    }),
  patchMessage: (id, patch) =>
    set((state) => {
      const messages = state.messages.map((message) =>
        message.id === id ? withPatchedText(message, patch) : message,
      );
      return { messages, workspaces: withActiveMessages(state, messages) };
    }),
  patchMessageIn: (workspaceId, id, patch) =>
    set((state) => {
      const apply = (messages: ExtremeMessage[]) =>
        messages.map((message) => (message.id === id ? withPatchedText(message, patch) : message));
      return {
        workspaces: state.workspaces.map((entry) =>
          entry.id === workspaceId
            ? // 后台任务也要把这条顶到"最近活跃"：左栏排序读的是 updatedAt。
            { ...entry, messages: apply(entry.messages), updatedAt: Date.now() }
            : entry,
        ),
        messages: state.workspaceId === workspaceId ? apply(state.messages) : state.messages,
      };
    }),
  removeMessage: (id) =>
    set((state) => {
      const messages = state.messages.filter((message) => message.id !== id);
      return { messages, workspaces: withActiveMessages(state, messages) };
    }),
  removeMessageIn: (workspaceId, id) =>
    set((state) => {
      const apply = (messages: ExtremeMessage[]) => messages.filter((message) => message.id !== id);
      return {
        workspaces: state.workspaces.map((entry) =>
          entry.id === workspaceId
            ? { ...entry, messages: apply(entry.messages), updatedAt: Date.now() }
            : entry,
        ),
        messages: state.workspaceId === workspaceId ? apply(state.messages) : state.messages,
      };
    }),
  setAttachments: (updater) => set((state) => ({ attachments: updater(state.attachments) })),
  setAttachmentsIn: (workspaceId, updater) =>
    set((state) => {
      const isCurrent = state.workspaceId === workspaceId;
      const owner = state.workspaces.find((entry) => entry.id === workspaceId);
      const base = isCurrent ? state.attachments : owner?.context?.attachments ?? [];
      const next = updater(base);
      return {
        attachments: isCurrent ? next : state.attachments,
        workspaces: state.workspaces.map((entry) =>
          entry.id === workspaceId
            ? // 还没有 context 的对话（从没切走过）等 `captureWorkspace` 收编。
            { ...entry, context: entry.context ? { ...entry.context, attachments: next } : entry.context }
            : entry,
        ),
      };
    }),
  setPlan: (plan) => set({ plan }),
  setPlanSession: (planSession) => set({ planSession }),
  updatePlan: (updater) =>
    set((state) => ({ plan: state.plan ? updater(state.plan) : state.plan })),
  setNotice: (notice) => set({ notice }),
  setModel: (model) => set({ model }),
  setTaskUsage: (taskId, usage) =>
    set((state) => {
      if (!usage) return state;
      // 轮询每 1.5s 回一次同样的快照：内容没变就不改引用，避免无谓重渲染与写盘。
      const previous = state.taskUsage[taskId];
      if (previous && JSON.stringify(previous) === JSON.stringify(usage)) return state;
      const next = { ...state.taskUsage };
      // 重新插入到末尾：持久化按顺序裁掉最旧的。
      delete next[taskId];
      next[taskId] = usage;
      return { taskUsage: next };
    }),
  dismissHistoryError: () => set({ historyError: null }),
  clearUnread: (workspaceId) =>
    set((state) => {
      if (!state.unread[workspaceId]) return state;
      const unread = { ...state.unread };
      delete unread[workspaceId];
      return { unread };
    }),
  queueSend: (item) => set((state) => ({ queuedSends: enqueueSend(state.queuedSends, item) })),
  dropSend: (id) => set((state) => ({ queuedSends: removeSend(state.queuedSends, id) })),
  moveSendUp: (id) =>
    set((state) => ({ queuedSends: moveSendUp(state.queuedSends, id) })),
  failSend: (id, reason) =>
    set((state) => ({ queuedSends: markSendError(state.queuedSends, id, reason) })),
  retrySend: (id) => set((state) => ({ queuedSends: clearSendError(state.queuedSends, id) })),
  patchWorkspaceContext: (workspaceId, patch) =>
    set((state) => {
      const isCurrent = state.workspaceId === workspaceId;
      const workspaces = state.workspaces.map((entry) => {
        if (entry.id !== workspaceId) return entry;
        const base = entry.context ?? (isCurrent ? snapshot(state) : emptyContext());
        return { ...entry, context: { ...base, ...patch } };
      });
      /*
       * 前台这条同时更新镜像：界面读的是 `plan` / `executing` 这些字段，
       * 只写 workspace.context 的话，前台看到的还是旧值。
       */
      if (!isCurrent) return { workspaces };
      return {
        workspaces,
        plan: patch.plan === undefined ? state.plan : patch.plan,
        planSession: patch.planSession === undefined ? state.planSession : patch.planSession,
        planTaskId: patch.planTaskId === undefined ? state.planTaskId : patch.planTaskId,
        notice: patch.notice === undefined ? state.notice : patch.notice,
        model: patch.model === undefined ? state.model : patch.model,
        executing: patch.executing === undefined ? state.executing : patch.executing,
      };
    }),
  setPanelOpen: (panelOpen) => set({ panelOpen }),
  setRightTab: (rightTab) => set({ rightTab }),
  openPanel: (request) =>
    set((state) => {
      /*
       * 模型请求的目标 → 工作区标签：
       * * 远程文件 → files
       * * 日志 → logs（独立标签，不再是"真实终端里 tail"）
       * * 命令输出 → terminal › output
       * * 服务器状态 / 服务 → plan（沿用旧行为，保持一个能看的地方）
       */
      const pane: WorkspacePane =
        request.tab === "files"
          ? "files"
          : request.tab === "logs"
            ? "logs"
            : request.tab === "output"
              ? "terminal"
              : "plan";
      const terminalPane: TerminalPane =
        request.tab === "output" ? "output" : state.terminalPane;
      const ws = state.workspaceId;
      const active = ws ? { ...state.paneByWorkspace, [ws]: pane } : state.paneByWorkspace;
      const lists = ws
        ? { ...state.paneLists, [ws]: [...(state.paneLists[ws] ?? []).filter((item) => item !== pane), pane] }
        : state.paneLists;
      const mru = ws
        ? { ...state.paneMru, [ws]: [pane, ...(state.paneMru[ws] ?? []).filter((item) => item !== pane)] }
        : state.paneMru;
      const logs =
        ws && request.tab === "logs" && request.source
          ? { ...state.logSourceByWorkspace, [ws]: request.source }
          : state.logSourceByWorkspace;
      const view: WorkspacePaneView =
        state.paneView === "hidden" ? "split" : state.paneView;
      writePaneState({
        active,
        lists,
        mru,
        browser: state.browserByWorkspace,
        logs,
        width: state.paneWidth,
      });
      writePaneView(view);
      return {
        rightTab: "panel",
        panelShown: true,
        // 收起态才展开；占满视图保持原样，不把展开缩回分栏。
        paneView: view,
        paneTab: pane,
        paneByWorkspace: active,
        paneLists: lists,
        paneMru: mru,
        logSourceByWorkspace: logs,
        terminalPane,
        terminalPaneByWorkspace: ws
          ? { ...state.terminalPaneByWorkspace, [ws]: terminalPane }
          : state.terminalPaneByWorkspace,
        panelTab: request.tab === "files" ? "status" : request.tab,
        panelTarget: request,
        panelOpen: true,
      };
    }),
  setPanelTab: (panelTab) => set({ panelTab }),
  setPanelShown: (panelShown) => set({ panelShown }),
  openPane: (tab, terminal) =>
    set((state) => {
      const ws = state.workspaceId;
      const active = ws ? { ...state.paneByWorkspace, [ws]: tab } : state.paneByWorkspace;
      const lists = ws
        ? { ...state.paneLists, [ws]: [...(state.paneLists[ws] ?? []).filter((item) => item !== tab), tab] }
        : state.paneLists;
      const mru = ws
        ? { ...state.paneMru, [ws]: [tab, ...(state.paneMru[ws] ?? []).filter((item) => item !== tab)] }
        : state.paneMru;
      writePaneState({
        active,
        lists,
        mru,
        browser: state.browserByWorkspace,
        logs: state.logSourceByWorkspace,
        width: state.paneWidth,
      });
      const view: WorkspacePaneView =
        state.paneView === "hidden" ? "split" : state.paneView;
      writePaneView(view);
      const terminalPane = terminal ?? state.terminalPane;
      return {
        // 收起态才展开；占满视图（expanded）保持不变。
        paneView: view,
        paneTab: tab,
        paneByWorkspace: active,
        paneLists: lists,
        paneMru: mru,
        terminalPane,
        terminalPaneByWorkspace:
          terminal && ws
            ? { ...state.terminalPaneByWorkspace, [ws]: terminal }
            : state.terminalPaneByWorkspace,
        // 旧入口仍在读这两个标记，保持一致。
        rightTab: "panel" as const,
        panelShown: true,
        panelOpen: true,
      };
    }),
  setPaneTab: (tab) =>
    set((state) => {
      const ws = state.workspaceId;
      const active = ws ? { ...state.paneByWorkspace, [ws]: tab } : state.paneByWorkspace;
      const lists = ws && !(state.paneLists[ws] ?? []).includes(tab)
        ? { ...state.paneLists, [ws]: [...(state.paneLists[ws] ?? []), tab] }
        : state.paneLists;
      const mru = ws
        ? { ...state.paneMru, [ws]: [tab, ...(state.paneMru[ws] ?? []).filter((item) => item !== tab)] }
        : state.paneMru;
      writePaneState({
        active,
        lists,
        mru,
        browser: state.browserByWorkspace,
        logs: state.logSourceByWorkspace,
        width: state.paneWidth,
      });
      return { paneTab: tab, paneByWorkspace: active, paneLists: lists, paneMru: mru };
    }),
  closePane: (tab) =>
    set((state) => {
      const ws = state.workspaceId;
      if (!ws) return state;
      const list = (state.paneLists[ws] ?? []).filter((item) => item !== tab);
      const mru = (state.paneMru[ws] ?? []).filter((item) => item !== tab);
      const activeTab = state.paneByWorkspace[ws] ?? state.paneTab;
      let nextTab = activeTab;
      let view = state.paneView;
      if (activeTab === tab) {
        // 关掉当前标签：切到最近用过的；一个都不剩就收起右栏。
        nextTab = mru.find((item) => list.includes(item)) ?? list[list.length - 1] ?? tab;
        if (list.length === 0) view = "hidden";
      }
      const active = { ...state.paneByWorkspace, [ws]: nextTab };
      const lists = { ...state.paneLists, [ws]: list };
      const mrus = { ...state.paneMru, [ws]: mru };
      writePaneState({
        active,
        lists,
        mru: mrus,
        browser: state.browserByWorkspace,
        logs: state.logSourceByWorkspace,
        width: state.paneWidth,
      });
      writePaneView(view);
      return {
        paneView: view,
        paneTab: nextTab,
        paneByWorkspace: active,
        paneLists: lists,
        paneMru: mrus,
        rightTab: view === "hidden" ? null : "panel",
        panelShown: view !== "hidden",
      };
    }),
  setBrowserUrl: (workspaceId, url) =>
    set((state) => {
      if (!/^https?:\/\//i.test(url)) return state;
      const browser = { ...state.browserByWorkspace, [workspaceId]: url };
      writePaneState({
        active: state.paneByWorkspace,
        lists: state.paneLists,
        mru: state.paneMru,
        browser,
        logs: state.logSourceByWorkspace,
        width: state.paneWidth,
      });
      return { browserByWorkspace: browser };
    }),
  setLogSource: (workspaceId, source) =>
    set((state) => {
      const logs = { ...state.logSourceByWorkspace, [workspaceId]: source };
      writePaneState({
        active: state.paneByWorkspace,
        lists: state.paneLists,
        mru: state.paneMru,
        browser: state.browserByWorkspace,
        logs,
        width: state.paneWidth,
      });
      return { logSourceByWorkspace: logs };
    }),
  setRemotePath: (workspaceId, path) =>
    set((state) => {
      if (state.remotePathByWorkspace[workspaceId] === path) return state;
      return {
        remotePathByWorkspace: { ...state.remotePathByWorkspace, [workspaceId]: path },
      };
    }),
  mergeFileChange: (change) =>
    set((state) => {
      const current = state.fileChanges[change.id];
      // 事件可能乱序：旧快照不能把"已写入"退回"拟修改"。
      if (current && current.updatedAt > change.updatedAt) return state;
      return { fileChanges: { ...state.fileChanges, [change.id]: change } };
    }),
  mergeFileChanges: (list) =>
    set((state) => {
      if (list.length === 0) return state;
      const next = { ...state.fileChanges };
      for (const item of list) {
        const current = next[item.id];
        if (current && current.updatedAt > item.updatedAt) continue;
        next[item.id] = item;
      }
      return { fileChanges: next };
    }),
  setChangeView: (key, patch, options) =>
    set((state) => {
      const next = {
        ...state.changeViews,
        [key]: { ...(state.changeViews[key] ?? EMPTY_CHANGE_VIEW), ...patch },
      };
      // 滚动是高频的：中间帧只更新内存，松手时才写一次 localStorage。
      if (options?.persist !== false) writeChangeViews(next);
      return { changeViews: next };
    }),
  flushChangeViews: () => writeChangeViews(get().changeViews),
  setPaneView: (view) => {
    writePaneView(view);
    set((state) => {
      const map = state.workspaceId
        ? { ...state.paneViewByWorkspace, [state.workspaceId]: view }
        : state.paneViewByWorkspace;
      if (state.workspaceId) writePaneViews(map);
      return {
        paneView: view,
        paneViewByWorkspace: map,
        // `rightTab` / `panelShown` 是旧入口仍在读的两个标记，保持一致。
        rightTab: view === "hidden" ? null : "panel",
        panelShown: view !== "hidden",
        panelOpen: true,
      };
    });
  },
  setPaneDragging: (paneDragging) => set({ paneDragging }),
  setPaneWidth: (width, options) =>
    set((state) => {
      /*
       * 只保证最小值；上限交给当前容器（`paneRoom`）。
       * 以前写死 720：大屏上拖到 720 就停住，用户会觉得"只能往里拖"。
       */
      const next = Math.max(300, Math.round(width));
      // 拖动中的中间帧不落盘：松手时那一次才写。
      if (options?.persist !== false) {
        writePaneState({
          active: state.paneByWorkspace,
          lists: state.paneLists,
          mru: state.paneMru,
          browser: state.browserByWorkspace,
          logs: state.logSourceByWorkspace,
          width: next,
        });
      }
      return { paneWidth: next };
    }),
  setTerminalPane: (terminalPane) =>
    set((state) => ({
      terminalPane,
      terminalPaneByWorkspace: state.workspaceId
        ? { ...state.terminalPaneByWorkspace, [state.workspaceId]: terminalPane }
        : state.terminalPaneByWorkspace,
    })),
  setContextMode: (context) =>
    set((state) => {
      const next: ChatPrefs = { ...state.chatPrefs, context, contextCustom: true };
      const map = state.workspaceId
        ? { ...state.chatPrefsByWorkspace, [state.workspaceId]: next }
        : state.chatPrefsByWorkspace;
      writeChatPrefs(map);
      return { chatPrefs: next, chatPrefsByWorkspace: map };
    }),
  setOutputStyle: (output) =>
    set((state) => {
      const next: ChatPrefs = { ...state.chatPrefs, output, outputCustom: true };
      const map = state.workspaceId
        ? { ...state.chatPrefsByWorkspace, [state.workspaceId]: next }
        : state.chatPrefsByWorkspace;
      writeChatPrefs(map);
      return { chatPrefs: next, chatPrefsByWorkspace: map };
    }),
  addPicked: (items) =>
    set((state) => {
      const seen = new Set(state.chatPrefs.picked.map((item) => item.id));
      const merged = [...state.chatPrefs.picked];
      for (const item of items) {
        if (seen.has(item.id)) continue;
        seen.add(item.id);
        merged.push(item);
      }
      const next: ChatPrefs = { ...state.chatPrefs, picked: merged };
      const map = state.workspaceId
        ? { ...state.chatPrefsByWorkspace, [state.workspaceId]: next }
        : state.chatPrefsByWorkspace;
      writeChatPrefs(map);
      return { chatPrefs: next, chatPrefsByWorkspace: map };
    }),
  removePicked: (id) =>
    set((state) => {
      const next: ChatPrefs = {
        ...state.chatPrefs,
        picked: state.chatPrefs.picked.filter((item) => item.id !== id),
      };
      const map = state.workspaceId
        ? { ...state.chatPrefsByWorkspace, [state.workspaceId]: next }
        : state.chatPrefsByWorkspace;
      writeChatPrefs(map);
      return { chatPrefs: next, chatPrefsByWorkspace: map };
    }),
  clearPicked: () =>
    set((state) => {
      const next: ChatPrefs = { ...state.chatPrefs, picked: [] };
      const map = state.workspaceId
        ? { ...state.chatPrefsByWorkspace, [state.workspaceId]: next }
        : state.chatPrefsByWorkspace;
      writeChatPrefs(map);
      return { chatPrefs: next, chatPrefsByWorkspace: map };
    }),
  setProviderId: (providerId) =>
    set((state) => {
      const next: ChatPrefs = { ...state.chatPrefs, providerId };
      const map = state.workspaceId
        ? { ...state.chatPrefsByWorkspace, [state.workspaceId]: next }
        : state.chatPrefsByWorkspace;
      writeChatPrefs(map);
      return { chatPrefs: next, chatPrefsByWorkspace: map };
    }),
  resetChatPreference: (field) =>
    set((state) => {
      const defaults = defaultChatPrefs();
      const next: ChatPrefs =
        field === "context"
          ? {
              ...state.chatPrefs,
              context: defaults.context,
              contextCustom: false,
            }
          : {
              ...state.chatPrefs,
              output: defaults.output,
              outputCustom: false,
            };
      const map = state.workspaceId
        ? { ...state.chatPrefsByWorkspace, [state.workspaceId]: next }
        : state.chatPrefsByWorkspace;
      writeChatPrefs(map);
      return { chatPrefs: next, chatPrefsByWorkspace: map };
    }),
  applyDefaultChatPrefs: () =>
    set((state) => {
      const defaults = defaultChatPrefs();
      const sync = (prefs: ChatPrefs): ChatPrefs => ({
        ...prefs,
        context: prefs.contextCustom === false ? defaults.context : prefs.context,
        output: prefs.outputCustom === false ? defaults.output : prefs.output,
      });
      const map: Record<string, ChatPrefs> = {};
      for (const [id, prefs] of Object.entries(state.chatPrefsByWorkspace)) {
        map[id] = sync(prefs);
      }
      writeChatPrefs(map);
      return { chatPrefs: sync(state.chatPrefs), chatPrefsByWorkspace: map };
    }),
  setModelSetting: (key, patch) =>
    set((state) => {
      if (!state.workspaceId) {
        const current = state.modelSettings[key] ?? DEFAULT_MODEL_SETTING;
        const map = { ...state.modelSettings, [key]: { ...current, ...patch } };
        writeModelSettings(map);
        return { modelSettings: map };
      }
      const existing = state.modelSettingsByWorkspace[state.workspaceId] ?? {};
      const current =
        existing[key] ?? state.modelSettings[key] ?? DEFAULT_MODEL_SETTING;
      const next = { ...current, ...patch };
      const byWorkspace = {
        ...state.modelSettingsByWorkspace,
        [state.workspaceId]: { ...existing, [key]: next },
      };
      writeModelOverrides(byWorkspace);
      return { modelSettingsByWorkspace: byWorkspace };
    }),
  setDefaultModelSetting: (key, patch) =>
    set((state) => {
      const current = state.modelSettings[key] ?? DEFAULT_MODEL_SETTING;
      const map = { ...state.modelSettings, [key]: { ...current, ...patch } };
      writeModelSettings(map);
      return { modelSettings: map };
    }),
  resetModelSetting: (key) =>
    set((state) => {
      if (!state.workspaceId) return {};
      const existing = { ...(state.modelSettingsByWorkspace[state.workspaceId] ?? {}) };
      delete existing[key];
      const byWorkspace = {
        ...state.modelSettingsByWorkspace,
        [state.workspaceId]: existing,
      };
      writeModelOverrides(byWorkspace);
      return { modelSettingsByWorkspace: byWorkspace };
    }),
  setExecuting: (executing) => set({ executing }),
  setFocusTaskId: (focusTaskId) => set({ focusTaskId }),
  setDraftText: (draft) => set({ draft }),
  setExecutingFor: (workspaceId, executing) =>
    set((state) => {
      const workspaces = state.workspaces.map((entry) => {
        if (entry.id !== workspaceId) return entry;
        return {
          ...entry,
          context: { ...(entry.context ?? emptyContext()), executing },
        };
      });
      return {
        workspaces,
        executing: state.workspaceId === workspaceId ? executing : state.executing,
      };
    }),
  upsertReport: (taskId, report) =>
    set((state) => {
      const current = state.reports[taskId] ?? [];
      const index = current.findIndex((item) => item.id === report.id);
      const next =
        index >= 0
          ? current.map((item, position) => (position === index ? report : item))
          : [...current, report];
      return { reports: { ...state.reports, [taskId]: next } };
    }),
  upsertTask: (task) => {
    set((state) => ({
      tasks: { ...state.tasks, [task.id]: task },
      taskVersions: { ...state.taskVersions, [task.id]: (state.taskVersions[task.id] ?? 0) + 1 },
    }));

    // 后台对话产生结果：只在应用内点一个小圆点。
    //
    // 桌面通知**不在这里**：历史恢复 / 切换对话也会 upsertTask，一并把旧任务
    // 当"刚完成"推出去。真实终态由事件层调 `notifyTaskOutcome`。
    const terminal = task.status === "done" || task.status === "failed";
    if (terminal && task.workspaceId && task.workspaceId !== get().workspaceId) {
      set((state) => ({
        unread: { ...state.unread, [task.workspaceId!]: true },
      }));
    }
  },
  mergeTask: (task, version) =>
    set((state) => {
      if (version <= (state.taskVersions[task.id] ?? 0)) return state;
      return {
        tasks: { ...state.tasks, [task.id]: task },
        taskVersions: { ...state.taskVersions, [task.id]: version },
      };
    }),
  patchTask: (id, patch) =>
    set((state) => {
      const current = state.tasks[id];
      if (!current) return state;
      return { tasks: { ...state.tasks, [id]: { ...current, ...patch, updatedAt: Date.now() } } };
    }),
}));

let workspaceSave: ReturnType<typeof setTimeout> | undefined;
function persistWorkspaces() {
  clearTimeout(workspaceSave);
  const workspaces = captureWorkspace(useExtremeStore.getState());
  // 数据库是长期来源；localStorage 只做启动兜底 / 旧版本迁移。
  void saveWorkspacesToDb(workspaces);
  // 失败**不再静默**：把原因放回 store，由界面明确提示"重启后可能丢失"。
  const error = writeWorkspaces(workspaces);
  if (error) console.warn("[extreme] 本地历史保存失败：", error);
  if (useExtremeStore.getState().historyError !== error) {
    useExtremeStore.setState({ historyError: error });
  }
}

let hydrateStarted = false;
/**
 * 启动时从 SQLite 恢复对话。
 *
 * 数据库为空而本地有旧数据 → 先把本地这份迁进数据库（升级路径）；
 * 数据库有数据 → 直接覆盖内存里的旧 localStorage 快照。调用失败保持本地
 * 兜底，不阻塞应用启动。
 */
export async function hydrateExtremeStore(): Promise<void> {
  if (hydrateStarted) return;
  hydrateStarted = true;
  const remote = await loadWorkspacesFromDb();
  if (remote === null) return;
  const local = useExtremeStore.getState().workspaces;
  if (remote.length === 0) {
    if (local.length > 0) await saveWorkspacesToDb(local);
    return;
  }
  useExtremeStore.setState({ workspaces: remote });
}

/**
 * 「上次选中」单独落盘。
 *
 * 它很小，但必须在**每次打开 / 切换对话**后立刻写：应用崩溃或强制关闭时，
 * 下次打开也不该回到空白。
 */
function persistLastWorkspace(map: Record<string, string>) {
  writeLastWorkspaces(map);
}

/**
 * 立刻把"当前选中 + 工作区内容"落盘。
 *
 * 正常路径是 250ms 防抖；`pagehide` 与测试用这个同步版本，避免"刚发完消息就
 * 关掉应用，下次打开回到空白"。
 */
export function persistExtremeState() {
  persistWorkspaces();
  writeTaskUsage(useExtremeStore.getState().taskUsage);
  persistLastWorkspace(useExtremeStore.getState().lastWorkspaceByServer);
}

if (typeof window !== "undefined") {
  useExtremeStore.subscribe((state, previous) => {
    if (state.lastWorkspaceByServer !== previous.lastWorkspaceByServer) {
      persistLastWorkspace(state.lastWorkspaceByServer);
    }
    // 用量是小对象，直接写；不触发下面的全量历史序列化。
    if (state.taskUsage !== previous.taskUsage) writeTaskUsage(state.taskUsage);
    if (
      state.messages === previous.messages &&
      state.workspaces === previous.workspaces &&
      state.draft === previous.draft
    ) {
      return;
    }
    /*
     * 落盘是**全量序列化**（所有对话的所有消息）。流式回答时每 250ms 就写一次
     * 会让打字和点击明显发涩，所以：延到 800ms，并且尽量在浏览器空闲时做。
     */
    clearTimeout(workspaceSave);
    workspaceSave = setTimeout(() => {
      const idle = (
        window as unknown as {
          requestIdleCallback?: (callback: () => void, options?: { timeout: number }) => number;
        }
      ).requestIdleCallback;
      if (typeof idle === "function") idle(() => persistWorkspaces(), { timeout: 2000 });
      else persistWorkspaces();
    }, 800);
  });
  window.addEventListener("pagehide", persistExtremeState);
}
