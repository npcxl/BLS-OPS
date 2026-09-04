/** SSH connect handshake types + target parsing shared with the Rust side. */

/**
 * 会话输出编码（与 Rust `ssh::decoder::SessionEncoding` 逐字对齐）。
 *
 * - `auto`：先按 UTF-8，遇到真非法字节才降级 GB18030（中文老服务器）；
 * - `utf8` / `gb18030` / `big5`：显式指定，**不做任何猜测**。
 */
export type TerminalEncoding = "auto" | "utf8" | "gb18030" | "big5";

/** 编码下拉框选项（含中文标签，顺序与后端 ALL 一致）。 */
export const TERMINAL_ENCODINGS: { id: TerminalEncoding; label: string }[] = [
  { id: "auto", label: "自动" },
  { id: "utf8", label: "UTF-8" },
  { id: "gb18030", label: "GB18030" },
  { id: "big5", label: "Big5" },
];

/**
 * Result of a connect attempt.
 *
 * `host` / `port` are the final destination (what the tab shows).
 * `challenge_host` / `challenge_port` are the endpoint whose key must be
 * trusted — with ProxyJump that is a jump host. The fingerprint MUST be saved
 * under the challenge endpoint; saving it under `host` loops forever on a
 * two-hop connection.
 */
export type SshConnectResult =
  | {
      status: "connected";
      session_id: string;
      host: string;
      port: number;
      fingerprint: string;
      fingerprint_type: string;
    }
  | {
      status: "host_key_unknown";
      session_id: string;
      /** Endpoint to trust — the jump host when ProxyJump is in play. */
      challenge_host: string;
      challenge_port: number;
      /** Final destination, for display only. */
      host: string;
      port: number;
      fingerprint: string;
      fingerprint_type: string;
    }
  | {
      status: "host_key_changed";
      session_id: string;
      /** Endpoint to re-trust — the jump host when ProxyJump is in play. */
      challenge_host: string;
      challenge_port: number;
      /** Final destination, for display only. */
      host: string;
      port: number;
      fingerprint: string;
      fingerprint_type: string;
      known_fingerprint: string;
    };

/** `user@host[:port]` — mirrors `ssh::parse_ssh_target` in Rust. */
export function parseSshTarget(
  input: string,
  defaultPort = 22,
): { username: string; host: string; port: number } | null {
  const trimmed = input.trim();
  if (!trimmed) return null;

  const at = trimmed.lastIndexOf("@");
  if (at <= 0) return null;
  const username = trimmed.slice(0, at).trim();
  const rest = trimmed.slice(at + 1);
  if (!username || !rest) return null;

  let host = rest;
  let port = defaultPort;

  const bracket = rest.lastIndexOf("]:");
  if (bracket >= 0) {
    host = rest.slice(0, bracket).replace(/^\[/, "");
    port = Number(rest.slice(bracket + 2));
  } else if (rest.split(":").length - 1 > 1) {
    host = rest;
  } else {
    const colon = rest.lastIndexOf(":");
    if (colon > 0) {
      const candidate = rest.slice(colon + 1);
      if (candidate && /^\d+$/.test(candidate)) {
        host = rest.slice(0, colon);
        port = Number(candidate);
      }
    }
  }

  if (!host || !Number.isInteger(port) || port < 1 || port > 65535) return null;
  return { username, host, port };
}
