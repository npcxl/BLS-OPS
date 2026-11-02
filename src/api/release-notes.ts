import { invoke } from "@tauri-apps/api/core";

export interface LatestReleaseNotes {
  version: string;
  notes: string | null;
  date: string | null;
}

/** Desktop IPC keeps the WebView CSP unchanged. No historical release list. */
export const readLatestReleaseNotes = () => invoke<LatestReleaseNotes>("latest_release_notes");
