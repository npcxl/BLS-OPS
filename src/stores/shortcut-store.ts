/**
 * 可自定义的全局快捷键。
 *
 * 只覆盖**应用级动作**（命令面板、新终端、关标签、分屏…）。编辑器里的
 * Ctrl+S / Ctrl+F、文件面板的 F2 这类属于上下文快捷键，改了会和编辑器内置
 * 键位打架，因此不放进这张表。
 *
 * 绑定用规范化字符串表示：`"ctrl+shift+p"`。`null` 表示用户关掉了这一条。
 * 存在 localStorage：跟着人走，不随服务器同步。
 */
import { useSyncExternalStore } from "react";

export type ShortcutActionId =
  // 全局
  | "command_palette"
  | "action_palette"
  | "new_terminal"
  | "reopen_session"
  | "close_tab"
  | "split_pane"
  | "ai_panel"
  | "toggle_sidebar"
  | "new_terminal_tab"
  // 文件面板
  | "file_open"
  | "file_rename"
  | "file_delete"
  | "file_up"
  // 编辑器
  | "editor_save"
  | "editor_find";

export type ShortcutBindings = Record<ShortcutActionId, string | null>;

export const DEFAULT_BINDINGS: ShortcutBindings = {
  command_palette: "ctrl+k",
  action_palette: "ctrl+shift+p",
  new_terminal: "ctrl+t",
  reopen_session: "ctrl+shift+t",
  close_tab: "ctrl+w",
  split_pane: "ctrl+\\",
  ai_panel: "ctrl+j",
  toggle_sidebar: "ctrl+b",
  new_terminal_tab: "ctrl+`",
  file_open: "enter",
  file_rename: "f2",
  file_delete: "delete",
  file_up: "backspace",
  editor_save: "ctrl+s",
  editor_find: "ctrl+f",
};

/** 没有修饰键也允许的编辑键：它们是"就地操作"，不会抢文字输入。 */
const NAMED_KEYS = new Set([
  "enter",
  "escape",
  "tab",
  "delete",
  "backspace",
  "insert",
  "home",
  "end",
  "pageup",
  "pagedown",
  "arrowup",
  "arrowdown",
  "arrowleft",
  "arrowright",
]);

const STORAGE_KEY = "blsops.shortcuts";

const listeners = new Set<() => void>();

function read(): ShortcutBindings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_BINDINGS };
    const stored = JSON.parse(raw) as Partial<ShortcutBindings>;
    // 只认已知动作：旧版本删掉的动作不该残留，缺的字段回退默认值。
    const merged = { ...DEFAULT_BINDINGS };
    for (const id of Object.keys(DEFAULT_BINDINGS) as ShortcutActionId[]) {
      if (id in stored) merged[id] = stored[id] ?? null;
    }
    return merged;
  } catch {
    return { ...DEFAULT_BINDINGS };
  }
}

let bindings: ShortcutBindings = read();

function persist(): void {
  try {
    // 只存与默认值不同的项：以后调整默认快捷键时，没改过的用户会跟着更新。
    const changed: Partial<ShortcutBindings> = {};
    for (const id of Object.keys(DEFAULT_BINDINGS) as ShortcutActionId[]) {
      if (bindings[id] !== DEFAULT_BINDINGS[id]) changed[id] = bindings[id];
    }
    if (Object.keys(changed).length === 0) localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, JSON.stringify(changed));
  } catch {
    // 存不进去只影响下次启动，不影响本次会话。
  }
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function shortcutBindings(): ShortcutBindings {
  return bindings;
}

export function useShortcutBindings(): ShortcutBindings {
  return useSyncExternalStore(subscribe, shortcutBindings, shortcutBindings);
}

export type SetShortcutResult =
  | { ok: true }
  /** 这个组合已经被另一个动作占用（`owner` 就是它）。 */
  | { ok: false; conflict: ShortcutActionId };

/**
 * 绑定 / 解绑一个动作。
 *
 * 同一组合不允许给两个动作：按下去到底执行哪个是随机的，比没绑定更糟。
 */
export function setShortcut(id: ShortcutActionId, combo: string | null): SetShortcutResult {
  if (combo) {
    for (const other of Object.keys(bindings) as ShortcutActionId[]) {
      if (other !== id && bindings[other] === combo) return { ok: false, conflict: other };
    }
  }
  bindings = { ...bindings, [id]: combo };
  persist();
  return { ok: true };
}

export function resetShortcuts(): void {
  bindings = { ...DEFAULT_BINDINGS };
  persist();
}

/**
 * 把一次按键规范化成绑定字符串。
 *
 * 规则：
 * - 只按修饰键（Ctrl / Shift / Alt / Meta）返回 `null`，那不是完整组合；
 * - 没有修饰键时只接受功能键（F1–F24）—— 单字母做全局快捷键会在用户打字时抢键；
 * - 修饰键顺序固定为 ctrl → alt → shift → meta，保证比较稳定。
 */
export function comboFromEvent(event: KeyboardEvent): string | null {
  const key = event.key;
  if (["Control", "Shift", "Alt", "Meta", "CapsLock"].includes(key)) return null;

  const parts: string[] = [];
  if (event.ctrlKey) parts.push("ctrl");
  if (event.altKey) parts.push("alt");
  if (event.shiftKey) parts.push("shift");
  if (event.metaKey) parts.push("meta");

  const normalized = key === " " ? "space" : key.toLowerCase();
  const isFunctionKey = /^f([1-9]|1[0-9]|2[0-4])$/.test(normalized);
  // 单字母必须带修饰键（否则打字就被抢）；功能键与 Enter / Delete 这类
  // "编辑键"本身没有文本输入语义，允许单独绑定。
  if (parts.length === 0 && !isFunctionKey && !NAMED_KEYS.has(normalized)) return null;
  parts.push(normalized);
  return parts.join("+");
}

/** 绑定字符串 → 展示用的按键标签（macOS 上 Ctrl 显示成 ⌘ 由调用方决定）。 */
export function comboKeys(combo: string): string[] {
  return combo.split("+").map((part) => {
    switch (part) {
      case "ctrl":
        return "Ctrl";
      case "alt":
        return "Alt";
      case "shift":
        return "Shift";
      case "meta":
        return "Meta";
      case "space":
        return "Space";
      case "\\":
        return "\\";
      default:
        // 单字符大写（字母键），单词键首字母大写（Enter / Delete / F2）。
        return part.charAt(0).toUpperCase() + part.slice(1);
    }
  });
}
