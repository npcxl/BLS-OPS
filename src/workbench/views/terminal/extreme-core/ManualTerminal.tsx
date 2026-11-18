import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";

import {
  attachManualShell,
  detachManualShell,
  ensureManualShell,
} from "./manual-shell";

/**
 * 手动终端（「终端 › 手动终端」）。
 *
 * 真正的 PTY：`cd` 会延续、有提示符、支持交互式命令；走**独立的**一条
 * SSH shell 通道（`ssh_shell_open`），与主终端、AI 执行互不干扰。
 *
 * 组件只负责挂载 DOM：xterm 实例和 SSH 通道存在 `manual-shell.ts` 里，
 * 切标签卸载组件不会丢输入与回显，切回来直接接着用。
 */
export function ManualTerminal({
  workspaceId,
  sessionId,
}: {
  workspaceId: string | null;
  sessionId: string | null;
}) {
  const { t } = useTranslation();
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!workspaceId || !sessionId) return undefined;
    const container = ref.current;
    if (!container) return undefined;

    let alive = true;
    void ensureManualShell(workspaceId, sessionId).then(() => {
      if (alive && ref.current) attachManualShell(workspaceId, ref.current);
    });

    return () => {
      alive = false;
      if (container) detachManualShell(workspaceId, container);
    };
  }, [workspaceId, sessionId]);

  if (!sessionId) {
    return (
      <p className="px-3 py-2 text-11 text-fg-subtle">
        {t("服务器未连接：重新连接后才能使用手动终端。")}
      </p>
    );
  }

  return (
    <div
      ref={ref}
      className="min-h-0 flex-1 overflow-hidden px-1 py-1 [&_.xterm]:h-full [&_.xterm-viewport]:!bg-transparent"
    />
  );
}
