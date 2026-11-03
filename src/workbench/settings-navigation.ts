import { create } from "zustand";
import { useWorkbenchStore } from "@/stores/workbench-store";
import type { SettingsCategory } from "./settings-context-sidebar";

export type SettingsPageCategory = SettingsCategory | "release-notes";

/** A settings deep link, shared by the update section and notification. */
export const useSettingsNavigation = create<{
  category: SettingsPageCategory;
  setCategory: (category: SettingsPageCategory) => void;
}>(set => ({
  category: "general",
  setCategory: category => set({ category }),
}));

export function openReleaseNotes(): void {
  useSettingsNavigation.getState().setCategory("release-notes");
  useWorkbenchStore.getState().openModuleTab("settings");
}
