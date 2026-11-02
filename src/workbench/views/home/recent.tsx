/** Recent activity uses existing history only; projects have no fabricated history. */
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { ChevronRight, Clock, Database as DatabaseIcon, Server as ServerIcon, Stack3Icon } from "@/components/icons";
import { relativeTime, singleLine, timestampTitle } from "./utils";

export interface RecentServerItem {
  key: string; serverId: string; name: string; username: string; host: string; port: number; at: number | null;
}
export interface RecentDatabaseItem {
  key: string; profileId: string; name: string; target: string; at: number; sql: string; connected: boolean;
}

function RecentGroup({ title, icon, count, children }: {title: string; icon: ReactNode; count?: number; children: ReactNode}) {
  return <section className="home-recent-group">
    <div className="home-recent-heading"><span className="home-recent-icon">{icon}</span><h2>{title}</h2>
      {count !== undefined && <span className="home-recent-count">{count}</span>}
    </div>
    <div className="home-recent-list">{children}</div>
  </section>;
}

export function RecentSection({ servers, databases, databasesLoading, onOpenServer, onOpenDatabase, onOpenProjects }: {
  servers: RecentServerItem[]; databases: RecentDatabaseItem[]; databasesLoading: boolean;
  onOpenServer: (item: RecentServerItem) => void; onOpenDatabase: (item: RecentDatabaseItem) => void; onOpenProjects: () => void;
}) {
  const { t } = useTranslation();
  return <div className="home-recents">
    <RecentGroup title={t("Recent sessions")} icon={<ServerIcon size={17} />} count={servers.length}>
      {servers.length === 0 ? <EmptyHint text={t("No connection history yet. Sessions appear here after you connect.")} /> : servers.map(item =>
        <button key={item.key} type="button" className="home-recent-row" onClick={() => onOpenServer(item)}>
          <span className="home-recent-row-copy"><span className="home-recent-name">{item.name}</span>
            <span className="home-recent-detail" title={`${item.username}@${item.host}:${item.port}`}>{item.username}@{item.host}:{item.port}</span></span>
          <span className="home-recent-time" title={timestampTitle(item.at)}>{relativeTime(item.at,t)}</span><ChevronRight size={13} className="home-recent-chevron" />
        </button>)}
    </RecentGroup>
    <RecentGroup title={t("Recent queries")} icon={<DatabaseIcon size={17} />} count={databases.length}>
      {databases.length === 0 ? <EmptyHint loading={databasesLoading} text={databasesLoading ? t("Reading query history…") : t("No query history yet. Queries appear here after you run one.")} /> : databases.map(item =>
        <button key={item.key} type="button" className="home-recent-row" onClick={() => onOpenDatabase(item)} title={`${item.target}\n${singleLine(item.sql,400)}`}>
          <span className="home-recent-row-copy"><span className="home-recent-name">{item.name}{item.connected && <span className="home-recent-connected" role="img" aria-label={t("Connected")} title={t("Connected")} />}</span>
            <span className="home-recent-detail font-mono">{singleLine(item.sql,80)}</span></span>
          <span className="home-recent-time" title={timestampTitle(item.at)}>{relativeTime(item.at,t)}</span><ChevronRight size={13} className="home-recent-chevron" />
        </button>)}
    </RecentGroup>
    <RecentGroup title={t("Recent projects")} icon={<Stack3Icon size={17} />}>
      <div className="home-recent-project"><span className="home-recent-project-symbol"><Stack3Icon size={24} strokeWidth={1.4} /></span>
        <p>{t("Project access history is not recorded. Confirmed projects are listed under Assets below.")}</p>
        <button type="button" className="home-recent-project-link" onClick={onOpenProjects}>{t("Open projects")}<ChevronRight size={13} /></button>
      </div>
    </RecentGroup>
  </div>;
}
function EmptyHint({text, loading = false}: {text: string; loading?: boolean}) {
  return <div className="home-recent-empty" role={loading ? "status" : undefined}><Clock size={23} strokeWidth={1.4} /><p>{text}</p></div>;
}
