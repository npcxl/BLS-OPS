import { create } from "zustand";
import { pushDesktopNotification } from "@/desktop-notification/bridge";
import type { ContextUsage } from "@/api/types/agent";
import type { DeployStep } from "@/workbench/views/terminal/extreme-core/deploy-plan";
import type { ExecutionReport } from "@/workbench/views/terminal/extreme-core/execution-report";
import type { PanelRequest, PanelTab } from "@/workbench/views/terminal/extreme-core/panel-target";
import type { TaskCardModel } from "@/workbench/views/terminal/extreme-core/task-view";
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
export type WorkspacePane = "files" | "terminal" | "attachments" | "plan";

import type {
  ContextMode,
  OutputStyle,
  PickedContext,
} from "@/workbench/views/terminal/extreme-core/chat-context";
import type { EffortChoice } from "@/workbench/views/terminal/extreme-core/model-choice";

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
const CHAT_PREFS_KEY = "bls-ops.extreme-chat-prefs.v1";
const MODEL_SETTINGS_KEY = "bls-ops.extreme-model-settings.v1";

/** 一条会话的输入偏好：上下文范围、输出形态、勾选的材料。 */
export interface ChatPrefs {
  context: ContextMode;
  output: OutputStyle;
  picked: PickedContext[];
  /** 选中的模型（provider id）；`null` = 用默认提供方。 */
  providerId: string | null;
}

export const DEFAULT_CHAT_PREFS: ChatPrefs = {
  context: "session",
  output: "auto",
  picked: [],
  providerId: null,
};

function normalizePrefs(value: unknown): ChatPrefs {
  const raw = (value ?? {}) as {
    context?: unknown;
    output?: unknown;
    picked?: unknown;
    providerId?: unknown;
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
  return { context, output, picked, providerId };
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

/** 每个会话记住自己选中的标签；宽度整个应用记住一份。 */
function readPaneState(): { tabs: Record<string, WorkspacePane>; width: number } {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(PANE_KEY) ?? "{}");
    const value = (parsed ?? {}) as { tabs?: unknown; width?: unknown };
    const tabs: Record<string, WorkspacePane> = {};
    if (value.tabs && typeof value.tabs === "object") {
      for (const [key, tab] of Object.entries(value.tabs as Record<string, unknown>)) {
        if (tab === "files" || tab === "terminal" || tab === "attachments" || tab === "plan") {
          tabs[key] = tab;
        }
      }
    }
    return { tabs, width: typeof value.width === "number" ? value.width : 360 };
  } catch {
    return { tabs: {}, width: 360 };
  }
}

function writePaneState(tabs: Record<string, WorkspacePane>, width: number) {
  try {
    localStorage.setItem(PANE_KEY, JSON.stringify({ tabs, width }));
  } catch {
    // 存不了就只在内存里生效。
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

  /** 统一右栏：当前会话选中的标签（四个固定标签之一）。 */
  paneTab: WorkspacePane;
  /** 每个会话各自记住的标签。 */
  paneByWorkspace: Record<string, WorkspacePane>;
  /** 收起 / 分栏 / 展开视图。 */
  paneView: WorkspacePaneView;
  /** 分栏宽度（拖动分隔线后记住）。 */
  paneWidth: number;
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
  setPaneWidth: (width: number) => void;
  setTerminalPane: (tab: TerminalPane) => void;

  /** 输入框底栏：当前会话的上下文范围 / 输出形态 / 勾选材料。 */
  chatPrefs: ChatPrefs;
  /** 每条会话各自记住一份。 */
  chatPrefsByWorkspace: Record<string, ChatPrefs>;
  setContextMode: (mode: ContextMode) => void;
  setOutputStyle: (style: OutputStyle) => void;
  /** 加入一份/多份自选材料（同 id 去重）。 */
  addPicked: (items: PickedContext[]) => void;
  removePicked: (id: string) => void;
  clearPicked: () => void;
  /** 选模型：`null` = 默认提供方。下一条消息生效。 */
  setProviderId: (id: string | null) => void;
  /** 按模型记住的思考强度与上下文预算（跨会话，key 见 `modelKey`）。 */
  modelSettings: Record<string, ModelSetting>;
  setModelSetting: (key: string, patch: Partial<ModelSetting>) => void;
  /**
   * 是否正在执行任务。
   *
   * **必须在 store 里**：执行循环跑在组件之外（async 函数不受卸载影响），
   * 退出超能再进来若读不到这个标记，就会允许"再点一次确认执行"，把
   * `docker compose up` 跑两遍。
   */
  executing: boolean;

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
  paneByWorkspace: readPaneState().tabs,
  paneView: "hidden",
  paneWidth: readPaneState().width,
  terminalPane: "output",
  terminalPaneByWorkspace: {},
  chatPrefs: DEFAULT_CHAT_PREFS,
  chatPrefsByWorkspace: readChatPrefs(),
  modelSettings: readModelSettings(),
  executing: false,
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
    set({
      ...emptyContext(),
      attachments,
      draft: "",
      workspaces: [entry, ...captureWorkspace(state)],
      workspaceId: entry.id,
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
    if (state.workspaceId === id) return;
    const captured = captureWorkspace(state);
    const entry = captured.find((item) => item.id === id);
    if (!entry) return;
    const connection = entry.serverId ? state.connections[entry.serverId] : undefined;
    const sessionId = connection?.sessionId ?? "";
    set({
      ...loadWorkspace(entry),
      sessionId: sessionId || null,
      // 终端子标签跟着对话走：A 停在「实时日志」，切到 B 再回来仍是日志。
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
        rightTab: null,
        panelShown: false,
      });
      return;
    }

    set({
      active: true,
      ...loadWorkspace(target),
      server,
      serverHost: serverHost ?? null,
      sessionId,
      connections,
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
    set({
      workspaceId: entry.id,
      workspaces: [entry, ...captureWorkspace(state)],
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
    if (state.workspaceId !== id) {
      set({ workspaces: rest });
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
      set({ workspaces: rest, workspaceId: null, ...emptyContext(), draft: "", lastWorkspaceByServer });
      return;
    }
    set({
      workspaces: rest,
      ...loadWorkspace(next),
      sessionId: state.sessionId,
      lastWorkspaceByServer,
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
        message.id === id ? { ...message, ...patch } : message,
      );
      return { messages, workspaces: withActiveMessages(state, messages) };
    }),
  patchMessageIn: (workspaceId, id, patch) =>
    set((state) => {
      const apply = (messages: ExtremeMessage[]) =>
        messages.map((message) => (message.id === id ? { ...message, ...patch } : message));
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
  setPanelOpen: (panelOpen) => set({ panelOpen }),
  setRightTab: (rightTab) => set({ rightTab }),
  openPanel: (request) =>
    set((state) => {
      /*
       * 模型请求的目标 → 四个固定标签：
       * * 远程文件 → files
       * * 日志 / 命令输出 → terminal（并选中对应的一段）
       * * 服务器运行状态 → plan（进度与计划在同一处）
       */
      const pane: WorkspacePane =
        request.tab === "files"
          ? "files"
          : request.tab === "output" || request.tab === "logs"
            ? "terminal"
            : "plan";
      // 想看日志 → 切到真实终端（在那里 `tail -F`，AI 也能读最近输出）。
      const terminalPane: TerminalPane =
        request.tab === "output" ? "output" : "manual";
      const tabs = state.workspaceId
        ? { ...state.paneByWorkspace, [state.workspaceId]: pane }
        : state.paneByWorkspace;
      writePaneState(tabs, state.paneWidth);
      return {
        rightTab: "panel",
        panelShown: true,
        paneView: "split",
        paneTab: pane,
        paneByWorkspace: tabs,
        terminalPane,
        terminalPaneByWorkspace: state.workspaceId
          ? { ...state.terminalPaneByWorkspace, [state.workspaceId]: terminalPane }
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
      const tabs = state.workspaceId
        ? { ...state.paneByWorkspace, [state.workspaceId]: tab }
        : state.paneByWorkspace;
      writePaneState(tabs, state.paneWidth);
      const terminalPane = terminal ?? state.terminalPane;
      return {
        // 收起态才展开；占满视图（expanded）保持不变。
        paneView: state.paneView === "hidden" ? ("split" as const) : state.paneView,
        paneTab: tab,
        paneByWorkspace: tabs,
        terminalPane,
        terminalPaneByWorkspace:
          terminal && state.workspaceId
            ? { ...state.terminalPaneByWorkspace, [state.workspaceId]: terminal }
            : state.terminalPaneByWorkspace,
        // 旧入口仍在读这两个标记，保持一致。
        rightTab: "panel" as const,
        panelShown: true,
        panelOpen: true,
      };
    }),
  setPaneTab: (tab) =>
    set((state) => {
      const tabs = state.workspaceId
        ? { ...state.paneByWorkspace, [state.workspaceId]: tab }
        : state.paneByWorkspace;
      writePaneState(tabs, state.paneWidth);
      return { paneTab: tab, paneByWorkspace: tabs };
    }),
  setPaneView: (view) =>
    set({
      paneView: view,
      // `rightTab` / `panelShown` 是旧入口仍在读的两个标记，保持一致。
      rightTab: view === "hidden" ? null : "panel",
      panelShown: view !== "hidden",
      panelOpen: true,
    }),
  setPaneWidth: (width) =>
    set((state) => {
      const next = Math.min(720, Math.max(300, Math.round(width)));
      writePaneState(state.paneByWorkspace, next);
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
      const next: ChatPrefs = { ...state.chatPrefs, context };
      const map = state.workspaceId
        ? { ...state.chatPrefsByWorkspace, [state.workspaceId]: next }
        : state.chatPrefsByWorkspace;
      writeChatPrefs(map);
      return { chatPrefs: next, chatPrefsByWorkspace: map };
    }),
  setOutputStyle: (output) =>
    set((state) => {
      const next: ChatPrefs = { ...state.chatPrefs, output };
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
  setModelSetting: (key, patch) =>
    set((state) => {
      const current = state.modelSettings[key] ?? DEFAULT_MODEL_SETTING;
      const map = { ...state.modelSettings, [key]: { ...current, ...patch } };
      writeModelSettings(map);
      return { modelSettings: map };
    }),
  setExecuting: (executing) => set({ executing }),
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
    const previous = get().tasks[task.id];
    set((state) => ({
      tasks: { ...state.tasks, [task.id]: task },
      taskVersions: { ...state.taskVersions, [task.id]: (state.taskVersions[task.id] ?? 0) + 1 },
    }));

    // 任务进入终态时弹一条桌面通知：用户可能已经退出超能、窗口在后台。
    // 只在"第一次进入终态"时发，避免重放历史/重复事件刷屏。
    const terminal = task.status === "done" || task.status === "failed";
    const wasTerminal =
      previous?.status === "done" ||
      previous?.status === "failed" ||
      previous?.status === "cancelled";
    if (!terminal || wasTerminal) return;

    pushDesktopNotification({
      id: `extreme-${task.id}`,
      tone: task.status === "done" ? "success" : "danger",
      source: "超能模式",
      time: "刚刚",
      title: task.title,
      body:
        task.result ||
        (task.status === "done"
          ? "任务已执行完成，点击回到超能模式查看结果。"
          : "任务执行失败，点击回到超能模式查看详情。"),
      durationMs: 9000,
      action: task.serverId
        ? { kind: "extreme", serverId: task.serverId, server: task.server }
        : { kind: "none" },
    });
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
  // 失败**不再静默**：把原因放回 store，由界面明确提示"重启后可能丢失"。
  const error = writeWorkspaces(captureWorkspace(useExtremeStore.getState()));
  if (error) console.warn("[extreme] 本地历史保存失败：", error);
  if (useExtremeStore.getState().historyError !== error) {
    useExtremeStore.setState({ historyError: error });
  }
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
