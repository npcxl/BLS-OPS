import { APP_VERSION } from "@/app/app-meta";
import { useDomainStore } from "@/stores/domain-store";
import { selectActiveCount, selectConnectingCount, useSessionStore } from "@/stores/session-store";
import { cn } from "@/lib/cn";

/** Status Bar — spec §15. Every number here is derived from live state. */
export function StatusBar() {
  const active = useSessionStore(selectActiveCount);
  const connecting = useSessionStore(selectConnectingCount);
  const servers = useDomainStore((s) => s.servers);
  const credentials = useDomainStore((s) => s.credentials);
  const knownHosts = useDomainStore((s) => s.knownHosts);

  return (
    <footer className="flex h-6 shrink-0 items-center gap-0 border-t border-line bg-surface-1/60 px-2.5 text-11 text-fg-muted backdrop-blur-xl">
      <span className="flex items-center gap-1.5">
        <span
          className={cn(
            "h-[6px] w-[6px] rounded-full",
            active > 0 ? "bg-success" : connecting > 0 ? "bg-warning" : "bg-fg-subtle",
          )}
        />
        终端 {active}
        {connecting > 0 && <span className="text-fg-subtle">（连接中 {connecting}）</span>}
      </span>
      <Divider />
      <span>服务器 {servers.length}</span>
      <Divider />
      <span>凭据 {credentials.length}</span>
      <Divider />
      <span>已知主机 {knownHosts.length}</span>

      <div className="ml-auto flex items-center gap-3">
        <span>v{APP_VERSION}</span>
      </div>
    </footer>
  );
}

function Divider() {
  return <span className="mx-1.5 h-3 w-px bg-line" />;
}
