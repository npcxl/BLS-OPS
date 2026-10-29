import { useEffect } from "react";
import { useDomainStore } from "@/stores/domain-store";
import {
  comboFromEvent,
  useShortcutBindings,
  type ShortcutActionId,
} from "@/stores/shortcut-store";
import { useWorkbenchStore } from "@/stores/workbench-store";

/**
 * 全局快捷键 —— 键位来自 `shortcut-store`，用户可以在设置里改或关掉。
 *
 * 默认：
 * Ctrl + K          命令面板
 * Ctrl + Shift + P  命令面板（动作）
 * Ctrl + T          新建终端标签
 * Ctrl + Shift + T  重开最近一次会话
 * Ctrl + W          关闭当前标签
 * Ctrl + \          垂直分屏
 * Ctrl + J          AI 模块
 * Ctrl + B          折叠 / 展开侧栏
 * Ctrl + `          新建终端
 *
 * 输入框里只认命令面板类动作：用户正在打字时按 Ctrl+B 不该把侧栏收起来。
 */
export function useGlobalShortcuts() {
  const bindings = useShortcutBindings();

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      // 输入法组合中不抢键。
      if (event.isComposing) return;
      const combo = comboFromEvent(event);
      if (!combo) return;

      const id = (Object.keys(bindings) as ShortcutActionId[]).find(
        (action) => bindings[action] === combo,
      );
      if (!id) return;

      const target = event.target;
      const inEditable =
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        (target instanceof HTMLElement && target.isContentEditable);
      if (inEditable && id !== "command_palette" && id !== "action_palette") return;

      event.preventDefault();
      runShortcut(id);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [bindings]);
}

function runShortcut(id: ShortcutActionId): void {
  const workbench = useWorkbenchStore.getState();
  switch (id) {
    case "command_palette":
    case "action_palette":
      workbench.setCommandPaletteOpen(true);
      return;
    case "new_terminal":
      workbench.openTab({ id: crypto.randomUUID(), type: "terminal", title: "New Terminal" });
      return;
    case "new_terminal_tab":
      workbench.openTab({ id: crypto.randomUUID(), type: "terminal", title: "Terminal" });
      return;
    case "reopen_session": {
      // 重开最近一次连接过的服务器（会话记录来自 SQLite）。
      const last = useDomainStore.getState().sessions.find((session) => session.server_id);
      if (!last) return;
      workbench.openTab({
        id: crypto.randomUUID(),
        type: "terminal",
        title: last.server_name,
        subtitle: `${last.server_host}:${last.server_port}`,
        serverId: last.server_id,
        sessionId: crypto.randomUUID(),
      });
      return;
    }
    case "close_tab": {
      const paneId = workbench.focusedPaneId;
      if (!paneId) return;
      const pane = findPane(workbench.rootPane, paneId);
      if (pane?.activeTabId) workbench.closeTab(paneId, pane.activeTabId);
      return;
    }
    case "split_pane":
      if (workbench.focusedPaneId) workbench.splitPane(workbench.focusedPaneId, "vertical");
      return;
    case "ai_panel":
      workbench.openModuleTab("ai");
      return;
    case "toggle_sidebar":
      workbench.toggleSidebar();
      return;
  }
}

function findPane(root: any, id: string): any {
  if (!root) return null;
  if (root.id === id) return root;
  for (const child of root.children ?? []) {
    const found = findPane(child, id);
    if (found) return found;
  }
  return null;
}
