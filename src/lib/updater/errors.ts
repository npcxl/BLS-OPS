/**
 * Update error classification — pure functions, zero I/O, unit-tested.
 *
 * The Tauri updater reports failures as free-form strings coming out of Rust
 * (network stack, minisign, the OS installer…). The UI must never dump those
 * at the user, and must never show a generic "something went wrong" either:
 * a missing signature and a full disk need different wording.
 */
import type {
  UpdateError,
  UpdateErrorCode,
} from "@/api/types/updater";

/**
 * User-facing message per code.
 *
 * Values are **i18n keys** (natural keys: English text is the key), resolved
 * with `t()` at the render site — module constants must not call hooks.
 */
export const UPDATE_ERROR_MESSAGES: Record<UpdateErrorCode, string> = {
  network: "No network connection. Check your connection and try again.",
  timeout: "The update server did not respond in time. Try again later.",
  malformed_manifest: "The update information is malformed and cannot be used.",
  no_platform_asset: "This release has no installer for the current platform.",
  signature_missing: "The update package is not signed. Update aborted.",
  signature_invalid: "Signature verification failed. Update aborted.",
  download_interrupted: "The download was interrupted. Please try again.",
  disk_full: "Not enough disk space to install the update.",
  install_failed: "The installation failed. The app was left unchanged.",
  cancelled: "Update cancelled.",
  restart_failed: "The app could not be restarted. Please close and reopen it manually.",
  unsupported_build: "Updates are not available in development builds.",
  unknown: "The update could not be completed.",
};

/** Codes that mean "nothing is broken, the user can retry immediately". */
export const RETRYABLE_ERRORS: ReadonlySet<UpdateErrorCode> = new Set<UpdateErrorCode>([
  "network",
  "timeout",
  "download_interrupted",
  "disk_full",
  "restart_failed",
  "unknown",
]);

/**
 * Strips anything that must never reach a log file: absolute home paths,
 * drive-letter paths, bearer tokens and long opaque blobs (base64 signatures).
 *
 * Dev logs keep the *reason*; they drop *where the user lives*.
 */
export function sanitizeUpdateDetail(raw: string): string {
  if (!raw) return "";
  return (
    raw
      // C:\Users\alice\… → C:\Users\<redacted>\…
      .replace(/([A-Za-z]:\\Users\\)[^\\\s"']+/gi, "$1<redacted>")
      // /home/alice/… and /Users/alice/… → /home/<redacted>/…
      // The capture is the directory segment, never the username.
      .replace(/\/((?:home|Users)\/)[^/\s"']+/g, "/$1<redacted>")
      // ?token=…, &access_token=…, gh?_…
      .replace(/((?:token|access_token|password|secret|key)=)[^\s&"']+/gi, "$1<redacted>")
      // Minisign signatures / hashes: long base64 or hex runs.
      .replace(/\b[A-Za-z0-9+/]{64,}={0,2}\b/g, "<blob>")
      .trim()
  );
}

/** Extracts a readable message out of whatever the plugin threw. */
function messageOf(cause: unknown): string {
  if (typeof cause === "string") return cause;
  if (cause instanceof Error) return cause.message;
  if (cause && typeof cause === "object") {
    const maybe = cause as { message?: unknown; error?: unknown };
    if (typeof maybe.message === "string") return maybe.message;
    if (typeof maybe.error === "string") return maybe.error;
  }
  return String(cause ?? "");
}

/**
 * Ordered classification rules.
 *
 * Order matters: a signature failure is reported through the download path
 * ("failed to verify signature …"), so signature rules must run before the
 * generic network/download ones.
 */
interface Rule {
  code: UpdateErrorCode;
  /** A rule matches when **every** pattern matches — conjunction, not fallback. */
  all: RegExp[];
}

const RULES: Rule[] = [
  { code: "unsupported_build", all: [/dev(elopment)?\s*(mode|build)|debug\s*build/] },
  { code: "signature_invalid", all: [/signature/, /invalid|mismatch|verif|does not match|failed/] },
  { code: "signature_missing", all: [/(signature|sig)\b.{0,24}(missing|not found|absent|empty)|no signature/] },
  { code: "timeout", all: [/timed?\s*out|timeout|deadline/] },
  { code: "disk_full", all: [/no space|disk (full|quota)|os error 112|not enough space/] },
  { code: "cancelled", all: [/cancel(l)?ed|aborted by user/] },
  { code: "malformed_manifest", all: [/json|serde|deserial|parse|malformed|invalid (manifest|update)|expected value|missing field/] },
  { code: "no_platform_asset", all: [/platform|target|no (release|asset|binary)|not (found|available) for/] },
  { code: "download_interrupted", all: [/(download|transfer|connection).{0,32}(interrupt|reset|closed|abort|broken)|unexpected eof/] },
  { code: "install_failed", all: [/install/] },
  { code: "network", all: [/network|offline|dns|resolve|connect|unreachable|os error (11001|10051|10060|10061)|error sending request|failed to (fetch|download|get)/] },
];

/**
 * Maps a thrown value to a classified {@link UpdateError}.
 *
 * Deliberately conservative: an unrecognised message yields `unknown` rather
 * than a guessed code, because a wrong explanation is worse than a vague one.
 */
export function classifyUpdateError(cause: unknown): UpdateError {
  const detail = sanitizeUpdateDetail(messageOf(cause));
  const haystack = detail.toLowerCase();
  if (!haystack) return { code: "unknown", detail: "" };

  for (const rule of RULES) {
    if (rule.all.every((pattern) => pattern.test(haystack))) return { code: rule.code, detail };
  }
  return { code: "unknown", detail };
}
