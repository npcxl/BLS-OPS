/**
 * The one place that talks to the Tauri updater plugin.
 *
 * Everything above this file (store, UI) works against the {@link UpdaterClient}
 * interface, so the update flow is testable without a running backend and no
 * component can accidentally grow its own `check()` call.
 *
 * Hard rules enforced here, never relaxed:
 * - no `fetch` of installers, no `shell.open`, no manual exe/msi execution;
 * - signature verification is done by the plugin and cannot be turned off —
 *   there is no "install anyway" path anywhere in this app.
 */
import { relaunch } from "@tauri-apps/plugin-process";
import { check, type Update } from "@tauri-apps/plugin-updater";
import type { UpdateProgress, UpdateRelease } from "@/api/types/updater";

export interface UpdaterClient {
  /** Resolves to `null` when the installed version is the latest one. */
  check: () => Promise<UpdateRelease | null>;
  /**
   * Downloads the package the last {@link check} offered.
   *
   * Kept separate from {@link install} so the UI can tell "still downloading"
   * apart from "running the installer" — the plugin owns both steps and
   * verifies the signature before the installer is ever executed.
   */
  download: (onProgress: (progress: UpdateProgress) => void) => Promise<void>;
  /** Runs the verified installer. On Windows this exits the app. */
  install: () => Promise<void>;
  /** Restarts the process — only meaningful once an install finished. */
  relaunch: () => Promise<void>;
}

/**
 * `tauri dev` serves the frontend from Vite, so Vite's build flag is a
 * reliable "am I the dev server" probe. A debug *build* (`tauri build
 * --debug`) is caught later by the plugin itself, which refuses to update and
 * is classified as `unsupported_build`.
 */
export function isDevRuntime(): boolean {
  return import.meta.env.DEV;
}

/**
 * Real client bound to the plugin.
 *
 * The `Update` handle returned by `check()` owns the download, so it is kept
 * between calls; `downloadAndInstall` before a successful `check()` is a
 * programming error and is reported as such instead of silently doing nothing.
 */
export function createTauriUpdaterClient(): UpdaterClient {
  let pending: Update | null = null;
  let received = 0;

  return {
    check: async () => {
      const update = await check();
      pending = update;
      if (!update) return null;
      return {
        version: update.version,
        currentVersion: update.currentVersion,
        notes: update.body?.trim() ? update.body : null,
        date: update.date ?? null,
      };
    },

    download: async (onProgress) => {
      if (!pending) throw new Error("download called before a successful check");
      received = 0;
      let total: number | null = null;
      await pending.download((event) => {
        if (event.event === "Started") {
          received = 0;
          total = event.data.contentLength ?? null;
        } else if (event.event === "Progress") {
          received += event.data.chunkLength;
        } else {
          // Finished: push one last 100% frame so the bar never sticks at 99%.
          received = total ?? received;
        }
        onProgress({ received, total });
      });
    },

    install: async () => {
      if (!pending) throw new Error("install called before a successful check");
      await pending.install();
    },

    relaunch: () => relaunch(),
  };
}
