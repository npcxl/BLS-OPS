import { useState } from "react";
import { ArrowRight, ChevronDown, Clock, Plug } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useWorkbenchStore } from "@/stores/workbench-store";
import { cn } from "@/lib/cn";

/** Workbench Home — spec §28. */
interface RecentSession {
  id: string;
  name: string;
  host: string;
  when: string;
  connected: boolean;
}

const RECENT: RecentSession[] = [
  { id: "r1", name: "API-01", host: "10.0.0.11", when: "18 min ago", connected: true },
  { id: "r2", name: "WEB-01", host: "10.0.0.21", when: "Yesterday", connected: false },
  { id: "r3", name: "TEST-01", host: "10.0.0.51", when: "Aug 20", connected: false },
];

const FAVORITES = [
  { id: "f1", name: "API-01", host: "10.0.0.11" },
  { id: "f2", name: "WEB-01", host: "10.0.0.21" },
];

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-1.5">
      <h2 className="text-11 font-semibold tracking-[0.08em] text-fg-subtle uppercase">{title}</h2>
      {children}
    </section>
  );
}

export function WorkbenchHome() {
  const openTab = useWorkbenchStore((s) => s.openTab);
  const [qc, setQc] = useState("");

  const openServer = (name: string, host?: string) =>
    openTab({ id: crypto.randomUUID(), type: "terminal", title: name, subtitle: host, connected: true });

  return (
    <div className="h-full overflow-y-auto bg-app" data-selectable>
      <div className="mx-auto flex max-w-[760px] flex-col gap-6 p-6">
        <div>
          <h1 className="text-20 font-semibold text-fg">Workbench</h1>
          <p className="mt-0.5 text-12 text-fg-muted">Local operations console — servers, terminal, deploy.</p>
        </div>

        <Section title="Quick Connect">
          <div className="flex items-center gap-1.5">
            <div className="relative flex min-w-0 flex-1 items-center">
              <Plug size={13} className="absolute left-2.5 text-fg-subtle" />
              <input
                value={qc}
                onChange={(e) => setQc(e.target.value)}
                placeholder="user@host:22 — quick connect"
                spellCheck={false}
                className="h-[34px] w-full rounded-[6px] border border-line bg-surface-1 pl-8 pr-2 text-13 text-fg outline-none placeholder:text-fg-subtle focus:border-accent"
              />
            </div>
            <Button variant="primary" size="lg" onClick={() => openServer("Quick Connect") }>
              <ArrowRight size={14} />
              Connect
            </Button>
          </div>
        </Section>

        <Section title="Recent Sessions">
          <div className="flex flex-col gap-0.5">
            {RECENT.map((s) => (
              <button
                key={s.id}
                type="button"
                className="flex h-9 items-center gap-2 rounded-[6px] px-2.5 text-left hover:bg-surface-hover"
                onClick={() => openServer(s.name, s.host)}
              >
                <span className={cn("h-[7px] w-[7px] shrink-0 rounded-full", s.connected ? "bg-success" : "bg-fg-subtle")} />
                <span className="min-w-0 flex-1 truncate text-13 text-fg">
                  {s.name}
                  <span className="ml-2 text-11 text-fg-subtle">{s.host}</span>
                </span>
                <span className="flex shrink-0 items-center gap-1 text-11 text-fg-subtle">
                  <Clock size={11} />
                  {s.when}
                </span>
              </button>
            ))}
          </div>
        </Section>

        <Section title="Favorites">
          <div className="flex flex-wrap gap-1.5">
            {FAVORITES.map((f) => (
              <button
                key={f.id}
                type="button"
                className="flex h-[30px] items-center gap-1.5 rounded-control border border-line bg-surface-1 px-2.5 text-12 text-fg hover:border-line-strong hover:bg-surface-hover"
                onClick={() => openServer(f.name, f.host)}
              >
                <span className="h-[6px] w-[6px] rounded-full bg-success" />
                {f.name}
                <span className="text-11 text-fg-subtle">{f.host}</span>
              </button>
            ))}
          </div>
        </Section>

        <Section title="Running Tasks">
          <div className="flex h-9 items-center gap-2.5 rounded-[6px] border border-line bg-surface-1 px-2.5">
            <ChevronDown size={14} className="shrink-0 text-fg-subtle" />
            <span className="min-w-0 flex-1 truncate text-12 text-fg">docker pull nginx:1.27</span>
            <div className="h-1 w-32 shrink-0 overflow-hidden rounded-full bg-line">
              <div className="h-full w-[68%] rounded-full bg-accent" />
            </div>
            <span className="shrink-0 text-11 text-fg-muted">68%</span>
          </div>
        </Section>
      </div>
    </div>
  );
}
