import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { FileDescriptionIcon } from "@/components/icons";
import { readLatestReleaseNotes, type LatestReleaseNotes } from "@/api/release-notes";
import { useUpdaterStore } from "@/stores/updater-store";
import { useDomainStore } from "@/stores/domain-store";
import { formatBytes } from "@/lib/format";
import { UPDATE_ERROR_MESSAGES } from "@/lib/updater/errors";
import { useGuardedUpdate } from "./use-guarded-update";
import { UpdateRestartDialog } from "./UpdateRestartDialog";
import { exampleReleaseNotes } from "./example-release-notes";
import { version as bundledVersion } from "../../../package.json";
import "./release-notes.css";

/** Latest release only, rendered in the existing Settings page scroll region. */
export function ReleaseNotesPanel() {
  const { t, i18n } = useTranslation();
  const offered = useUpdaterStore(s => s.release);
  const phase = useUpdaterStore(s => s.phase);
  const progress = useUpdaterStore(s => s.progress);
  const updateError = useUpdaterStore(s => s.error);
  const currentVersion = useUpdaterStore(s => s.currentVersion);
  const check = useUpdaterStore(s => s.check);
  const appVersion = useDomainStore(s => s.appInfo?.version);
  const guard = useGuardedUpdate();
  const activeRelease = offered;
  const [notes, setNotes] = useState<LatestReleaseNotes | null>(null);
  const [loading, setLoading] = useState(false);
  const [readFailed, setReadFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);

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
  const example = !shown.notes?.trim();
  const date = shown.date ? new Date(shown.date) : null;
  const busy = phase === "checking" || phase === "downloading" || phase === "installing";
  const canInstall = !!offered && shown.version === offered.version &&
    ["available", "cancelled", "error", "downloaded"].includes(phase);
  const percentage = progress?.total && progress.total > 0
    ? Math.min(100, Math.round(progress.received / progress.total * 100)) : null;

  return <section className="release-notes-page" aria-label={t("Release notes")}>
    <div className="release-notes-cloud" aria-hidden="true"><i /><i /><i /></div>
    <header className="release-notes-heading">
      <span className="release-notes-symbol" aria-hidden="true"><FileDescriptionIcon size={26} strokeWidth={1.5} /></span>
      <h1>{t("Release notes")}</h1>
      <div className="release-notes-meta">
        <strong>v{shown.version}</strong>
        {example && <span>{t("Example release notes")}</span>}
        {date && !Number.isNaN(date.getTime()) && <time dateTime={shown.date!}>{date.toLocaleDateString(i18n.language, {year:"numeric",month:"long",day:"numeric"})}</time>}
      </div>
      <div className="release-notes-actions">
      <Button variant="secondary" size="sm" disabled={busy || phase === "restart_required"}
        onClick={() => void check({manual: true})}>{phase === "checking" ? t("Checking") : t("Check for updates")}</Button>
      {canInstall && <Button variant="primary" size="sm" disabled={busy} onClick={guard.requestInstall}>
        {phase === "downloaded" ? t("Install and restart") : t("Download and install")}
      </Button>}
      {phase === "restart_required" && <Button variant="primary" size="sm" onClick={guard.requestRestart}>{t("Restart now")}</Button>}
      </div>
    </header>
    <div className="release-notes-update-status" role="status" aria-live="polite">
        {phase === "checking" ? t("Checking for updates…")
          : phase === "downloading" ? `${t("Downloading update…")} ${percentage === null ? formatBytes(progress?.received ?? 0) : `${percentage}%`}`
          : phase === "installing" ? t("Installing update…")
          : phase === "downloaded" ? t("Downloaded — waiting for a safe moment to install")
          : phase === "restart_required" ? t("Update installed — restart to finish")
          : updateError ? t(UPDATE_ERROR_MESSAGES[updateError.code])
          : offered ? `${t("A new version is available")} · v${offered.version}`
          : phase === "up_to_date" ? t("You are already on the latest version") : t("Only the latest release is shown.")}
        {phase === "downloading" && <progress max={100} value={percentage ?? undefined} aria-label={t("Downloading update…")} />}
    </div>
        {loading && <p className="release-notes-reading" role="status">{t("Reading latest release notes…")}</p>}
        {readFailed && <div className="release-notes-read-error" role="status">
          <span>{t("Could not read release notes")}. {t("Showing example notes until release notes are available.")}</span>
          <Button variant="ghost" size="xs" onClick={() => setAttempt(value => value + 1)}>{t("Retry")}</Button>
        </div>}
        {example && <p className="release-notes-example-hint">{t("Example content only. Update availability is determined by checking for updates.")}</p>}
        <div className="release-notes-list" data-selectable>
          <ReleaseBody text={example ? exampleReleaseNotes(i18n.language) : shown.notes!} />
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
  return <>{sections.map((section, index) => <article className="release-notes-body" key={index}>{section}</article>)}</>;
}
function inline(text: string) {
  return text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g).map((part,index)=>part.startsWith("**")
    ? <strong key={index}>{part.slice(2,-2)}</strong>
    : part.startsWith("`") ? <code key={index}>{part.slice(1,-1)}</code> : part);
}
