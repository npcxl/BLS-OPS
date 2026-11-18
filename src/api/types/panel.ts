/**
 * 「服务器命令面板」的跨端类型。
 *
 * `LogSource` 是**远端日志的真实来源**（文件 / systemd / Docker），由后端按它
 * 组装 `tail -F`、`journalctl -f`、`docker logs -f`。
 */

export type LogSource =
  | { kind: "file"; path: string; label: string }
  | { kind: "journal"; unit: string; label: string }
  | { kind: "docker"; container: string; label: string }
  | {
      kind: "k8s";
      pod: string;
      /** 不填 = 默认命名空间。 */
      namespace?: string | null;
      /** 多容器 Pod 才需要。 */
      container?: string | null;
      label: string;
    };

export interface LogStartRequest {
  streamId: string;
  sessionId: string;
  /** 服务器展示名 / id：后端核对这条会话属于哪台，防串机。 */
  server: string;
  source: LogSource;
  /** 先回灌多少行历史（1–5000）。 */
  lines?: number;
}

export type LogEventKind = "started" | "line" | "closed" | "error";

export interface LogEvent {
  kind: LogEventKind;
  text?: string;
  error?: string;
}
