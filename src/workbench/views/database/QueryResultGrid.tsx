import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Modal } from "@/components/ui/modal";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { ContextMenu, useContextMenu } from "@/components/ui/context-menu";
import { NoticePill, type NoticeTone } from "@/components/ui/copy-notice-surface";
import { databaseApi } from "@/api/ops-api";
import type { AssignValue, DbTableDetail, DbValue } from "@/api/types/database";
import { useDatabaseStore, toDbError } from "@/stores/database-store";
import { useDatabaseWorkbenchStore, type StatementResult } from "@/stores/database-workbench-store";
import { VirtualDataGrid, type CellAddress, type DataGridApi } from "./VirtualDataGrid";
import { PendingChangeList, type PendingChange } from "./PendingChangeList";
import { sameAssignment } from "./pending-value-diff";
import { pendingRow } from "./pending-row";
import { queryEditTarget, validateQueryKey } from "./query-edit-plan";
import { capabilityAllows, engineMeta } from "./db-engines";
import { copyMenuItems } from "./grid/copy-menu";
import { iterateSelectionCells, MAX_ENUMERATED_CELLS, selectionStats } from "./grid/selection";
import { parseClipboardMatrix, planPaste, type PasteCell } from "./grid/paste";
import type { CopyFormat } from "./grid/copy-format";

type Draft = Extract<PendingChange, {kind: "update"}> & {row: number};
const raw = (v: DbValue): string => v.kind === "null" ? "" : v.kind === "unsupported" ? v.preview : v.kind === "binary" ? v.base64 : String(v.value);
const assign = (v: DbValue): AssignValue => v.kind === "null" ? {kind:"null"} : {kind:"value",value:raw(v)};
const unsafe = (v: DbValue) => v.kind === "binary" || v.kind === "bit" || v.kind === "unsupported" || ((v.kind === "text" || v.kind === "json") && v.truncated);

/** Uses the same mutation API, original-value checks, draft projection and
 * change viewer as table editing. No SQL re-execution is used to apply changes. */
export function QueryResultGrid({tabId, result, active, apiRef, onCopy, onOpenCell, onPendingCount}: {
  tabId: string; result: StatementResult; active: boolean; apiRef?: RefObject<DataGridApi | null>;
  onCopy: (format: CopyFormat, headers?: boolean) => void;
  onOpenCell: (cell: CellAddress, value: DbValue) => void;
  onPendingCount: (key: string, count: number) => void;
}) {
  const {t}=useTranslation();
  const localApi=useRef<DataGridApi | null>(null);
  const grid=apiRef ?? localApi;
  const tab=useDatabaseWorkbenchStore(s=>s.tabs[tabId]);
  const profile=useDatabaseStore(s=>s.profiles.find(p=>p.id===tab?.profileId));
  const session=useDatabaseStore(s=>tab ? s.sessions[tab.profileId] : undefined);
  const [metadata,setMetadata]=useState<DbTableDetail | null>(null);
  const [metadataError,setMetadataError]=useState<string | null>(null);
  const [attempt,setAttempt]=useState(0);
  const [drafts,setDrafts]=useState<Draft[]>([]);
  const [past,setPast]=useState<Draft[][]>([]);
  const [future,setFuture]=useState<Draft[][]>([]);
  const [editing,setEditing]=useState<{cell:CellAddress;value:string} | null>(null);
  const editCommitted=useRef(false);
  const [busy,setBusy]=useState(false);
  const busyRef=useRef(false);
  const [notice,setNotice]=useState<string | null>(null);
  const [noticeTone,setNoticeTone]=useState<NoticeTone>("warning");
  useEffect(()=>{
    if (!notice || noticeTone!=="success") return;
    const timer=window.setTimeout(()=>setNotice(null),3500);
    return()=>window.clearTimeout(timer);
  },[notice,noticeTone]);
  const [locked,setLocked]=useState(false);
  const [showChanges,setShowChanges]=useState(false);
  const [paste,setPaste]=useState<PasteCell[] | null>(null);
  const target=useMemo(()=>{
    try {
      if (!result.sourceSql) throw new Error("结果缺少完整查询信息，请重新执行查询");
      return {value:queryEditTarget(result.sourceSql,profile?.engine ?? "",result.columns),reason:null};
    } catch (error) {return {value:null,reason:(error as Error).message};}
  },[result.sourceSql,result.columns,profile?.engine]);
  const basicReason = !profile || profile.read_only || session?.read_only ? "连接为只读或不可用"
    : !session || session.state === "lost" ? "连接已断开"
    : !result.sessionId || session.session_id!==result.sessionId || session.generation!==result.generation ? "结果属于旧会话，请重新执行查询"
    : tab?.resultWriteInFlight ? "正在提交结果修改，请稍候"
    : tab?.runState!=="completed" || result.error ? "查询尚未成功完成，结果只读"
    : !capabilityAllows(engineMeta(profile.engine).descriptor,"table_edit") ? "该引擎暂不支持数据修改"
    : session.transaction==="unknown" ? "无法确认事务状态，结果只读"
    : session.transaction!=="none" ? "请先结束当前事务，再编辑查询结果"
    : target.reason;
  useEffect(()=>{
    if (!active || basicReason || !target.value || !profile || metadata) return;
    let current=true;setMetadataError(null);
    void databaseApi.tableDetail(profile.id,target.value.database,target.value.table)
      .then(detail=>{if(current)setMetadata(detail);})
      .catch(error=>{if(current)setMetadataError(toDbError(error).message);});
    return()=>{current=false;};
  },[active,basicReason,target,profile?.id,metadata,attempt]);
  /*
   * `drainQuery` 追加行批次时是**原地 push**（避免百万行时每批复制整个数组），
   * 数组引用不会变；如果 useMemo 只依赖 `result.rows`，就会一直返回第一次
   * 缓存的空数组 —— 统计写着 20 行、网格却一行不画。行数必须进依赖。
   */
  const key=useMemo(()=>{
    if (!target.value || !metadata) return {indexes:[] as number[],reason:null};
    try {return {indexes:validateQueryKey(target.value,metadata,result.rows),reason:null};}
    catch(error){return {indexes:[] as number[],reason:(error as Error).message};}
  },[target,metadata,result.rows,result.rows.length]);
  const reason=basicReason ?? metadataError ?? (!metadata ? "正在验证原表与主键…" : key.reason)
    ?? (locked ? "结果需要重新查询后才能继续编辑" : null);
  const editable=!reason && !locked && !busy;
  useEffect(()=>{onPendingCount(result.key,drafts.length);},[result.key,drafts.length,onPendingCount]);
  useEffect(()=>()=>onPendingCount(result.key,0),[result.key,onPendingCount]);
  const rows=useMemo(()=>result.rows.map((row,index)=>{
    const draft=drafts.find(d=>d.row===index);
    return draft && target.value ? pendingRow(row,target.value.names,draft.values) : row;
  }),[result.rows,result.rows.length,drafts,target]);
  const modified=useMemo(()=>new Set(drafts.flatMap(d=>d.values.map(v=>`${d.row}:${target.value?.names.indexOf(v.column)}`))),[drafts,target]);
  const writable=(cell:CellAddress)=>{
    const value=result.rows[cell.row]?.[cell.col];
    const column=metadata?.columns.find(c=>c.name===target.value?.names[cell.col]);
    return !!value && !!column && !unsafe(value) && !/bit|blob|binary|geometry|bytea/i.test(column.data_type);
  };
  const change=(cells:PasteCell[])=>{
    if (!editable || !metadata || !target.value) return;
    setNoticeTone("warning");
    const current=useDatabaseWorkbenchStore.getState().tabs[tabId];
    const liveSession=profile && useDatabaseStore.getState().sessions[profile.id];
    if (current?.runState!=="completed" || !current.results.some(r=>r.key===result.key && r.rows===result.rows)
      || liveSession?.session_id!==result.sessionId || liveSession?.generation!==result.generation) return;
    const names=target.value.names;
    if (cells.some(c=>!writable(c))) {setNotice(t("所选字段包含只读、二进制或截断值，不能修改"));return;}
    if (cells.some(c=>c.value.kind==="null" && !metadata.columns.find(m=>m.name===names[c.col])?.nullable)) {
      setNotice(t("所选字段不允许 NULL，已阻止修改"));return;
    }
    const next=drafts.map(d=>({...d,values:[...d.values]}));
    for (const cell of cells) {
      const original=result.rows[cell.row];const column=names[cell.col];
      let draft=next.find(d=>d.row===cell.row);
      if (!draft) {
        draft={id:`${result.key}:${cell.row}`,kind:"update",row:cell.row,
          key:key.indexes.map(i=>assign(original[i])),
          label:key.indexes.map(i=>`${names[i]}=${raw(original[i])}`).join(", "), values:[],
          expected:original.flatMap((v,i)=>unsafe(v)?[]:[{column:names[i],value:assign(v)}])};
        next.push(draft);
      }
      draft.values=draft.values.filter(v=>v.column!==column);
      if (!sameAssignment(assign(original[cell.col]),cell.value)) draft.values.push({column,value:cell.value});
    }
    const changed=next.filter(d=>d.values.length);
    onPendingCount(result.key,changed.length);
    setPast(p=>[...p.slice(-49),drafts]);setFuture([]);setDrafts(changed);setNotice(null);
  };
  const startEdit=(cell:CellAddress)=>{
    if (!editable) return;
    if (!writable(cell)) {onOpenCell(cell,rows[cell.row][cell.col]);return;}
    editCommitted.current=false;setEditing({cell,value:raw(rows[cell.row][cell.col])});
  };
  const undo=()=>{if(!busy && past.length){setFuture(f=>[drafts,...f]);setDrafts(past[past.length-1]);setPast(p=>p.slice(0,-1));}};
  const redo=()=>{if(!busy && future.length){setPast(p=>[...p,drafts]);setDrafts(future[0]);setFuture(f=>f.slice(1));}};
  const apply=async()=>{
    if (busyRef.current || !editable || !drafts.length || !metadata || !target.value || !profile || !session) return;
    if (useDatabaseWorkbenchStore.getState().tabs[tabId]?.resultWriteInFlight) return;
    useDatabaseWorkbenchStore.getState().setResultWriteInFlight(tabId,true);
    busyRef.current=true;setBusy(true);setNotice(null);setNoticeTone("danger");
    const submitted=drafts;const sourceRows=result.rows;
    try {
      const fresh=await databaseApi.sessionInfo(session.session_id);
      const current=useDatabaseStore.getState().profiles.find(p=>p.id===profile.id);
      if (!current || current.read_only || fresh.read_only || fresh.state==="lost" || fresh.generation!==result.generation || fresh.session_id!==result.sessionId || fresh.transaction!=="none") throw new Error("连接、权限或事务状态已变化，请重新执行查询");
      await databaseApi.invalidateMetadata(profile.id);
      const detail=await databaseApi.tableDetail(profile.id,target.value.database,target.value.table);
      validateQueryKey(target.value,detail,sourceRows);
      if (JSON.stringify(detail.primary_key)!==JSON.stringify(metadata.primary_key)) throw new Error("原表主键已变化，请重新执行查询");
      const live=useDatabaseWorkbenchStore.getState().tabs[tabId];
      if (live?.runState!=="completed" || !live.results.some(r=>r.key===result.key && r.rows===sourceRows)) throw new Error("查询结果已变化，已停止提交");
      const outcome=await databaseApi.mutate({sessionId:session.session_id,database:target.value.database,table:target.value.table,
        rows:submitted.map(d=>({kind:"update",key:d.key,values:d.values,expected:d.expected}))});
      if (outcome.state!=="committed") {
        setNoticeTone(outcome.state==="outcome_unknown"?"warning":"danger");
        if (outcome.state==="outcome_unknown") setLocked(true);
        setNotice(outcome.state==="outcome_unknown" ? t("提交结果未知，请核对数据库；已停止重复提交")
          : outcome.outcomes.find(o=>o.error)?.error?.message ?? outcome.warning ?? t("已回滚，暂存修改已保留"));return;
      }
      setDrafts([]);setPast([]);setFuture([]);setShowChanges(false);
      const updated=sourceRows.map((row,i)=>{
        const draft=submitted.find(d=>d.row===i);return draft?pendingRow(row,target.value!.names,draft.values):row;
      });
      let reloadFailed=false;
      for (const draft of submitted) {
        try {
          const answer=await databaseApi.browse({session_id:session.session_id,database:target.value.database,table:target.value.table,
            filters:key.indexes.map(i=>({column:target.value!.names[i],op:"eq" as const,value:raw(updated[draft.row][i])})),page_size:1,exact_count:false});
          if (answer.rows.length!==1) throw new Error("记录已变化");
          const canonical=target.value.names.map(n=>answer.rows[0][answer.columns.findIndex(c=>c.name===n)]);
          if (canonical.some(v=>!v)) throw new Error("字段已变化");
          updated[draft.row]=canonical;
        } catch {reloadFailed=true;}
      }
      useDatabaseWorkbenchStore.setState(state=>{
        const tab=state.tabs[tabId];if(!tab)return state;
        return {tabs:{...state.tabs,[tabId]:{...tab,results:tab.results.map(r=>r.key===result.key && r.rows===sourceRows?{...r,rows:updated}:r)}}};
      });
      setLocked(reloadFailed);setNoticeTone(reloadFailed?"warning":"success");setNotice(reloadFailed?t("修改已写入，但无法重新读取记录。请重新运行查询后继续编辑。")
        :t("修改已写入；重新运行查询可更新筛选与排序。"));
    } catch(error){
      const failure=toDbError(error);
      if (failure.stage==="outcome_unknown") setLocked(true);
      setNotice(failure.message);
    }
    finally{busyRef.current=false;setBusy(false);useDatabaseWorkbenchStore.getState().setResultWriteInFlight(tabId,false);}
  };
  const menu=useContextMenu();
  const openMenu=(cell:CellAddress | null,event:React.MouseEvent)=>menu.onContextMenu(()=>[
    ...copyMenuItems({t,hasSelection:(grid.current?.getSelection().mode ?? null)!==null,canInsert:false,onCopy}),
    ...(cell?[{separator:true},{id:"edit",label:t("编辑"),disabled:!editable || !writable(cell),onSelect:()=>startEdit(cell)},
      {id:"view",label:t("查看值"),onSelect:()=>onOpenCell(cell,rows[cell.row][cell.col])},
      {id:"null",label:t("设为 NULL"),disabled:!editable || !writable(cell),onSelect:()=>change([{...cell,value:{kind:"null"}}])}]:[]),
  ])(event);
  return <div className="relative flex h-full min-h-0 flex-col">
    <div className="page-toolbar">
      <span className="page-toolbar-grow min-w-0 truncate text-11 text-fg-subtle" title={reason ?? `${target.value?.database}.${target.value?.table}`}>
        {reason ? t("只读：{{reason}}",{reason:t(reason)}) : t("可编辑 · {{table}}",{table:`${target.value?.database}.${target.value?.table}`})}
      </span>
      {metadataError && <Button size="xs" onClick={()=>setAttempt(a=>a+1)}>{t("重试")}</Button>}
      <Button size="xs" disabled={(!drafts.length && !editing) || busy} onClick={()=>setShowChanges(true)}>{t("查看变更")}{drafts.length?` (${drafts.length})`:""}</Button>
      <Button size="xs" disabled={!past.length || busy} onClick={undo}>{t("撤销")}</Button>
      <Button size="xs" disabled={!future.length || busy} onClick={redo}>{t("重做")}</Button>
      <Button size="xs" disabled={!drafts.length || busy} onClick={()=>{setDrafts([]);setPast([]);setFuture([]);}}>{t("还原")}</Button>
      <Button variant="primary" size="xs" disabled={(!drafts.length && !editing) || !editable} onClick={()=>void apply()}>{busy?t("保存中…"):t("应用修改")}</Button>
    </div>
    {notice && <div className="pointer-events-none absolute bottom-3 left-1/2 z-40 w-max max-w-[90%] -translate-x-1/2" role="status">
      <div className="pointer-events-auto"><NoticePill tone={noticeTone} onDismiss={()=>setNotice(null)}>{notice}</NoticePill></div>
    </div>}
    <div className="min-h-0 flex-1"><VirtualDataGrid apiRef={grid} columns={result.columns} rows={rows} selectionKey={result.key} editable={editable} modifiedCells={modified}
      editingCell={editing?.cell} editingValue={editing?.value ?? ""} onEditingValueChange={value=>setEditing(e=>e?{...e,value}:e)}
      onStartEdit={startEdit} onCancelEdit={()=>{editCommitted.current=true;setEditing(null);}} onCommitEdit={(cell,move)=>{
        if (!editing || editCommitted.current) return;editCommitted.current=true;
        if (editing.value!==raw(rows[cell.row][cell.col])) change([{...cell,value:{kind:"value",value:editing.value}}]);
        setEditing(null);
        if(move){grid.current?.moveFocus({row:move==="down"?1:move==="up"?-1:0,col:move==="right"?1:move==="left"?-1:0});grid.current?.focus();}
      }} onOpenCell={cell=>onOpenCell(cell,rows[cell.row][cell.col])} onCopy={({format})=>onCopy("tsv",format==="tsv-headers")}
      onUndo={undo} onRedo={redo} canUndo={!!past.length} canRedo={!!future.length}
      onClear={selection=>{
        setNoticeTone("warning");
        if (selection.mode==="row") {setNotice(t("查询结果仅支持字段修改；删除记录请从表数据页操作"));return;}
        if (selectionStats(selection).cells>MAX_ENUMERATED_CELLS) {setNotice(t("选择范围过大，请缩小范围后再清空"));return;}
        change(Array.from(iterateSelectionCells(selection,MAX_ENUMERATED_CELLS)).map(cell=>({...cell,value:{kind:"null" as const}})));
      }}
      onPaste={(start,text)=>{
        if(!editable || !metadata || !target.value)return;
        const plan=planPaste({start,matrix:parseClipboardMatrix(text),columns:target.value.names.map(n=>{const c=metadata.columns.find(c=>c.name===n)!;return {name:n,dataType:c.data_type,nullable:c.nullable};}),rowCount:rows.length,isRowMutable:()=>true});
        if(plan.skipped.length || plan.clipped || plan.cells.some(c=>!writable(c))){setNoticeTone("warning");setNotice(t("粘贴包含不可写字段、类型不符或超出范围，已阻止修改"));return;}
        setPaste(plan.cells);
      }} onCellContextMenu={(cell,event)=>openMenu(cell,event)} onRowContextMenu={(_,event)=>openMenu(null,event)} onColumnContextMenu={(_,event)=>openMenu(null,event)} /></div>
    <ContextMenu {...menu.props} />
    <Modal open={showChanges} title={t("查看变更")} size="xl" onClose={()=>setShowChanges(false)}>
      <PendingChangeList entries={drafts} disabled={busy} onRemove={id=>{if(!busy){setPast(p=>[...p,drafts]);setFuture([]);setDrafts(d=>d.filter(x=>x.id!==id));}}} />
    </Modal>
    <ConfirmDialog open={paste!==null} title={t("确认粘贴")} description={t("将暂存 {{count}} 个单元格，点击应用后才写入数据库。",{count:paste?.length ?? 0})}
      onCancel={()=>setPaste(null)} onConfirm={()=>{if(paste)change(paste);setPaste(null);}} />
  </div>;
}
