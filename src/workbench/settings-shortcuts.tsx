/**
 * 设置页 · 快捷键一览。
 *
 * 只列**真实实现**的键位（来源：`hooks/use-global-shortcuts.ts`、终端补全、
 * 文件面板、编辑器、数据库网格各自的 onKeyDown）。不写"计划中"或"应该支持"
 * 的组合 —— 一份会骗人的快捷键表比没有更糟。
 *
 * 分 tab + 固定高度滚动：全局组合 30 多条，平铺会把设置页拉得非常长。
 */
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/cn";
import { opsApi } from "@/api/ops-api";
import { Group, ListGroup } from "./settings-parts";

/** `Ctrl` 在 macOS 上显示成 ⌘；`mod` 是占位符，渲染时替换。 */
const MOD = "mod";

interface ShortcutItem {
  keys: string[];
  label: string;
}

interface ShortcutTab {
  id: string;
  label: string;
  items: ShortcutItem[];
}

const TABS: ShortcutTab[] = [
  {
    id: "global",
    label: "Global",
    items: [
      { keys: [MOD, "K"], label: "Command palette" },
      { keys: [MOD, "Shift", "P"], label: "Command palette (actions)" },
      { keys: [MOD, "T"], label: "New terminal tab" },
      { keys: [MOD, "Shift", "T"], label: "Reopen the most recent session" },
      { keys: [MOD, "W"], label: "Close the current tab" },
      { keys: [MOD, "\\"], label: "Split the pane vertically" },
      { keys: [MOD, "J"], label: "Open the AI module" },
      { keys: [MOD, "B"], label: "Collapse or expand the sidebar" },
      { keys: [MOD, "`"], label: "New terminal" },
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
    items: [
      { keys: ["Enter"], label: "Open the selected entry" },
      { keys: ["F2"], label: "Rename in place" },
      { keys: ["Delete"], label: "Move the selected entry to the recycle bin" },
      { keys: ["Backspace"], label: "Go up one directory" },
    ],
  },
  {
    id: "editor",
    label: "Editors",
    items: [
      { keys: [MOD, "S"], label: "Save (editor, server form, database edits)" },
      { keys: [MOD, "F"], label: "Find in the editor or preview" },
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
  const [active, setActive] = useState(TABS[0].id);
  const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
  const renderKey = (key: string) => (key === MOD ? (isMac ? "⌘" : "Ctrl") : key);
  // 快捷键独立窗口里不再显示"在新窗口打开"（点了只会聚焦自己）。
  const standalone = new URLSearchParams(window.location.search).get("view") === "shortcuts";
  const tab = TABS.find((item) => item.id === active) ?? TABS[0];

  return (
    <Group
      title={t("Keyboard shortcuts")}
      hint={t("Every shortcut in the app, grouped by where you use it.")}
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
          {!standalone && (
            <Button
              variant="ghost"
              size="xs"
              className="ml-auto h-6 shrink-0 px-1.5"
              onClick={() => void opsApi.openShortcutsWindow()}
            >
              {t("Open in new window")}
            </Button>
          )}
        </div>

        {/* 固定高度 + 滚动：30 多条平铺会把整页拉长，也找不到重点。 */}
        <div className="h-[286px] overflow-y-auto px-3 py-2">
          <div className="flex flex-col gap-1">
            {tab.items.map((item) => (
              <div
                key={`${tab.id}-${item.label}`}
                className="flex items-center justify-between gap-3 text-11"
              >
                <span className="min-w-0 truncate text-fg-muted">{t(item.label)}</span>
                <span className="flex shrink-0 items-center gap-1">
                  {item.keys.map((key) => (
                    <kbd
                      key={key}
                      className="rounded-[4px] border border-line bg-surface-2 px-1.5 py-0.5 font-mono text-10 text-fg-muted"
                    >
                      {renderKey(key)}
                    </kbd>
                  ))}
                </span>
              </div>
            ))}
          </div>
        </div>
      </ListGroup>
    </Group>
  );
}
