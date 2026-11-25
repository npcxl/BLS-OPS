import { beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_EXTREME_SETTINGS,
  notificationAllowed,
  useExtremeSettingsStore,
} from "@/stores/extreme-settings-store";

const KEY = "bls-ops.extreme-settings.v1";

describe("超能设置 store", () => {
  beforeEach(() => {
    localStorage.clear();
    useExtremeSettingsStore.setState({ ...DEFAULT_EXTREME_SETTINGS });
  });

  it("默认值可持久化，坏值回退到默认", () => {
    const store = useExtremeSettingsStore.getState();
    store.update({ defaultContext: "picked", replyLanguage: "en", defaultBudget: 300 * 1024 });
    const saved = JSON.parse(localStorage.getItem(KEY) ?? "{}");
    expect(saved.defaultContext).toBe("picked");
    expect(saved.replyLanguage).toBe("en");
    expect(saved.defaultBudget).toBe(300 * 1024);

    useExtremeSettingsStore.getState().update({
      defaultContext: "bad" as never,
      defaultBudget: -1,
    });
    const normalized = useExtremeSettingsStore.getState();
    expect(normalized.defaultContext).toBe("session");
    expect(normalized.defaultBudget).toBeNull();
  });

  it("通知总开关优先于分类开关", () => {
    useExtremeSettingsStore.getState().setNotification({ approval: false });
    expect(notificationAllowed("approval")).toBe(false);
    expect(notificationAllowed("success")).toBe(true);
    useExtremeSettingsStore.getState().setNotification({ enabled: false });
    expect(notificationAllowed("success")).toBe(false);
  });

  it("恢复默认写回全部默认值", () => {
    useExtremeSettingsStore.getState().update({
      planCard: "collapsed",
      toolDetails: "expanded",
      motion: "reduced",
      followLatest: false,
    });
    useExtremeSettingsStore.getState().reset();
    const state = useExtremeSettingsStore.getState();
    expect(state.planCard).toBe("expand");
    expect(state.toolDetails).toBe("collapsed");
    expect(state.motion).toBe("system");
    expect(state.followLatest).toBe(true);
  });
});
