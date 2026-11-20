/**
 * Terminal / connection-status overrides.
 *
 * The terminal UI calls `t()` with Chinese keys for a few connection messages
 * (the rest use English natural keys). Without these entries the English UI
 * would show Chinese text.
 */
export default {
  "连接超时：{{seconds}} 秒内服务器没有响应":
    "Connection timed out: the server did not respond within {{seconds}}s",
  "连接在握手阶段中断：{{reason}}":
    "Connection dropped during the handshake: {{reason}}",
  "连接在握手阶段中断，请重新连接":
    "Connection dropped during the handshake — reconnect to continue",
} as const;
