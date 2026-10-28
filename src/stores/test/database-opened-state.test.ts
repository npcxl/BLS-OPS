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

  it("expanding marks the database opened; collapsing keeps it opened", async () => {
    const store = useDatabaseStore.getState();
    await store.toggleDatabase(PROFILE, DATABASE);

    let state = useDatabaseStore.getState();
    expect(state.openedDatabases[KEY]).toBe(true);
    expect(state.expandedDatabases[KEY]).toBe(true);

    await useDatabaseStore.getState().toggleDatabase(PROFILE, DATABASE);
    state = useDatabaseStore.getState();
    expect(state.openedDatabases[KEY]).toBe(true);
    expect(state.expandedDatabases[KEY]).toBe(false);
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
