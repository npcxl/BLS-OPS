/**
 * 会话的 MCP 能力勾选：按 `workspaceId + serverId` 独立保存。
 *
 * 只存**用户显式做过的选择**（`true/false`）；没出现过的项跟随默认值。
 * 这样重连、重新探测、返回会话时，用户取消过的项仍然是取消的；换服务器
 * 则是另一份记录。能力 ID 形如 `builtin:docker` / `mcp:<连接实例 id>`。
 */
import { create } from "zustand";

const STORAGE_KEY = "bls-ops.extreme-mcp-selection.v1";

type ChoiceMap = Record<string, boolean>;
type State = {
  bySession: Record<string, ChoiceMap>;
  setChoice: (sessionKey: string, id: string, on: boolean) => void;
  resetSession: (sessionKey: string) => void;
};

function read(): Record<string, ChoiceMap> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, ChoiceMap>;
    if (!parsed || typeof parsed !== "object") return {};
    const out: Record<string, ChoiceMap> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (!value || typeof value !== "object") continue;
      out[key] = Object.fromEntries(
        Object.entries(value).filter(([, on]) => typeof on === "boolean"),
      );
    }
    return out;
  } catch {
    return {};
  }
}

function write(bySession: Record<string, ChoiceMap>) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(bySession));
  } catch {
    // 存不了只在本次运行内生效。
  }
}

export function mcpSessionKey(workspaceId: string | null, serverId: string | null): string {
  return `${workspaceId ?? "no-workspace"}|${serverId ?? "no-server"}`;
}

export const useExtremeMcpSelection = create<State>((set) => ({
  bySession: read(),
  setChoice: (sessionKey, id, on) =>
    set((state) => {
      const next = {
        ...state.bySession,
        [sessionKey]: { ...(state.bySession[sessionKey] ?? {}), [id]: on },
      };
      write(next);
      return { bySession: next };
    }),
  resetSession: (sessionKey) =>
    set((state) => {
      const next = { ...state.bySession };
      delete next[sessionKey];
      write(next);
      return { bySession: next };
    }),
}));

/** 显式选择优先；否则跟随默认。 */
export function chosen(
  state: Pick<State, "bySession">,
  sessionKey: string,
  id: string,
  defaultOn: boolean,
): boolean {
  return state.bySession[sessionKey]?.[id] ?? defaultOn;
}
