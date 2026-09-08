/**
 * Update diagnostics bundle — a copy-pasteable report for a failed update.
 *
 * Never contains: tokens, private keys, signature text, or a full local path.
 * The bundle is built from values already in the UI plus the **sanitised**
 * error detail, so what the user pastes into an issue is safe by construction.
 */
import { sanitizeUpdateDetail } from "./errors";
import type { UpdateError, UpdateStage } from "@/api/types/updater";

export interface UpdateDiagnosticsInput {
  currentVersion: string | null;
  targetVersion: string | null;
  os: string | null;
  arch: string | null;
  stage: UpdateStage | null;
  error: UpdateError | null;
  /** Where the app reads its update manifest from. */
  manifestUrl: string | null;
  lastCheckedAt: number | null;
  /** Defaults to `now` — injectable so tests stay deterministic. */
  now?: Date;
}

/**
 * Builds the diagnostics text.
 *
 * Empty optional fields render as `—`; the error block is omitted entirely
 * when there is no failure, so a healthy report stays short.
 */
export function buildUpdateDiagnostics(input: UpdateDiagnosticsInput): string {
  const {
    currentVersion,
    targetVersion,
    os,
    arch,
    stage,
    error,
    manifestUrl,
    lastCheckedAt,
    now = new Date(),
  } = input;
  const dash = "—";
  const when = (value: number | string | null | undefined): string => {
    if (value === null || value === undefined || value === "") return dash;
    const date = typeof value === "number" ? new Date(value) : new Date(value);
    return Number.isNaN(date.getTime()) ? dash : date.toISOString();
  };

  const lines = [
    "BLS-OPS update diagnostics",
    `generated: ${now.toISOString()}`,
    "",
    `current version: ${currentVersion ? `v${currentVersion}` : dash}`,
    `target version: ${targetVersion ? `v${targetVersion}` : dash}`,
    `os: ${os ?? dash}`,
    `arch: ${arch ?? dash}`,
    `stage: ${stage ?? dash}`,
    `manifest: ${manifestUrl ?? dash}`,
    `last checked: ${when(lastCheckedAt)}`,
  ];

  if (error) {
    lines.push(
      "",
      `error code: ${error.code}`,
      `error stage: ${error.stage}`,
      `error time: ${when(error.at)}`,
      // Sanitised again here: defence in depth — nothing unsanitised can reach
      // the clipboard even if a caller forgot.
      `error detail: ${sanitizeUpdateDetail(error.detail) || dash}`,
    );
  }

  return lines.join("\n");
}
