/** SSH connect handshake types + target parsing shared with the Rust side. */

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
