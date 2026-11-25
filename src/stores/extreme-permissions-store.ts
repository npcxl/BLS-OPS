/**
 * 超能模式的权限与备份策略（跨会话记住）。
 *
 * 两层：
 * * `defaultMode` —— 新任务的默认值；
 * * `byWorkspace` —— 当前任务的覆盖（权限页 / 输入区都能改）。
 *
 * 备份策略是全局的；真正执行仍由后端按请求快照校验，前端只负责收集。
 */
import { create } from "zustand";
import {
  DEFAULT_BACKUP_POLICY,
  type BackupPolicy,
  type PermissionMode,
} from "@/workbench/views/terminal/extreme-core/permissions";

const STORAGE_KEY = "bls-ops.extreme-permissions.v1";
/** 2 = 三档权限语义；旧版的 "readonly" 实际是"按需确认"。 */
const STORAGE_VERSION = 2;

const MODES: PermissionMode[] = ["readonly", "ask", "full"];

type Stored = {
  version: number;
  defaultMode: PermissionMode;
  byWorkspace: Record<string, PermissionMode>;
  backup: BackupPolicy;
  /** 允许 Agent 使用 sudo（独立于三档；只读模式下仍然禁用）。 */
  allowSudo: boolean;
};

function normalizeMode(value: unknown, fallback: PermissionMode): PermissionMode {
  return typeof value === "string" && MODES.includes(value as PermissionMode)
    ? (value as PermissionMode)
    : fallback;
}

function readStored(): Stored {
  const fallback: Stored = {
    version: STORAGE_VERSION,
    defaultMode: "ask",
    byWorkspace: {},
    backup: { ...DEFAULT_BACKUP_POLICY },
    allowSudo: true,
  };
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw) as Partial<Stored>;
    /*
     * 兼容迁移：旧版的 "readonly" 在界面上写着"改动才请你确认一次"，
     * 实际行为是按需确认。按真实含义迁到 ask；新版用户显式选的只读
     * 在写入 version=2 后不会再被改。
     */
    // 缺 version（NaN）也必须算旧版：`NaN < 2` 是 false，不能只做大小比较。
    const version = Number(parsed.version);
    const legacy = !Number.isFinite(version) || version < STORAGE_VERSION;
    const migrate = (mode: PermissionMode): PermissionMode =>
      legacy && mode === "readonly" ? "ask" : mode;
    const byWorkspace: Record<string, PermissionMode> = {};
    for (const [id, mode] of Object.entries(parsed.byWorkspace ?? {})) {
      if (id && typeof mode === "string" && MODES.includes(mode as PermissionMode)) {
        byWorkspace[id] = migrate(mode as PermissionMode);
      }
    }
    const backup = parsed.backup ?? DEFAULT_BACKUP_POLICY;
    const retention = Number(backup.retentionDays);
    return {
      version: STORAGE_VERSION,
      defaultMode: migrate(normalizeMode(parsed.defaultMode, "ask")),
      byWorkspace,
      allowSudo: parsed.allowSudo !== false,
      backup: {
        beforeWrite: backup.beforeWrite !== false,
        beforeDelete: backup.beforeDelete !== false,
        retentionDays:
          Number.isFinite(retention) && retention >= 0
            ? Math.round(retention)
            : DEFAULT_BACKUP_POLICY.retentionDays,
      },
    };
  } catch {
    return fallback;
  }
}

function writeStored(state: Stored) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // 存不了就只在本次会话里生效。
  }
}

export interface ExtremePermissionsState extends Stored {
  setDefaultMode: (mode: PermissionMode) => void;
  setWorkspaceMode: (workspaceId: string, mode: PermissionMode) => void;
  resetWorkspaceMode: (workspaceId: string) => void;
  setBackup: (patch: Partial<BackupPolicy>) => void;
  setAllowSudo: (allow: boolean) => void;
}

const initial = readStored();

export const useExtremePermissionsStore = create<ExtremePermissionsState>((set, get) => ({
  ...initial,
  setDefaultMode: (mode) => {
    const next = { ...get(), version: STORAGE_VERSION, defaultMode: mode };
    writeStored(next);
    set({ defaultMode: mode });
  },
  setWorkspaceMode: (workspaceId, mode) => {
    if (!workspaceId) return;
    const byWorkspace = { ...get().byWorkspace, [workspaceId]: mode };
    writeStored({ ...get(), version: STORAGE_VERSION, byWorkspace });
    set({ byWorkspace });
  },
  resetWorkspaceMode: (workspaceId) => {
    const byWorkspace = { ...get().byWorkspace };
    delete byWorkspace[workspaceId];
    writeStored({ ...get(), version: STORAGE_VERSION, byWorkspace });
    set({ byWorkspace });
  },
  setBackup: (patch) => {
    const backup = { ...get().backup, ...patch };
    writeStored({ ...get(), version: STORAGE_VERSION, backup });
    set({ backup });
  },
  setAllowSudo: (allowSudo) => {
    writeStored({ ...get(), version: STORAGE_VERSION, allowSudo });
    set({ allowSudo });
  },
}));

/** 这条任务最终生效的权限（任务覆盖优先）。 */
export function effectivePermission(
  state: Pick<ExtremePermissionsState, "defaultMode" | "byWorkspace">,
  workspaceId: string | null | undefined,
): PermissionMode {
  if (workspaceId && state.byWorkspace[workspaceId]) {
    return state.byWorkspace[workspaceId];
  }
  return state.defaultMode;
}
