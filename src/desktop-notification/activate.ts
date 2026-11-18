/**
 * 通知点击 → 主窗口动作。
 *
 * 通知窗口只把 `action` 转给主窗口（`desktop-notification:activate`），
 * 真正要做什么集中在这里：
 * - `update`：直接开始下载并安装更新；
 * - `extreme`：回到超能模式那条对话（连接还在就重新进入，不在就打开历史）。
 *
 * 监听是全局单例：重复挂载只装一次，避免一次点击执行多次。
 */
import { listen } from "@tauri-apps/api/event";

import type { DesktopNotificationAction } from "@/desktop-notification/bridge";
import { useExtremeStore } from "@/stores/extreme-store";
import { useUpdaterStore } from "@/stores/updater-store";

interface ActivationPayload {
  id: string;
  action?: DesktopNotificationAction | null;
}

let installed = false;

export function ensureNotificationActivation(): void {
  if (installed) return;
  installed = true;

  void listen<ActivationPayload>("desktop-notification:activate", (event) => {
    const action = event.payload.action;
    if (!action) return;

    switch (action.kind) {
      case "update": {
        // `install()` 自己会去重（正在下载/安装时直接返回）。
        void useUpdaterStore.getState().install();
        break;
      }
      case "extreme": {
        const state = useExtremeStore.getState();
        const connection = action.serverId
          ? state.connections[action.serverId]
          : undefined;
        if (connection && action.server) {
          state.enter(
            action.serverId,
            action.server,
            connection.sessionId,
            connection.host,
          );
        } else {
          // 连接已经不在：至少把超能页打开，让用户看那条对话的历史。
          useExtremeStore.setState({ active: true });
        }
        break;
      }
      default:
        break;
    }
  }).catch((error) => {
    console.warn("[desktop-notification] activate listener failed", error);
  });
}
