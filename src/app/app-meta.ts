/** App-level constants shown in chrome (spec §15, §30). */

export const APP_VERSION = "0.1.0";
export const APP_NAME = "运维工作台";

/** Mocked shell telemetry until real engines land (Phase 2+). */
export const SHELL_TELEMETRY = {
  connectedSessions: 3,
  runningTasks: 2,
  transferDown: "2.3 MB/s",
  transferUp: "820 KB/s",
  aiReady: true,
} as const;
