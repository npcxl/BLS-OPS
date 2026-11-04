import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { readLatestReleaseNotes, type LatestReleaseNotes } from "@/api/release-notes";
import { useUpdaterStore } from "@/stores/updater-store";
import { useDomainStore } from "@/stores/domain-store";
import { formatBytes } from "@/lib/format";
import { UPDATE_ERROR_MESSAGES } from "@/lib/updater/errors";
import { useGuardedUpdate } from "./use-guarded-update";
import { UpdateRestartDialog } from "./UpdateRestartDialog";
import { releaseHistory } from "./release-history";
import { MacSegmentedControl } from "@/components/ui/mac-controls";
import { version as bundledVersion } from "../../../package.json";
import "./release-notes.css";

/** Published history shares the existing Settings scroll region and updater. */
export function ReleaseNotesPanel() {
  const { t, i18n } = useTranslation();
  const offered = useUpdaterStore(s => s.release);
  const phase = useUpdaterStore(s => s.phase);
  const progress = useUpdaterStore(s => s.progress);
  const updateError = useUpdaterStore(s => s.error);
  const currentVersion = useUpdaterStore(s => s.currentVersion);
  const appVersion = useDomainStore(s => s.appInfo?.version);
  const guard = useGuardedUpdate();
  const activeRelease = offered;
  const [notes, setNotes] = useState<LatestReleaseNotes | null>(null);
  const [loading, setLoading] = useState(false);
  const [readFailed, setReadFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [filter, setFilter] = useState("all");

  useEffect(() => {
    let current = true;
    setReadFailed(false);
    if (activeRelease) { setNotes(activeRelease); setLoading(false); return; }
    setLoading(true);
    setNotes(null);
    void readLatestReleaseNotes().then(value => { if (current) setNotes(value); })
      .catch(() => { if (current) setReadFailed(true); })
      .finally(() => { if (current) setLoading(false); });
    return () => { current = false; };
  }, [activeRelease, attempt]);

  const shown = notes ?? { version: currentVersion ?? appVersion ?? bundledVersion, date: null, notes: null };
  const remoteOnly = !!notes && !releaseHistory.some(entry => entry.version === notes.version.replace(/^v/, ""));
  const history = releaseHistory.map(entry => ({ ...entry,
    upcoming: !!entry.upcoming && notes?.version.replace(/^v/, "") !== entry.version,
  }));
  const visibleHistory = history.map(entry => ({ ...entry,
    changes: entry.changes.filter(change => filter === "all" || change.kind === filter),
  })).filter(entry => entry.changes.length > 0);
  const showRemote = remoteOnly && filter === "all";
  const releaseCount = history.filter(entry => !entry.upcoming).length + (remoteOnly ? 1 : 0);
  const busy = phase === "checking" || phase === "downloading" || phase === "installing";
  const canInstall = !!offered && shown.version === offered.version &&
    ["available", "cancelled", "error", "downloaded"].includes(phase);
  const percentage = progress?.total && progress.total > 0
    ? Math.min(100, Math.round(progress.received / progress.total * 100)) : null;

  return <section className="release-notes-page" aria-label={t("Release notes")}>
    <div className="release-notes-cloud" aria-hidden="true"><i /><i /><i /></div>
        <div className="release-notes-filter-bar">
          <MacSegmentedControl aria-label={t("Filter release notes")} value={filter} onChange={setFilter}
            options={[
              {value: "all", label: t("All versions")},
              {value: "feature", label: t("Highlights")},
              {value: "fix", label: t("Performance and fixes")},
            ]} />
          <span>{t("{{count}} published releases", {count: releaseCount})}</span>
        </div>
    {(busy || offered || updateError || phase === "restart_required") && <div className="release-notes-update-status" role="status" aria-live="polite">
        {phase === "checking" ? t("Checking for updates…")
          : phase === "downloading" ? `${t("Downloading update…")} ${percentage === null ? formatBytes(progress?.received ?? 0) : `${percentage}%`}`
          : phase === "installing" ? t("Installing update…")
          : phase === "downloaded" ? t("Downloaded — waiting for a safe moment to install")
          : phase === "restart_required" ? t("Update installed — restart to finish")
          : updateError ? t(UPDATE_ERROR_MESSAGES[updateError.code])
          : offered ? `${t("A new version is available")} · v${offered.version}`
          : phase === "up_to_date" ? t("You are already on the latest version") : t("Published release history")}
        {phase === "downloading" && <progress max={100} value={percentage ?? undefined} aria-label={t("Downloading update…")} />}
      {canInstall && <Button variant="primary" size="sm" disabled={busy} onClick={guard.requestInstall}>
        {phase === "downloaded" ? t("Install and restart") : t("Download and install")}
      </Button>}
      {phase === "restart_required" && <Button variant="primary" size="sm" onClick={guard.requestRestart}>{t("Restart now")}</Button>}
    </div>}
        {loading && <p className="release-notes-reading" role="status">{t("Reading latest release notes…")}</p>}
        {readFailed && <div className="release-notes-read-error" role="status">
          <span>{t("Showing saved release history. Latest notes could not be refreshed.")}</span>
          <Button variant="ghost" size="xs" onClick={() => setAttempt(value => value + 1)}>{t("Retry")}</Button>
        </div>}
        <div className="release-notes-list" data-selectable>
          {showRemote && <article className="release-notes-body release-notes-version release-notes-version--latest">
            <header className="release-notes-version-header">
              <span className="release-notes-version-tag">v{shown.version}</span>
              <h2>{t("What's new")}</h2>
              {shown.date && !Number.isNaN(Date.parse(shown.date)) && <time dateTime={shown.date}>{new Date(shown.date).toLocaleDateString(i18n.language)}</time>}
            </header>
            {shown.notes?.trim() ? <ReleaseBody text={shown.notes} /> : <p>{t("No release notes were provided for this version.")}</p>}
          </article>}
          {visibleHistory.map(entry => <article key={entry.version}
            className={"release-notes-body release-notes-version" + (entry.version === releaseHistory[0].version && !remoteOnly ? " release-notes-version--latest" : "")}>
            <header className="release-notes-version-header">
              <span className="release-notes-version-tag">v{entry.version}</span>
              <h2>{entry.title}</h2>
              {entry.upcoming && <span className="text-11 text-fg-subtle">{t("Upcoming release")}</span>}
              <time dateTime={entry.date}>{entry.date}</time>
            </header>
            <ul>{entry.changes.map((change, index) => <li key={index}>
              <strong>{change.title}：</strong>{change.text}
            </li>)}</ul>
          </article>)}
        </div>
    <UpdateRestartDialog open={guard.pendingAction !== null}
      action={guard.pendingAction === "restart" ? "restart" : "install"}
      blockers={guard.blockers} onConfirm={guard.confirm} onCancel={guard.cancel} />
  </section>;
}

/** Render release text as text nodes, never remote HTML. */
function ReleaseBody({text}: {text: string}) {
  const lines = text.replace(/\r\n/g,"\n").split("\n");
  const sections: React.ReactNode[][] = [];
  let blocks: React.ReactNode[] = [];
  for (let i=0; i<lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    if (/^```/.test(line)) {
      const code: string[] = [];
      while (++i < lines.length && !/^```/.test(lines[i])) code.push(lines[i]);
      blocks.push(<pre key={i}><code>{code.join("\n")}</code></pre>);
    } else if (/^#{1,6}\s/.test(line)) {
      if (blocks.length) sections.push(blocks);
      blocks = [];
      blocks.push(<h2 key={i}>{inline(line.replace(/^#{1,6}\s+/,""))}</h2>);
    } else if (/^\s*(?:[-*+] |\d+\. )/.test(line)) {
      const items: string[] = [line];
      while (i+1 < lines.length && /^\s*(?:[-*+] |\d+\. )/.test(lines[i+1])) items.push(lines[++i]);
      blocks.push(<ul key={i}>{items.map((item,index)=><li key={index}>{inline(item.replace(/^\s*(?:[-*+] |\d+\. )/,""))}</li>)}</ul>);
    } else if (!/^\s*([-*_])\1{2,}\s*$/.test(line)) {
      blocks.push(<p key={i}>{inline(line)}</p>);
    }
  }
  if (blocks.length) sections.push(blocks);
  return <>{sections.map((section, index) => <article className="release-notes-text-section" key={index}>{section}</article>)}</>;
}
function inline(text: string) {
  return text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g).map((part,index)=>part.startsWith("**")
    ? <strong key={index}>{part.slice(2,-2)}</strong>
    : part.startsWith("`") ? <code key={index}>{part.slice(1,-1)}</code> : part);
}
