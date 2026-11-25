import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { Database, FileDescriptionIcon, Info, Monitor, RefreshCw, ShieldCheck, TerminalIcon, type IconComponent } from "@/components/icons";
import { PageHeader, PageScroll, PageSurface } from "./page-layout";
import { SettingsContextSidebar } from "./settings-context-sidebar";
import { ReleaseNotesPanel } from "./updater/ReleaseNotesPanel";
import { useSettingsNavigation, type SettingsPageCategory as Category } from "./settings-navigation";
import { useUpdaterStore } from "@/stores/updater-store";
import "./settings-page.css";

const CATEGORIES: {id: Category; title: string; icon: IconComponent; divider?: boolean}[] = [
  {id:"general", title:"General settings", icon:Monitor},
  {id:"terminal", title:"Terminal & shortcuts", icon:TerminalIcon},
  {id:"security", title:"Security & credentials", icon:ShieldCheck},
  {id:"data", title:"Data & backups", icon:Database},
  {id:"updates", title:"App update", icon:RefreshCw, divider:true},
  {id:"release-notes", title:"Release notes", icon:FileDescriptionIcon},
  {id:"about", title:"About BLS-OPS", icon:Info},
];

/** Settings owns its two scroll regions; changing category never alters the app shell. */
export function SettingsPage() {
  const {t} = useTranslation();
  const category = useSettingsNavigation(state => state.category);
  const setCategory = useSettingsNavigation(state => state.setCategory);
  const release = useUpdaterStore(state => state.release);
  const viewport = useRef<HTMLDivElement>(null);
  // 旧版本可能把分类停在已移除的 "ai"：先回退到第一项，再异步纠正导航状态。
  const active = CATEGORIES.find(item=>item.id===category) ?? CATEGORIES[0];
  useEffect(()=>{if(viewport.current) viewport.current.scrollTop=0;},[category]);
  useEffect(()=>{
    if(!CATEGORIES.some(item=>item.id===category)) setCategory("general");
  },[category, setCategory]);
  return <PageSurface className="settings-page" data-selectable>
    <div className="settings-layout">
      <aside className="settings-navigation">
        <h1>{t("Module: Settings")}</h1>
        <nav aria-label={t("Module: Settings")}>
          {CATEGORIES.map(item=>{
            const Icon=item.icon;
            return <button key={item.id} type="button" aria-current={category===item.id ? "page" : undefined}
              className={item.divider ? "settings-nav-item settings-nav-divider" : "settings-nav-item"}
              onClick={()=>setCategory(item.id)}>
              <Icon size={17} strokeWidth={1.65} /><span>{t(item.title)}</span>
              {(item.id === "updates" || item.id === "release-notes") && release &&
                <span className="settings-update-badge" aria-label={t("A new version is available")}>v{release.version}</span>}
            </button>;
          })}
        </nav>
      </aside>
      <section className={`settings-detail${category === "release-notes" ? " settings-detail--release-notes" : ""}`} aria-label={t(active.title)}>
        {category !== "release-notes" && <PageHeader title={t(active.title)} bordered />}
        <PageScroll width={category === "release-notes" ? "full" : "reading"} viewportRef={viewport}>
          {category === "release-notes" ? <ReleaseNotesPanel /> : <SettingsContextSidebar category={category} />}
        </PageScroll>
      </section>
    </div>
  </PageSurface>;
}
