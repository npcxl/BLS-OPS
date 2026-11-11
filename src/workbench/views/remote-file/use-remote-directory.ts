import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { opsApi, type RemoteFileEntry } from "@/api/ops-api";
import { pushErrorToast } from "@/components/ui/toast";
import { useDirSizeStore } from "@/stores/dir-size-store";
import { parentOf, type PanelStatus } from "./utils";

interface Listing {
  cwd: string | null;
  entries: RemoteFileEntry[];
  status: PanelStatus;
}

const empty: Listing = { cwd: null, entries: [], status: { state: "idle" } };
const listingStatus = (entries: RemoteFileEntry[]): PanelStatus =>
  entries.length ? { state: "ready" } : { state: "empty" };

export function useRemoteDirectory(
  sessionId: string,
  connected: boolean,
  initialPath: string | undefined,
  onListed: (entries: RemoteFileEntry[], selected?: string | null) => void,
) {
  const { t } = useTranslation();
  const translate = useRef(t);
  translate.current = t;
  const [listing, setListing] = useState<Listing>(empty);
  const state = useRef({ current: empty, request: 0, navigating: false });
  const initialPathRef = useRef(initialPath);
  initialPathRef.current = initialPath;
  const run = useCallback(async (
    path: string | null,
    options: { resolve?: boolean; refresh?: boolean; select?: string } = {},
  ) => {
    const live = state.current;
    if (!connected || (options.refresh && (live.navigating || path !== live.current.cwd))) return;
    const request = ++live.request;
    const active = () => state.current === live && live.request === request;
    if (!options.refresh) {
      live.navigating = true;
      setListing({ ...live.current, status: { state: "loading" } });
    }
    let target = path;
    try {
      if (target === null) {
        const home = await opsApi.sftpOpen(sessionId);
        if (!active()) return;
        target = initialPathRef.current?.trim() || home;
        options = { resolve: target !== home };
      }
      let selectedName: string | undefined;
      if (options.resolve) {
        const entry = await opsApi.sftpStat(sessionId, target);
        if (!active()) return;
        target = entry.path;
        if (entry.kind !== "directory") {
          selectedName = entry.name;
          target = parentOf(entry.path);
        }
      }
      const result = await opsApi.sftpListDir(sessionId, target);
      if (!active()) return;
      live.current = {
        cwd: result.path,
        entries: result.entries,
        status: listingStatus(result.entries),
      };
      setListing(live.current);
      onListed(result.entries, options.select ?? (options.refresh ? undefined
        : result.entries.find(entry => entry.name === selectedName)?.path ?? null));
    } catch (cause) {
      if (!active()) return;
      if (live.current.cwd !== null) {
        setListing(live.current);
        pushErrorToast(cause, {
          title: options.refresh ? translate.current("Refresh failed")
            : translate.current("Cannot open {{path}}", { path: target }),
          persist: false,
        });
      } else {
        setListing({ ...empty, status: { state: "error", error: cause } });
      }
    } finally {
      if (active()) live.navigating = false;
    }
  }, [connected, onListed, sessionId]);

  useEffect(() => {
    if (connected) void run(null);
    else setListing({ ...empty, status: { state: "disconnected" } });
    return () => { state.current = { current: empty, request: 0, navigating: false }; };
  }, [connected, run]);

  const refresh = useCallback((path?: string | null, select?: string) => {
    const target = path ?? state.current.current.cwd;
    if (!connected || !target) return;
    useDirSizeStore.getState().invalidateUnder(sessionId, target);
    return run(target, { refresh: true, select });
  }, [connected, run, sessionId]);

  const refreshChanged = useCallback((folders: Set<string>) => {
    const cwd = state.current.current.cwd;
    if (!cwd) return;
    const prefix = cwd === "/" ? "/" : `${cwd}/`;
    if ([...folders].some(folder => folder === cwd || folder.startsWith(prefix))) {
      void refresh(cwd);
    }
  }, [refresh]);

  return { ...listing, run, refresh, refreshChanged };
}
