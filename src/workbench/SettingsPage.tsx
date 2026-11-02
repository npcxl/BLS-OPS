import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Bot, Database, FileDescriptionIcon, Info, Monitor, RefreshCw, ShieldCheck, TerminalIcon, type IconComponent } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { PageHeader, PageScroll, PageSurface } from "./page-layout";
import { SettingsContextSidebar, type SettingsCategory } from "./settings-context-sidebar";
import { ReleaseNotesDialog } from "./updater/ReleaseNotesDialog";
import "./settings-page.css";

type Category = SettingsCategory | "release-notes";
const CATEGORIES: {id: Category; title: string; icon: IconComponent; divider?: boolean}[] = [
  {id:"general", title:"General settings", icon:Monitor},
  {id:"terminal", title:"Terminal & shortcuts", icon:TerminalIcon},
  {id:"security", title:"Security & credentials", icon:ShieldCheck},
  {id:"data", title:"Data & backups", icon:Database},
  {id:"ai", title:"AI providers", icon:Bot},
  {id:"updates", title:"App update", icon:RefreshCw, divider:true},
  {id:"release-notes", title:"Release notes", icon:FileDescriptionIcon},
  {id:"about", title:"About BLS-OPS", icon:Info},
];

/** Settings owns its two scroll regions; changing category never alters the app shell. */
export function SettingsPage() {
  const {t} = useTranslation();
  const [category, setCategory] = useState<Category>("general");
  const [notesOpen, setNotesOpen] = useState(false);
  const viewport = useRef<HTMLDivElement>(null);
  const active = CATEGORIES.find(item=>item.id===category)!;
  useEffect(()=>{if(viewport.current) viewport.current.scrollTop=0;},[category]);
  return <PageSurface className="settings-page" data-selectable>
    <div className="settings-layout">
      <aside className="settings-navigation">
        <h1>{t("Module: Settings")}</h1>
        <nav aria-label={t("Module: Settings")}>
          {CATEGORIES.map(item=>{
            const Icon=item.icon;
            return <button key={item.id} type="button" aria-current={category===item.id ? "page" : undefined}
              className={item.divider ? "settings-nav-item settings-nav-divider" : "settings-nav-item"}
              onClick={()=>{setCategory(item.id); if(item.id==="release-notes") setNotesOpen(true);}}>
              <Icon size={17} strokeWidth={1.65} /><span>{t(item.title)}</span>
            </button>;
          })}
        </nav>
      </aside>
      <section className="settings-detail" aria-label={t(active.title)}>
        <PageHeader title={t(active.title)} bordered />
        <PageScroll width="reading" viewportRef={viewport}>
          {category === "release-notes" ? <div className="settings-release-entry">
            <span className="settings-release-icon"><FileDescriptionIcon size={29} strokeWidth={1.4} /></span>
            <h2>{t("Release notes")}</h2>
            <p>{t("Only the latest release is shown.")}</p>
            <Button variant="secondary" size="sm" onClick={()=>setNotesOpen(true)}>{t("View latest release notes")}</Button>
          </div> : <SettingsContextSidebar category={category} />}
        </PageScroll>
      </section>
    </div>
    <ReleaseNotesDialog open={notesOpen} onClose={()=>setNotesOpen(false)} />
  </PageSurface>;
}
