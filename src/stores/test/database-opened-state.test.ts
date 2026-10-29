import { beforeEach, describe, expect, it } from "vitest";
import { tablesKey, useDatabaseStore } from "../database-store";

const PROFILE = "p-opened";
const DATABASE = "db-opened";
const KEY = tablesKey(PROFILE, DATABASE);

describe("opened database state", () => {
  beforeEach(() => {
    localStorage.clear();
    useDatabaseStore.setState({
      openedDatabases: {},
      expandedDatabases: {},
      // 预置空表缓存，展开时不会触发 IPC。
      tables: { [KEY]: [] },
    });
  });

  it("展开只改变展开态，不把库标成已打开", async () => {
    const store = useDatabaseStore.getState();
    await store.toggleDatabase(PROFILE, DATABASE);

    let state = useDatabaseStore.getState();
    expect(state.expandedDatabases[KEY]).toBe(true);
    expect(state.openedDatabases[KEY]).toBeUndefined();

    await useDatabaseStore.getState().toggleDatabase(PROFILE, DATABASE);
    state = useDatabaseStore.getState();
    expect(state.expandedDatabases[KEY]).toBe(false);
    expect(state.openedDatabases[KEY]).toBeUndefined();
  });

  it("openDatabase 才标记已打开并展开", async () => {
    await useDatabaseStore.getState().openDatabase(PROFILE, DATABASE);

    const state = useDatabaseStore.getState();
    expect(state.openedDatabases[KEY]).toBe(true);
    expect(state.expandedDatabases[KEY]).toBe(true);
  });

  it("closing clears both opened and expanded state", async () => {
    await useDatabaseStore.getState().openDatabase(PROFILE, DATABASE);
    useDatabaseStore.getState().closeDatabase(PROFILE, DATABASE);

    const state = useDatabaseStore.getState();
    expect(state.openedDatabases[KEY]).toBe(false);
    expect(state.expandedDatabases[KEY]).toBe(false);
  });

  it("switching the current database does not touch opened state", () => {
    useDatabaseStore.setState({
      openedDatabases: { [KEY]: true },
      expandedDatabases: { [KEY]: false },
    });

    useDatabaseStore.setState((state) => ({
      sessions: {
        ...state.sessions,
        [PROFILE]: {
          ...state.sessions[PROFILE],
          current_database: "another-db",
        },
      },
    }));

    const state = useDatabaseStore.getState();
    expect(state.openedDatabases[KEY]).toBe(true);
    expect(state.expandedDatabases[KEY]).toBe(false);
  });
});
