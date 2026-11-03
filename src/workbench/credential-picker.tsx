import { useEffect, useId, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { CredentialRecord } from "@/api/ops-api";
import { emptyCredential, useDomainStore } from "@/stores/domain-store";
import { Field, Modal } from "@/components/ui/modal";
import { Button } from "@/components/ui/button";
import { controlBase, SearchField } from "@/components/ui/input";
import { Check, ChevronDown, KeyRound, Plus } from "@/components/icons";
import { cn } from "@/lib/cn";
import { CredentialForm } from "./credential-form";

export function CredentialPicker({value, username, host, label, noneLabel, onChange, onCreated, onEditingChange}: {
  value: string; username: string; host?: string; label?: string; noneLabel?: string;
  onChange: (id: string) => void; onCreated?: (credential: CredentialRecord) => void;
  onEditingChange: (editing: boolean) => void;
}) {
  const {t} = useTranslation();
  const credentials = useDomainStore(state=>state.credentials);
  const [draft, setDraft] = useState<CredentialRecord | null>(null);
  const [created, setCreated] = useState<CredentialRecord | null>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const listRef = useRef<HTMLDivElement>(null);
  const dialogId = useId();
  const choices = created && !credentials.some(c=>c.id===created.id) ? [...credentials,created] : credentials;
  const selected = choices.find(credential=>credential.id===value);
  const matches = useMemo(()=>{
    const search = query.trim().toLocaleLowerCase();
    return choices.filter(c=>[c.name,c.username,c.credential_type,t(c.credential_type==="private_key"?"Private key":"Password")]
      .join(" ").toLocaleLowerCase().includes(search));
  },[choices,query,t]);
  useEffect(()=>{if(listRef.current)listRef.current.scrollTop=0;},[query,open]);
  const close = () => {setDraft(null);onEditingChange(false);};
  const choose = (id: string) => {setOpen(false);onChange(id);};
  const create = () => {
    setOpen(false);
    setDraft({...emptyCredential(),username:username.trim()||"root",name:host ? `${username.trim()||"root"}@${host.trim()}` : ""});
    onEditingChange(true);
  };
  return <div className="flex flex-col gap-3">
    <Field label={label ?? t("Credential")}>
      <button type="button" aria-label={label ?? t("Credential")} aria-haspopup="dialog"
        aria-expanded={open} disabled={draft!==null}
        title={selected ? `${selected.name} · ${selected.username}` : undefined}
        onClick={()=>{setQuery("");setOpen(true);}}
        className={cn(controlBase,"flex h-[30px] items-center gap-2 border-line px-2 text-left text-12")}>
        <KeyRound size={13} className="shrink-0 text-fg-subtle" />
        <span className={cn("min-w-0 flex-1 truncate",!selected&&"text-fg-subtle")}>
          {draft ? t("Add credential") : selected ? `${selected.name} · ${selected.username}` : noneLabel ?? t("No credential")}
        </span>
        <ChevronDown size={12} className="shrink-0 text-fg-subtle" />
      </button>
    </Field>
    <Modal open={open} size="lg" title={t("Select credential")} onClose={()=>setOpen(false)}
      footer={<>
        <Button variant="ghost" size="sm" className="mr-auto" onClick={()=>choose("")}>{noneLabel ?? t("No credential")}</Button>
        <Button variant="secondary" size="sm" onClick={create}><Plus size={13} />{t("Enter now and save credential")}</Button>
      </>}>
      <div className="flex min-h-0 flex-col gap-3" style={{height:"min(420px, calc(85vh - 156px))"}}>
        <SearchField value={query} onChange={setQuery} size="md" autoFocus
          placeholder={t("Search credentials by name or username…")} aria-label={t("Search credentials")}
          onKeyDown={event=>{if(event.key==="ArrowDown"){event.preventDefault();listRef.current?.querySelector<HTMLButtonElement>("[role=option]")?.focus({preventScroll:true});}}} />
        <div className="flex shrink-0 items-center justify-between text-11 text-fg-subtle">
          <span>{t("Saved credentials")}</span><span className="tabular-nums">{matches.length} / {choices.length}</span>
        </div>
        <div ref={listRef} role="listbox" aria-label={t("Saved credentials")} id={dialogId}
          className="ops-scroll relative min-h-0 flex-1 overflow-y-auto overscroll-contain rounded-[8px] border border-line/60"
          onKeyDown={event=>{
            if(!["ArrowDown","ArrowUp","Home","End"].includes(event.key))return;
            const nodes=Array.from(listRef.current?.querySelectorAll<HTMLButtonElement>("[role=option]")??[]);
            if(!nodes.length)return;
            event.preventDefault();
            const current=nodes.indexOf(document.activeElement as HTMLButtonElement);
            const index=event.key==="Home"?0:event.key==="End"?nodes.length-1:(current+(event.key==="ArrowDown"?1:-1)+nodes.length)%nodes.length;
            const node=nodes[index], list=listRef.current!;
            node.focus({preventScroll:true});
            if(node.offsetTop<list.scrollTop)list.scrollTop=node.offsetTop;
            else if(node.offsetTop+node.offsetHeight>list.scrollTop+list.clientHeight)list.scrollTop=node.offsetTop+node.offsetHeight-list.clientHeight;
          }}>
          {matches.map(c=><button key={c.id} type="button" role="option" aria-selected={c.id===value}
            onClick={()=>choose(c.id)} className={cn("flex w-full items-center gap-3 border-b border-line/50 px-3 py-3 text-left last:border-0 hover:bg-surface-hover focus-visible:bg-surface-hover focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent",c.id===value&&"bg-surface-active")}>
            <KeyRound size={16} className="shrink-0 text-fg-subtle" />
            <span className="min-w-0 flex-1"><span className="block truncate text-12 font-medium text-fg">{c.name}</span>
              <span className="mt-0.5 block truncate text-11 text-fg-subtle">{c.username}</span></span>
            <span className="shrink-0 rounded bg-surface-2 px-1.5 py-0.5 text-10 text-fg-muted">{t(c.credential_type==="private_key"?"Private key":"Password")}</span>
            <span className="grid size-4 shrink-0 place-items-center">{c.id===value&&<Check size={14} className="text-accent" />}</span>
          </button>)}
          {!matches.length&&<div className="flex h-full min-h-24 flex-col items-center justify-center gap-3 p-6 text-12 text-fg-subtle">
            <KeyRound size={24} strokeWidth={1.4} />
            <p>{t(query.trim()?"No matching credentials":"No saved credentials")}</p>
            {query.trim()&&<Button variant="ghost" size="sm" onClick={()=>setQuery("")}>{t("Clear search")}</Button>}
          </div>}
        </div>
      </div>
    </Modal>
    {draft && <section className="rounded-[10px] border border-line bg-surface-2/40 p-4">
      <h3 className="mb-3 text-12 font-medium text-fg">{t("Add credential")}</h3>
      <CredentialForm key={draft.id} credential={draft} variant="inline" onClose={close}
        onSaved={credential=>{setCreated(credential);onChange(credential.id);onCreated?.(credential);}} />
    </section>}
  </div>;
}
