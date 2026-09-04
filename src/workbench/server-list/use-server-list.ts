/**
 * Shared behaviour for every server list: optimistic favorite / group moves
 * plus the group CRUD, with rollback and a visible error on failure.
 *
 * The sidebars (终端 / 项目 / 服务 / 日志) previously each kept their own copy
 * of this logic, which is why the module sidebar never grew the fixes made to
 * the terminal one. Everything here is hooked to the same store, so a fix
 * applies everywhere at once.
 */
import { useCallback, useMemo, useState } from "react";
import { toErrorMessage, type ServerGroupRecord, type ServerRecord } from "@/api/ops-api";
import { emptyGroup, useDomainStore } from "@/stores/domain-store";
import { buildServerSections, type ServerSections } from "./sections";

/** Sessions-driven management modules reachable from a server row. */
export type ManageKind = "service" | "logs";

/** Derives the rendered sections from the store. Groups drive the layout. */
export function useServerSections(): ServerSections {
  const servers = useDomainStore((s) => s.servers);
  const groups = useDomainStore((s) => s.groups);
  return useMemo(() => buildServerSections(servers, groups), [servers, groups]);
}

export interface ServerListActions {
  error: string | null;
  clearError: () => void;
  /** For failures raised outside this hook (e.g. deleting a server). */
  setError: (message: string) => void;
  /** Refreshes servers *and* groups — the two must never drift apart. */
  refresh: () => Promise<void>;
  toggleFavorite: (server: ServerRecord) => Promise<void>;
  moveToGroup: (server: ServerRecord, groupId: string | null) => Promise<void>;
  /** Returns the saved group, or `null` when the caller must keep the editor open. */
  createGroup: (name: string) => Promise<ServerGroupRecord | null>;
  renameGroup: (group: ServerGroupRecord, name: string) => Promise<void>;
  deleteGroup: (group: ServerGroupRecord) => Promise<void>;
}

/** Applies a local patch so the row reacts before the round-trip finishes. */
function patchServers(update: (servers: ServerRecord[]) => ServerRecord[]) {
  useDomainStore.setState({ servers: update(useDomainStore.getState().servers) });
}

export function useServerListActions(): ServerListActions {
  const [error, setError] = useState<string | null>(null);

  const clearError = useCallback(() => setError(null), []);

  const refresh = useCallback(async () => {
    const { refreshServers, refreshGroups } = useDomainStore.getState();
    try {
      await Promise.all([refreshServers(), refreshGroups()]);
      setError(null);
    } catch (cause) {
      setError(toErrorMessage(cause));
    }
  }, []);

  const toggleFavorite = useCallback(async (server: ServerRecord) => {
    const next = !server.favorite;
    const rollback = useDomainStore.getState().servers;
    patchServers((servers) =>
      servers.map((item) => (item.id === server.id ? { ...item, favorite: next } : item)),
    );
    try {
      await useDomainStore.getState().setFavorite(server.id, next);
      setError(null);
    } catch (cause) {
      // Put the old snapshot back: a star that lies about the stored value is
      // worse than one that lags a frame.
      useDomainStore.setState({ servers: rollback });
      setError(toErrorMessage(cause));
    }
  }, []);

  const moveToGroup = useCallback(async (server: ServerRecord, groupId: string | null) => {
    const rollback = useDomainStore.getState().servers;
    patchServers((servers) =>
      servers.map((item) => (item.id === server.id ? { ...item, group_id: groupId } : item)),
    );
    try {
      await useDomainStore.getState().moveServerToGroup(server.id, groupId);
      setError(null);
    } catch (cause) {
      useDomainStore.setState({ servers: rollback });
      setError(toErrorMessage(cause));
    }
  }, []);

  const createGroup = useCallback(async (name: string) => {
    const trimmed = name.trim();
    if (!trimmed) return null;
    try {
      const saved = await useDomainStore.getState().saveGroup({ ...emptyGroup(), name: trimmed });
      setError(null);
      return saved;
    } catch (cause) {
      // Duplicate names and storage failures must be readable — never a silent
      // "nothing happened" that looks like the button is broken.
      setError(toErrorMessage(cause));
      return null;
    }
  }, []);

  const renameGroup = useCallback(async (group: ServerGroupRecord, name: string) => {
    const trimmed = name.trim();
    if (!trimmed || trimmed === group.name) return;
    try {
      await useDomainStore.getState().saveGroup({ ...group, name: trimmed, updated_at: Date.now() });
      setError(null);
    } catch (cause) {
      setError(toErrorMessage(cause));
    }
  }, []);

  const deleteGroup = useCallback(async (group: ServerGroupRecord) => {
    try {
      // The store refreshes servers too: the DB unlinks them into 未分组.
      await useDomainStore.getState().deleteGroup(group.id);
      setError(null);
    } catch (cause) {
      setError(toErrorMessage(cause));
    }
  }, []);

  return {
    error,
    clearError,
    setError,
    refresh,
    toggleFavorite,
    moveToGroup,
    createGroup,
    renameGroup,
    deleteGroup,
  };
}
