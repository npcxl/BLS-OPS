import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { opsApi, toErrorMessage } from "@/api/ops-api";
import type { Phase } from "./terminal-phase";

const KEEPALIVE_MS = 30_000;
/** Consecutive failed probes before the session is declared dead. */
const KEEPALIVE_MAX_FAILURES = 2;

/**
 * 会话存活探测。
 *
 * 只在**真的连着**的时候跑：连续失败达到阈值就判定连接已经断了 ——
 * 服务端可能早就关掉了，UI 不能继续显示一个"活着"的连接。
 *
 * 判定之后交给 `onLost` 落地（切状态、写终端），本 hook 不碰 UI 状态。
 */
export function useSshKeepalive(params: {
  phase: Phase;
  sessionId: string;
  onLost: (message: string) => void;
}): void {
  const { phase, sessionId, onLost } = params;
  const { t } = useTranslation();

  useEffect(() => {
    if (phase !== "connected") return;

    let failures = 0;
    const timer = window.setInterval(() => {
      opsApi.sshKeepalive(sessionId).then(
        () => {
          failures = 0;
        },
        (cause) => {
          failures += 1;
          if (failures < KEEPALIVE_MAX_FAILURES) return;
          window.clearInterval(timer);
          onLost(t("Connection lost: {{message}}", { message: toErrorMessage(cause) }));
        },
      );
    }, KEEPALIVE_MS);

    return () => window.clearInterval(timer);
  }, [onLost, phase, sessionId, t]);
}
