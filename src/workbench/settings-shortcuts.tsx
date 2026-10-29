/**
 * 设置页 · 快捷键一览。
 *
 * 分 tab + 固定高度滚动：全局组合 30 多条，平铺会把设置页拉得很长。
 *
 * **应用级动作可以改键**（`shortcut-store`）：点行尾的铅笔进入录制，按下新组合
 * 即生效；Esc 取消，Backspace/Delete 关掉这一条。上下文快捷键（编辑器 Ctrl+S、
 * 文件面板 F2 等）只展示 —— 它们和编辑器内置键位绑定，改了会互相打架。
 */
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Pencil } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/cn";
import { opsApi } from "@/api/ops-api";
import {
  DEFAULT_BINDINGS,
  comboFromEvent,
  comboKeys,
  resetShortcuts,
  setShortcut,
  useShortcutBindings,
  type ShortcutActionId,
} from "@/stores/shortcut-store";
import { Group, ListGroup } from "./settings-parts";

/** `Ctrl` 在 macOS 上显示成 ⌘；`mod` 是占位符，渲染时替换。 */
const MOD = "mod";

interface ShortcutItem {
  /** 展示用键位；有 `action` 时以用户绑定为准。 */
  keys?: string[];
  action?: ShortcutActionId;
  label: string;
}

interface ShortcutTab {
  id: string;
  label: string;
  items: ShortcutItem[];
}

/** 可自定义的动作：标签同时用作冲突提示里的动作名。 */
const BINDABLE: { action: ShortcutActionId; label: string }[] = [
  { action: "command_palette", label: "Command palette" },
  { action: "action_palette", label: "Command palette (actions)" },
  { action: "new_terminal", label: "New terminal tab" },
  { action: "reopen_session", label: "Reopen the most recent session" },
  { action: "close_tab", label: "Close the current tab" },
  { action: "split_pane", label: "Split the pane vertically" },
  { action: "ai_panel", label: "Open the AI module" },
  { action: "toggle_sidebar", label: "Collapse or expand the sidebar" },
  { action: "new_terminal_tab", label: "New terminal" },
];

/** 文件面板：键位直接生效于面板本身，可以改。 */
const FILE_BINDABLE: { action: ShortcutActionId; label: string }[] = [
  { action: "file_open", label: "Open the selected entry" },
  { action: "file_rename", label: "Rename in place" },
  { action: "file_delete", label: "Move the selected entry to the recycle bin" },
  { action: "file_up", label: "Go up one directory" },
];

/** 编辑器：保存与查找读同一张绑定表。 */
const EDITOR_BINDABLE: { action: ShortcutActionId; label: string }[] = [
  { action: "editor_save", label: "Save (editor, server form, database edits)" },
  { action: "editor_find", label: "Find in the editor or preview" },
];

const ACTION_LABEL = Object.fromEntries(
  [...BINDABLE, ...FILE_BINDABLE, ...EDITOR_BINDABLE].map((item) => [item.action, item.label]),
) as Record<ShortcutActionId, string>;

const TABS: ShortcutTab[] = [
  {
    id: "global",
    label: "Global",
    items: [
      ...BINDABLE.map((item) => ({ action: item.action, label: item.label })),
      { keys: ["↑", "↓"], label: "Move through a list, menu or palette" },
      { keys: ["Enter"], label: "Run the highlighted entry" },
      { keys: ["Esc"], label: "Close a dialog, menu or search box" },
    ],
  },
  {
    id: "terminal",
    label: "Terminal",
    items: [
      { keys: ["Shift", "Insert"], label: "Paste into the terminal" },
      { keys: [MOD, "Enter"], label: "Accept the highlighted completion and run it" },
      { keys: ["↑", "↓"], label: "Move through completion candidates" },
      { keys: ["Enter"], label: "Accept the highlighted completion" },
      { keys: ["→"], label: "Accept the highlighted completion (without running)" },
      { keys: ["Esc"], label: "Dismiss the completion list" },
      { keys: ["←"], label: "Dismiss the completion list" },
    ],
  },
  {
    id: "files",
    label: "File panel",
    items: FILE_BINDABLE.map((item) => ({ action: item.action, label: item.label })),
  },
  {
    id: "editor",
    label: "Editors",
    items: [
      ...EDITOR_BINDABLE.map((item) => ({ action: item.action, label: item.label })),
      { keys: [MOD, "H"], label: "Toggle replace in the search box" },
      { keys: ["Enter"], label: "Next match in the search box" },
      { keys: ["Shift", "Enter"], label: "Previous match in the search box" },
      { keys: ["Esc"], label: "Close a dialog, menu or search box" },
    ],
  },
  {
    id: "database",
    label: "Database",
    items: [
      { keys: [MOD, "Enter"], label: "Run the selection or current statement" },
      { keys: [MOD, "Shift", "Enter"], label: "Run the whole script" },
      { keys: [MOD, "Shift", "F"], label: "Format SQL" },
      { keys: [MOD, "S"], label: "Submit pending row changes" },
      { keys: [MOD, "C"], label: "Copy the selected cells" },
      { keys: [MOD, "V"], label: "Paste into the grid" },
      { keys: [MOD, "A"], label: "Select all cells" },
      { keys: [MOD, "Z"], label: "Undo a cell edit" },
      { keys: [MOD, "Y"], label: "Redo a cell edit" },
      { keys: [MOD, "Home"], label: "Jump to the first row" },
      { keys: [MOD, "End"], label: "Jump to the last row" },
      { keys: ["F2"], label: "Edit the selected cell" },
      { keys: ["Enter"], label: "Edit the cell, then move down" },
      { keys: ["Tab"], label: "Commit and move right" },
      { keys: ["Shift", "Tab"], label: "Commit and move left" },
      { keys: ["Esc"], label: "Cancel the cell edit" },
      { keys: ["↑", "↓", "←", "→"], label: "Move through the asset tree" },
      { keys: ["Enter"], label: "Open the focused tree entry" },
      { keys: ["Space"], label: "Select the focused tree entry" },
    ],
  },
];

export function ShortcutSettingsGroup() {
  const { t } = useTranslation();
  const bindings = useShortcutBindings();
  const [active, setActive] = useState(TABS[0].id);
  const [recording, setRecording] = useState<ShortcutActionId | null>(null);
  const [error, setError] = useState<string | null>(null);
  const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
  const renderKey = (key: string) => (key === MOD ? (isMac ? "⌘" : "Ctrl") : key);
  // 快捷键独立窗口里不再显示"在新窗口打开"（点了只会聚焦自己）。
  const standalone = window.__BLS_VIEW__ === "shortcuts";
  const tab = TABS.find((item) => item.id === active) ?? TABS[0];
  const changed = (Object.keys(DEFAULT_BINDINGS) as ShortcutActionId[]).some(
    (id) => bindings[id] !== DEFAULT_BINDINGS[id],
  );

  // 录制期间在捕获阶段拦键：不让组合键被下面的快捷键处理器抢走。
  useEffect(() => {
    if (!recording) return;
    const onKeyDown = (event: KeyboardEvent) => {
      event.preventDefault();
      event.stopPropagation();
      if (event.key === "Escape") {
        setRecording(null);
        setError(null);
        return;
      }
      if (event.key === "Backspace" || event.key === "Delete") {
        // 关掉这一条：不是"没设置"，而是明确不想用快捷键。
        setShortcut(recording, null);
        setRecording(null);
        setError(null);
        return;
      }
      const combo = comboFromEvent(event);
      if (!combo) return;
      const result = setShortcut(recording, combo);
      if (!result.ok) {
        setError(
          t("{{combo}} 已被「{{action}}」占用，换一个组合", {
            combo,
            action: t(ACTION_LABEL[result.conflict]),
          }),
        );
        return;
      }
      setRecording(null);
      setError(null);
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [recording, t]);

  const keysOf = (item: ShortcutItem): string[] => {
    if (!item.action) return item.keys ?? [];
    const bound = bindings[item.action];
    return bound ? comboKeys(bound) : [];
  };

  return (
    <Group
      title={t("Keyboard shortcuts")}
      hint={t("All shortcuts, grouped by context.")}
    >
      <ListGroup>
        <div className="flex items-center gap-0.5 border-b border-line/60 px-2 py-1.5">
          {TABS.map((item) => (
            <button
              key={item.id}
              type="button"
              aria-pressed={active === item.id}
              onClick={() => setActive(item.id)}
              className={cn(
                "rounded-[6px] px-2 py-1 text-11 transition-colors",
                active === item.id
                  ? "bg-tab-active text-fg"
                  : "text-fg-muted hover:bg-tab-hover hover:text-fg",
              )}
            >
              {t(item.label)}
            </button>
          ))}
          <div className="ml-auto flex shrink-0 items-center gap-1">
            {changed && (
              <Button
                variant="ghost"
                size="xs"
                className="h-6 px-1.5"
                onClick={() => {
                  resetShortcuts();
                  setRecording(null);
                  setError(null);
                }}
              >
                {t("Reset")}
              </Button>
            )}
            {!standalone && (
              <Button
                variant="ghost"
                size="xs"
                className="h-6 px-1.5"
                onClick={() => void opsApi.openShortcutsWindow()}
              >
                {t("Open in new window")}
              </Button>
            )}
          </div>
        </div>

        {/* 固定高度 + 滚动：30 多条平铺会把整页拉长，也找不到重点。 */}
        <div className="h-[286px] overflow-y-auto px-3 py-2">
          {error && <p className="mb-1.5 text-11 text-danger">{error}</p>}
          <div className="flex flex-col gap-1">
            {tab.items.map((item) => {
              const keys = keysOf(item);
              const isRecording = item.action !== undefined && recording === item.action;
              return (
                <div
                  key={`${tab.id}-${item.label}`}
                  className="group flex min-h-[22px] items-center justify-between gap-3 text-11"
                >
                  <span className="min-w-0 truncate text-fg-muted">{t(item.label)}</span>
                  <span className="flex shrink-0 items-center gap-1">
                    {isRecording ? (
                      <span className="text-11 text-accent">
                        {t("Press the new combination… (Esc cancels, Backspace clears)")}
                      </span>
                    ) : keys.length > 0 ? (
                      keys.map((key) => (
                        <kbd
                          key={key}
                          className="rounded-[4px] border border-line bg-surface-2 px-1.5 py-0.5 font-mono text-10 text-fg-muted"
                        >
                          {renderKey(key)}
                        </kbd>
                      ))
                    ) : (
                      <span className="text-10 text-fg-subtle">{t("Not set")}</span>
                    )}
                    {item.action && !isRecording && (
                      <button
                        type="button"
                        aria-label={t("Change shortcut")}
                        title={t("Change shortcut")}
                        onClick={() => {
                          setRecording(item.action ?? null);
                          setError(null);
                        }}
                        className="rounded-[4px] p-0.5 text-fg-subtle opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100 hover:bg-surface-hover hover:text-fg"
                      >
                        <Pencil size={11} />
                      </button>
                    )}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      </ListGroup>
    </Group>
  );
}
