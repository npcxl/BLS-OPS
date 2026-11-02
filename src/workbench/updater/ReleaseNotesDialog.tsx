import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import LiquidGlass from "liquid-glass-react";
import { FileDescriptionIcon } from "@/components/icons";
import { Modal } from "@/components/ui/modal";
import { Button } from "@/components/ui/button";
import { LoadingState } from "@/components/ui/loading";
import { ErrorState } from "@/components/ui/error-state";
import { readLatestReleaseNotes, type LatestReleaseNotes } from "@/api/release-notes";
import type { UpdateRelease } from "@/api/types/updater";
import "./release-notes.css";

/** Latest only, read-only. Update signatures/install/restart still belong to the updater. */
export function ReleaseNotesDialog({ open, onClose, release, action }: {
  open: boolean; onClose: () => void; release?: UpdateRelease | null; action?: React.ReactNode;
}) {
  const { t, i18n } = useTranslation();
  const [notes, setNotes] = useState<LatestReleaseNotes | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!open) return;
    let current = true;
    setError(null);
    // A just-checked update is already the latest release from this endpoint.
    if (release) { setNotes(release); setLoading(false); return; }
    setLoading(true);
    setNotes(null);
    void readLatestReleaseNotes().then(value => { if (current) setNotes(value); })
      .catch(cause => { if (current) setError(cause); })
      .finally(() => { if (current) setLoading(false); });
    return () => { current = false; };
  }, [open, release, attempt]);
  const date = notes?.date ? new Date(notes.date) : null;
  return <Modal open={open} fullscreen className="release-notes-modal glass-host"
    title={t("Release notes")} onClose={onClose}
    footer={<><Button variant="ghost" size="sm" onClick={onClose}>{t("Close")}</Button>{action}</>}>
    <LiquidGlass className="release-notes-glass" cornerRadius={22} padding="0"
      displacementScale={24} blurAmount={0.4} saturation={120} aberrationIntensity={1} elasticity={0.06}
      style={{ width: "100%", height: "100%" }}>
      <div className="release-notes-glass-tint" />
    </LiquidGlass>
    <div className="release-notes-content">
      {loading ? <LoadingState className="min-h-64" label={t("Reading latest release notes…")} />
        : error ? <ErrorState error={error} title={t("Could not read release notes")} onRetry={() => setAttempt(value => value + 1)} />
        : notes && <>
          <div className="release-notes-intro">
            <span className="release-notes-symbol"><FileDescriptionIcon size={27} strokeWidth={1.5} /></span>
            <h1>{t("What's new")}</h1>
            <div className="release-notes-meta"><strong>v{notes.version}</strong>
              {date && !Number.isNaN(date.getTime()) && <time dateTime={notes.date!}>{date.toLocaleDateString(i18n.language, {year:"numeric",month:"long",day:"numeric"})}</time>}
            </div>
          </div>
          <article className="release-notes-body" data-selectable>
            {notes.notes?.trim() ? <ReleaseBody text={notes.notes} /> : <p className="text-fg-subtle">{t("No release notes were provided for this version.")}</p>}
          </article>
        </>}
    </div>
  </Modal>;
}

/** Render release text as text nodes, never remote HTML. */
function ReleaseBody({text}: {text: string}) {
  const lines = text.replace(/\r\n/g,"\n").split("\n");
  const blocks: React.ReactNode[] = [];
  for (let i=0; i<lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    if (/^```/.test(line)) {
      const code: string[] = [];
      while (++i < lines.length && !/^```/.test(lines[i])) code.push(lines[i]);
      blocks.push(<pre key={i}><code>{code.join("\n")}</code></pre>);
    } else if (/^#{1,6}\s/.test(line)) {
      blocks.push(<h2 key={i}>{inline(line.replace(/^#{1,6}\s+/,""))}</h2>);
    } else if (/^\s*(?:[-*+] |\d+\. )/.test(line)) {
      const items: string[] = [line];
      while (i+1 < lines.length && /^\s*(?:[-*+] |\d+\. )/.test(lines[i+1])) items.push(lines[++i]);
      blocks.push(<ul key={i}>{items.map((item,index)=><li key={index}>{inline(item.replace(/^\s*(?:[-*+] |\d+\. )/,""))}</li>)}</ul>);
    } else if (!/^\s*([-*_])\1{2,}\s*$/.test(line)) {
      blocks.push(<p key={i}>{inline(line)}</p>);
    }
  }
  return <>{blocks}</>;
}
function inline(text: string) {
  return text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g).map((part,index)=>part.startsWith("**")
    ? <strong key={index}>{part.slice(2,-2)}</strong>
    : part.startsWith("`") ? <code key={index}>{part.slice(1,-1)}</code> : part);
}
