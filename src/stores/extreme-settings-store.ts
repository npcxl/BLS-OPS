/**
 * 超能模式设置（不含模型/权限/MCP 数据）：
 * 默认对话偏好、计划卡、工具详情、通知、跟随与动效。
 *
 * 这些值只影响**超能模式**，并且都是“下一轮请求 / 下一次渲染”生效；
 * 模型、密钥仍在 `ai_provider_*`，权限在 `extreme-permissions-store`。
 */
import { create } from "zustand";
import type { ContextMode, OutputStyle } from "@/workbench/views/terminal/extreme-core/chat-context";
import type { EffortChoice } from "@/workbench/views/terminal/extreme-core/model-choice";

export type ReplyLanguage = "auto" | "zh" | "en";
export type PlanCardMode = "expand" | "collapsed";
export type ToolDetailMode = "collapsed" | "expanded";
export type MotionMode = "system" | "reduced";
export type NewTaskPane = "open" | "closed";

export interface NotificationSettings {
  enabled: boolean;
  approval: boolean;
  success: boolean;
  failed: boolean;
}

export interface ExtremeSettings {
  version: 1;
  defaultContext: ContextMode;
  defaultOutput: OutputStyle;
  replyLanguage: ReplyLanguage;
  /** 默认上下文预算（tokens）；`null` = 自动。 */
  defaultBudget: number | null;
  /** 默认思考档（新任务继承；`auto` = 供应商默认）。 */
  defaultEffort: EffortChoice;
  planCard: PlanCardMode;
  toolDetails: ToolDetailMode;
  notifications: NotificationSettings;
  followLatest: boolean;
  newTaskPane: NewTaskPane;
  motion: MotionMode;
}

export const DEFAULT_EXTREME_SETTINGS: ExtremeSettings = {
  version: 1,
  defaultContext: "session",
  defaultOutput: "auto",
  replyLanguage: "auto",
  defaultBudget: null,
  defaultEffort: "auto",
  planCard: "expand",
  toolDetails: "collapsed",
  notifications: { enabled: true, approval: true, success: true, failed: true },
  followLatest: true,
  newTaskPane: "open",
  motion: "system",
};

const STORAGE_KEY = "bls-ops.extreme-settings.v1";

const CONTEXTS: ContextMode[] = ["session", "only", "picked"];
const OUTPUTS: OutputStyle[] = ["auto", "brief", "detailed", "structured"];
const EFFORTS: EffortChoice[] = ["auto", "low", "medium", "high", "max"];

function normalize(raw: unknown): ExtremeSettings {
  const value = (raw ?? {}) as Partial<ExtremeSettings>;
  const notifications = (value.notifications ?? {}) as Partial<NotificationSettings>;
  return {
    version: 1,
    defaultContext: CONTEXTS.includes(value.defaultContext as ContextMode)
      ? (value.defaultContext as ContextMode)
      : DEFAULT_EXTREME_SETTINGS.defaultContext,
    defaultOutput: OUTPUTS.includes(value.defaultOutput as OutputStyle)
      ? (value.defaultOutput as OutputStyle)
      : DEFAULT_EXTREME_SETTINGS.defaultOutput,
    replyLanguage:
      value.replyLanguage === "zh" || value.replyLanguage === "en"
        ? value.replyLanguage
        : "auto",
    defaultBudget:
      typeof value.defaultBudget === "number" &&
      Number.isFinite(value.defaultBudget) &&
      value.defaultBudget >= 16 * 1024
        ? Math.round(value.defaultBudget)
        : null,
    defaultEffort: EFFORTS.includes(value.defaultEffort as EffortChoice)
      ? (value.defaultEffort as EffortChoice)
      : "auto",
    planCard: value.planCard === "collapsed" ? "collapsed" : "expand",
    toolDetails: value.toolDetails === "expanded" ? "expanded" : "collapsed",
    notifications: {
      // 缺字段按开启：升级前的用户没关过通知。
      enabled: notifications.enabled !== false,
      approval: notifications.approval !== false,
      success: notifications.success !== false,
      failed: notifications.failed !== false,
    },
    followLatest: value.followLatest !== false,
    newTaskPane: value.newTaskPane === "closed" ? "closed" : "open",
    motion: value.motion === "reduced" ? "reduced" : "system",
  };
}

function readStored(): ExtremeSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? normalize(JSON.parse(raw)) : DEFAULT_EXTREME_SETTINGS;
  } catch {
    return DEFAULT_EXTREME_SETTINGS;
  }
}

function writeStored(settings: ExtremeSettings) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // 存不了就只在内存里生效。
  }
}

interface ExtremeSettingsState extends ExtremeSettings {
  update: (patch: Partial<Omit<ExtremeSettings, "version">>) => void;
  setNotification: (patch: Partial<NotificationSettings>) => void;
  reset: () => void;
}

const initial = readStored();

export const useExtremeSettingsStore = create<ExtremeSettingsState>()((set, get) => ({
  ...initial,
  update: (patch) => {
    const next: ExtremeSettings = normalize({ ...get(), ...patch, version: 1 });
    writeStored(next);
    set(next);
  },
  setNotification: (patch) => {
    const next: ExtremeSettings = normalize({
      ...get(),
      notifications: { ...get().notifications, ...patch },
      version: 1,
    });
    writeStored(next);
    set(next);
  },
  reset: () => {
    writeStored(DEFAULT_EXTREME_SETTINGS);
    set({ ...DEFAULT_EXTREME_SETTINGS });
  },
}));

/** 通知是否允许发送某一类。 */
export function notificationAllowed(kind: "approval" | "success" | "failed"): boolean {
  const state = useExtremeSettingsStore.getState();
  if (!state.notifications.enabled) return false;
  return state.notifications[kind];
}
