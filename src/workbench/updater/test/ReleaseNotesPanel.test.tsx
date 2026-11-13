import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import "@/i18n";
import { resetUpdaterStore, setUpdaterClient, useUpdaterStore } from "@/stores/updater-store";
import { useDomainStore } from "@/stores/domain-store";
import { useActivityStore } from "@/stores/activity-store";
import { useSessionStore } from "@/stores/session-store";
import type { UpdateRelease, UpdateProgress } from "@/api/types/updater";
import { ReleaseNotesPanel } from "../ReleaseNotesPanel";
import { SettingsPage } from "../../SettingsPage";
import { useSettingsNavigation, openReleaseNotes } from "../../settings-navigation";
import { useWorkbenchStore } from "@/stores/workbench-store";

const metadata = vi.hoisted(() => ({ read: vi.fn() }));
vi.mock("@/api/release-notes", () => ({ readLatestReleaseNotes: metadata.read }));
vi.mock("@/lib/updater/updater-client", async original => ({
  ...await original<typeof import("@/lib/updater/updater-client")>(), isDevRuntime: () => false,
}));
(globalThis as {IS_REACT_ACT_ENVIRONMENT?: boolean}).IS_REACT_ACT_ENVIRONMENT = true;

const release: UpdateRelease = {version:"1.0.1",currentVersion:"1.0.0",date:null,notes:"## Improved connections\n- Real release notes"};
const client = {
  check: vi.fn<() => Promise<UpdateRelease | null>>(),
  download: vi.fn<(progress: (value: UpdateProgress) => void) => Promise<void>>(),
  install: vi.fn<() => Promise<void>>(), relaunch: vi.fn<() => Promise<void>>(),
};
let holder: HTMLDivElement;
let root: Root;
const button = (text: string) => Array.from(document.body.querySelectorAll<HTMLButtonElement>("button"))
  .find(item => item.textContent?.trim() === text);
const click = async (text: string) => {
  const found = button(text); expect(found, text).toBeDefined();
  await act(async () => found!.click());
};
const render = async () => { await act(async () => root.render(<ReleaseNotesPanel />)); };

beforeEach(() => {
  vi.clearAllMocks(); resetUpdaterStore();
  useSettingsNavigation.setState({ category: "general" });
  useUpdaterStore.setState({currentVersion:"1.0.0"});
  useDomainStore.setState({appInfo:null});
  useActivityStore.setState({tickets:{}});
  useSessionStore.setState({sessions:{},challenge:null});
  client.check.mockResolvedValue(release); client.download.mockResolvedValue(undefined);
  client.install.mockResolvedValue(undefined); client.relaunch.mockResolvedValue(undefined);
  setUpdaterClient(client);
  metadata.read.mockRejectedValue(new Error("offline"));
  holder=document.createElement("div");document.body.appendChild(holder);root=createRoot(holder);
});
afterEach(async () => { await act(async () => root.unmount());holder.remove(); vi.restoreAllMocks(); });

describe("release notes and shared updater", () => {
  it("groups the latest notes into cards without splitting code fences or rendering HTML", async () => {
    metadata.read.mockResolvedValue({...release, notes: "## Connections\n- First improvement\n\n```sql\n## SQL comment\n```\n\n## Interface\n<script>unsafe</script>"});
    await render();
    const cards = holder.querySelectorAll(".release-notes-text-section");
    expect(cards).toHaveLength(2);
    expect(cards[0].querySelector("pre")?.textContent).toBe("## SQL comment");
    expect(cards[1].querySelector("h2")?.textContent).toBe("Interface");
    expect(cards[1].querySelector("script")).toBeNull();
    expect(holder.querySelector(".release-notes-cloud")?.getAttribute("aria-hidden")).toBe("true");
  });

  it("shows published history offline without inventing an available update", async () => {
    await render();
    expect(document.body.textContent).not.toContain("Example release notes");
    expect(holder.querySelectorAll(".release-notes-version")).toHaveLength(23);
    expect(holder.querySelector(".release-notes-version-tag")?.textContent).toBe("v0.1.30");
    expect(holder.textContent).not.toContain("Upcoming release");
    expect(holder.textContent).toContain("23 published releases");
    expect(document.body.textContent).toContain("v0.1.17");
    expect(document.body.textContent).not.toContain("v0.1.14");
    expect(holder.querySelector(".release-notes-heading")).toBeNull();
    expect(button("Check for updates")).toBeUndefined();
    expect(button("Download and install")).toBeUndefined();
    expect(client.check).not.toHaveBeenCalled();
    expect(client.download).not.toHaveBeenCalled();
    expect(useUpdaterStore.getState().release).toBeNull();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it("filters changes by kind while keeping published version identities", async () => {
    await render();
    const choose = async (text: string) => {
      const radio = Array.from(holder.querySelectorAll<HTMLButtonElement>('[role="radio"]')).find(node => node.textContent === text)!;
      await act(async () => radio.click());
      expect(radio.getAttribute("aria-checked")).toBe("true");
    };
    await choose("Highlights");
    expect(holder.textContent).toContain("数据库工作台");
    expect(holder.textContent).not.toContain("外部下载链接修复");
    await choose("Performance and fixes");
    expect(holder.textContent).toContain("外部下载链接修复");
    expect(holder.textContent).not.toContain("新增对象浏览");
    await choose("All versions");
    expect(holder.querySelectorAll(".release-notes-version")).toHaveLength(23);
  });

  it("marks the prepared notes published when release metadata confirms the version", async () => {
    metadata.read.mockResolvedValue({...release, version:"0.1.30"});
    await render();
    expect(holder.textContent).not.toContain("Upcoming release");
    expect(holder.textContent).toContain("23 published releases");
    expect(holder.querySelectorAll(".release-notes-version")).toHaveLength(23);
    expect(button("Download and install")).toBeUndefined();
  });

  it("uses the checked release for its notes and download action", async () => {
    await render();
    await act(async () => useUpdaterStore.getState().check({manual: true}));
    expect(document.body.textContent).toContain("v1.0.1");
    expect(document.body.textContent).toContain("Real release notes");
    expect(document.body.textContent).not.toContain("Example release notes");
    await click("Download and install");
    expect(client.download).toHaveBeenCalledTimes(1);
    expect(client.install).toHaveBeenCalledTimes(1);
    expect(client.relaunch).not.toHaveBeenCalled();
    expect(button("Restart now")).toBeDefined();
  });+

  it("reuses a checked update without fetching another manifest", async () => {
    useUpdaterStore.setState({release,phase:"available"});
    await render();
    expect(metadata.read).not.toHaveBeenCalled();
    expect(button("Download and install")).toBeDefined();
  });

  it("cannot download solely from unverified release-note metadata", async () => {
    metadata.read.mockResolvedValue({...release,version:"9.0.0"});
    await render();
    expect(document.body.textContent).toContain("v9.0.0");
    expect(button("Download and install")).toBeUndefined();
    expect(client.download).not.toHaveBeenCalled();
  });

  it("shows download progress and prevents a duplicate download", async () => {
    useUpdaterStore.setState({release,phase:"available"});
    let finish!: () => void;
    client.download.mockImplementation(progress => {
      progress({received:50,total:100});
      return new Promise<void>(resolve => { finish=resolve; });
    });
    await render(); await click("Download and install");
    expect(document.body.querySelector("progress")?.value).toBe(50);
    expect(button("Check for updates")).toBeUndefined();
    expect(button("Download and install")).toBeUndefined();
    await act(async () => finish());
    expect(client.download).toHaveBeenCalledTimes(1);
  });

  it("keeps the existing live-session confirmation in front of the notes", async () => {
    useUpdaterStore.setState({release,phase:"available"});
    useSessionStore.getState().register({sessionId:"notes-ssh",tabId:"tab",title:"server"});
    useSessionStore.getState().setStatus("notes-ssh","connected");
    await render(); await click("Download and install");
    expect(document.body.querySelectorAll('[role="dialog"]')).toHaveLength(1);
    expect(document.body.textContent).toContain("1 active SSH sessions");
    expect(client.download).not.toHaveBeenCalled();
    await click("Not now");
    expect(client.download).not.toHaveBeenCalled();
  });

  it("settings renders notes directly in its single page scroll region", async () => {
    useSettingsNavigation.setState({category:"release-notes"});
    await act(async () => root.render(<SettingsPage />));
    expect(holder.querySelector(".release-notes-page")).not.toBeNull();
    expect(holder.querySelectorAll(".page-scroll")).toHaveLength(1);
    expect(holder.querySelector(".settings-detail > .page-header")).toBeNull();
    expect(holder.querySelector(".release-notes-heading")).toBeNull();
    expect(holder.querySelector(".page-content--reading")).toBeNull();
    expect(holder.querySelector(".release-notes-filter-bar")).not.toBeNull();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it("all release-note entry points navigate to Settings instead of an overlay", () => {
    const navigate = vi.spyOn(useWorkbenchStore.getState(), "openModuleTab").mockImplementation(() => undefined);
    openReleaseNotes();
    expect(navigate).toHaveBeenCalledWith("settings");
    expect(useSettingsNavigation.getState().category).toBe("release-notes");
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });
});
