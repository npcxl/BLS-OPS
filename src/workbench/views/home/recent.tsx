/**
 * 最近使用：三列并列，分别来自三类**真实历史**。
 *
 * - 服务器：`ssh_sessions` 历史（按 connected_at 倒序）—— 只是历史，绝不显示成在线；
 * - 数据库：`database_query_history`（默认开启，按 created_at 倒序）；
 * - 项目：没有跨会话的访问记录（项目只在带 SSH 会话的标签里发现），
 *   因此这里永远给空状态 + 入口，不编造"最近打开"。
 */
import { useTranslation } from "react-i18next";
import { Clock, Database as DatabaseIcon, FileCode2, Server as ServerIcon, Stack3Icon } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { ListPanel, SectionHeading } from "./section";
import { relativeTime, singleLine, timestampTitle } from "./utils";

export interface RecentServerItem {
  key: string;
  serverId: string;
  name: string;
  username: string;
  host: string;
  port: number;
  at: number | null;
}

export interface RecentDatabaseItem {
  key: string;
  profileId: string;
  name: string;
  target: string;
  at: number;
  sql: string;
  /** 实时状态：只对当前工作区里真的连着的那条亮灯。 */
  connected: boolean;
}

export function RecentSection({
  servers,
  databases,
  databasesLoading,
  onOpenServer,
  onOpenDatabase,
  onOpenProjects,
}: {
  servers: RecentServerItem[];
  databases: RecentDatabaseItem[];
  /** 历史还没读完时不要先显示"没有记录"。 */
  databasesLoading: boolean;
  onOpenServer: (item: RecentServerItem) => void;
  onOpenDatabase: (item: RecentDatabaseItem) => void;
  onOpenProjects: () => void;
}) {
  const { t } = useTranslation();

  return (
    <div className="grid gap-4 lg:grid-cols-3">
      <section className="flex min-w-0 flex-col gap-2.5">
        <SectionHeading title={t("Recent sessions")} count={servers.length} />
        {servers.length === 0 ? (
          <EmptyHint text={t("No connection history yet. Sessions appear here after you connect.")} />
        ) : (
          <ListPanel>
            {servers.map((item) => (
              <button
                key={item.key}
                type="button"
                onClick={() => onOpenServer(item)}
                className="group flex h-11 w-full items-center gap-2 px-3 text-left transition-colors hover:bg-surface-hover/60"
              >
                <ServerIcon size={13} className="shrink-0 text-fg-subtle" />
                <span className="min-w-0 flex-1 truncate text-12 text-fg">
                  {item.name}
                  <span className="ml-2 text-11 text-fg-subtle">
                    {item.username}@{item.host}:{item.port}
                  </span>
                </span>
                <span
                  className="flex shrink-0 items-center gap-1 text-11 text-fg-subtle"
                  title={timestampTitle(item.at)}
                >
                  <Clock size={11} />
                  {relativeTime(item.at, t)}
                </span>
              </button>
            ))}
          </ListPanel>
        )}
      </section>

      <section className="flex min-w-0 flex-col gap-2.5">
        <SectionHeading title={t("Recent queries")} count={databases.length} />
        {databases.length === 0 ? (
          databasesLoading ? (
            <EmptyHint text={t("Reading query history…")} />
          ) : (
            <EmptyHint text={t("No query history yet. Queries appear here after you run one.")} />
          )
        ) : (
          <ListPanel>
            {databases.map((item) => (
              <button
                key={item.key}
                type="button"
                onClick={() => onOpenDatabase(item)}
                className="group flex w-full flex-col gap-0.5 px-3 py-2 text-left transition-colors hover:bg-surface-hover/60"
                title={`${item.target}\n${singleLine(item.sql, 400)}`}
              >
                <span className="flex min-w-0 items-center gap-2">
                  <DatabaseIcon size={13} className="shrink-0 text-fg-subtle" />
                  <span className="min-w-0 flex-1 truncate text-12 text-fg">{item.name}</span>
                  {item.connected && (
                    <span className="flex shrink-0 items-center gap-1 text-10 text-success">
                      <span className="h-1 w-1 rounded-full bg-current" />
                      {t("Connected")}
                    </span>
                  )}
                  <span
                    className="flex shrink-0 items-center gap-1 text-11 text-fg-subtle"
                    title={timestampTitle(item.at)}
                  >
                    <Clock size={11} />
                    {relativeTime(item.at, t)}
                  </span>
                </span>
                <span className="flex min-w-0 items-center gap-1.5 pl-[21px] text-11 text-fg-subtle">
                  <FileCode2 size={10} className="shrink-0" />
                  <span className="truncate font-mono">{singleLine(item.sql, 80)}</span>
                </span>
              </button>
            ))}
          </ListPanel>
        )}
      </section>

      <section className="flex min-w-0 flex-col gap-2.5">
        <SectionHeading title={t("Recent projects")} />
        <div className="flex min-h-[76px] flex-1 flex-col items-center justify-center gap-1 rounded-[12px] border border-dashed border-line bg-surface-1/50 px-4 py-4 text-center">
          <Stack3Icon size={16} className="text-fg-subtle" />
          <p className="text-11 leading-relaxed text-fg-subtle">
            {t("Project access history is not recorded. Confirmed projects are listed under Assets below.")}
          </p>
          <Button variant="ghost" size="xs" className="mt-0.5" onClick={onOpenProjects}>
            {t("Open projects")}
          </Button>
        </div>
      </section>
    </div>
  );
}

function EmptyHint({ text }: { text: string }) {
  return (
    <div className="flex min-h-[76px] flex-1 items-center rounded-[12px] border border-dashed border-line bg-surface-1/50 px-4 py-3">
      <p className="text-11 leading-relaxed text-fg-subtle">{text}</p>
    </div>
  );
}
