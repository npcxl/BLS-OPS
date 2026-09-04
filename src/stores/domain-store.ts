/**
 * Real application data — servers, credentials, groups, known hosts, sessions.
 *
 * Every value here comes from SQLite through Tauri IPC. There is deliberately no
 * seed/demo data: an empty list means the user has not created anything yet.
 */
import { create } from "zustand";
import {
  opsApi,
  toErrorMessage,
  type AppInfo,
  type CascadeResult,
  type CredentialDeleteResult,
  type CredentialRecord,
  type KnownHostRecord,
  type ServerGroupRecord,
  type ServerRecord,
  type SessionRecord,
  type SshConnectResult,
} from "@/api/ops-api";

interface DomainState {
  servers: ServerRecord[];
  credentials: CredentialRecord[];
  groups: ServerGroupRecord[];
  knownHosts: KnownHostRecord[];
  sessions: SessionRecord[];
  appInfo: AppInfo | null;

  loading: boolean;
  error: string | null;

  refreshAll: () => Promise<void>;
  refreshServers: () => Promise<void>;
  refreshCredentials: () => Promise<void>;
  refreshGroups: () => Promise<void>;
  refreshKnownHosts: () => Promise<void>;
  refreshSessions: () => Promise<void>;

  saveServer: (server: ServerRecord) => Promise<ServerRecord>;
  deleteServer: (id: string) => Promise<CascadeResult>;
  setFavorite: (id: string, favorite: boolean) => Promise<void>;
  /** `groupId: null` puts the server back into 未分组. */
  moveServerToGroup: (id: string, groupId: string | null) => Promise<ServerRecord>;
  testConnection: (id: string) => Promise<SshConnectResult>;

  saveGroup: (group: ServerGroupRecord) => Promise<ServerGroupRecord>;
  deleteGroup: (id: string) => Promise<void>;

  saveCredential: (
    credential: CredentialRecord,
    secret?: string,
    passphrase?: string,
  ) => Promise<CredentialRecord>;
  deleteCredential: (id: string, force?: boolean) => Promise<CredentialDeleteResult>;

  deleteKnownHost: (id: string) => Promise<void>;
  trustKnownHost: (
    host: string,
    port: number,
    fingerprint: string,
    fingerprintType: string,
    trust: boolean,
  ) => Promise<void>;

  setError: (error: string | null) => void;
}

export const useDomainStore = create<DomainState>()((set, get) => ({
  servers: [],
  credentials: [],
  groups: [],
  knownHosts: [],
  sessions: [],
  appInfo: null,
  loading: false,
  error: null,

  setError: (error) => set({ error }),

  refreshServers: async () => {
    const servers = await opsApi.listServers();
    set({ servers });
  },

  refreshCredentials: async () => {
    const credentials = await opsApi.listCredentials();
    set({ credentials });
  },

  refreshGroups: async () => {
    const groups = await opsApi.listGroups();
    set({ groups });
  },

  refreshKnownHosts: async () => {
    const knownHosts = await opsApi.listKnownHosts();
    set({ knownHosts });
  },

  refreshSessions: async () => {
    const sessions = await opsApi.listSessions(30);
    set({ sessions });
  },

  refreshAll: async () => {
    set({ loading: true, error: null });
    try {
      const [servers, credentials, groups, knownHosts, sessions, appInfo] = await Promise.all([
        opsApi.listServers(),
        opsApi.listCredentials(),
        opsApi.listGroups(),
        opsApi.listKnownHosts(),
        opsApi.listSessions(30),
        opsApi.appInfo().catch(() => null),
      ]);
      set({ servers, credentials, groups, knownHosts, sessions, appInfo, error: null });
    } catch (cause) {
      set({ error: toErrorMessage(cause) });
    } finally {
      set({ loading: false });
    }
  },

  saveServer: async (server) => {
    const saved = await opsApi.saveServer(server);
    await get().refreshServers();
    return saved;
  },

  deleteServer: async (id) => {
    const result = await opsApi.deleteServer(id);
    await Promise.all([get().refreshServers(), get().refreshSessions()]);
    return result;
  },

  setFavorite: async (id, favorite) => {
    await opsApi.setServerFavorite(id, favorite);
    await get().refreshServers();
  },

  moveServerToGroup: async (id, groupId) => {
    const moved = await opsApi.moveServerToGroup(id, groupId);
    await get().refreshServers();
    return moved;
  },

  testConnection: async (id) => opsApi.testConnection(id),

  saveGroup: async (group) => {
    const saved = await opsApi.saveGroup(group);
    await get().refreshGroups();
    return saved;
  },

  deleteGroup: async (id) => {
    await opsApi.deleteGroup(id);
    await Promise.all([get().refreshGroups(), get().refreshServers()]);
  },

  saveCredential: async (credential, secret, passphrase) => {
    const saved = await opsApi.saveCredential(credential, secret, passphrase);
    await get().refreshCredentials();
    return saved;
  },

  deleteCredential: async (id, force) => {
    const result = await opsApi.deleteCredential(id, force);
    if (result.deleted) {
      await Promise.all([get().refreshCredentials(), get().refreshServers()]);
    }
    return result;
  },

  deleteKnownHost: async (id) => {
    await opsApi.deleteKnownHost(id);
    await get().refreshKnownHosts();
  },

  trustKnownHost: async (host, port, fingerprint, fingerprintType, trust) => {
    await opsApi.trustKnownHost(host, port, fingerprint, fingerprintType, trust);
    await get().refreshKnownHosts();
  },
}));

export function emptyServer(): ServerRecord {
  const now = Date.now();
  return {
    id: crypto.randomUUID(),
    name: "",
    host: "",
    port: 22,
    username: "root",
    credential_id: null,
    group_id: null,
    tags: [],
    proxy_jump_id: null,
    favorite: false,
    last_connected_at: null,
    status: "idle",
    created_at: now,
    updated_at: now,
  };
}

export function emptyGroup(): ServerGroupRecord {
  const now = Date.now();
  return { id: crypto.randomUUID(), name: "", sort_order: 0, created_at: now, updated_at: now };
}

export function emptyCredential(): CredentialRecord {
  const now = Date.now();
  return {
    id: crypto.randomUUID(),
    name: "",
    credential_type: "password",
    username: "root",
    secret_ref: null,
    passphrase_ref: null,
    created_at: now,
    updated_at: now,
  };
}
