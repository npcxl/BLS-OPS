import { useEffect, useMemo, useState, type Dispatch, type SetStateAction } from "react";
import { Check, ChevronDown, ChevronRight, Copy, FileJson, FileText, Search, X } from "lucide-react";
import { cn } from "@/lib/cn";
import {
  COPYABLE,
  CopyNotice,
  clickCopyProps,
  useCopyFeedback,
} from "@/components/ui/copy-feedback";

/**
 * JSON 查看器 —— **只显示 JSON，绝不再把对象数组自动转表格**（用户裁决）。
 *
 * 提供：可折叠 JSON 树（默认展开）、格式化文本模式、搜索、复制节点 /
 * 复制路径 / 复制整段。任何“识别/渲染”失败都不会改动原数据 —— 本组件
 * 只消费一个已解析的 `value`。
 *
 * 点击语义：
 * - **叶子节点** → 复制该节点的实际值（字符串不带引号，与它本来的值一致）；
 * - **对象 / 数组容器** → 仍然展开 / 折叠，绝不触发复制；
 * - **搜索结果行** → 复制**完整值**（不是被截断的展示文本）；
 * - **文本模式** → 点击内容复制完整 JSON。
 * 复制路径 / 复制节点 JSON 两个按钮保持原样。
 */
export function JsonView({ value }: { value: unknown }) {
  const [mode, setMode] = useState<"tree" | "text">("tree");
  const [query, setQuery] = useState("");
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  // 复制提示统一走共用 hook（视图内不再自己起定时器）。
  const { status, copy } = useCopyFeedback();

  // value 变化（如模块链切换结果）时重置折叠状态，避免旧路径残留在新数据上。
  useEffect(() => {
    setCollapsed(new Set());
    setQuery("");
  }, [value]);

  // 提示消失时顺带清掉按钮上的“已复制”勾选（不再另设定时器）。
  useEffect(() => {
    if (status === "idle") setCopiedKey(null);
  }, [status]);

  const pretty = useMemo(() => prettyJson(value), [value]);
  const containerPaths = useMemo(() => {
    const acc: string[] = [];
    collectContainerPaths(value, "$", acc);
    return acc;
  }, [value]);
  const normalizedQuery = query.trim().toLowerCase();
  const matches = useMemo(
    () => (normalizedQuery ? collectMatches(value, normalizedQuery) : null),
    [value, normalizedQuery],
  );

  const flashCopied = async (text: string, key: string) => {
    setCopiedKey(key);
    await copy(text);
  };

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-surface-1">
      {/* 工具条 */}
      <div className="flex shrink-0 items-center gap-2 border-b border-line px-2.5 py-1.5">
        <div className="flex shrink-0 items-center gap-0.5 rounded-[7px] bg-surface-2 p-0.5">
          <button
            type="button"
            onClick={() => setMode("tree")}
            className={cn(
              "flex items-center gap-1 rounded-[5px] px-2 py-0.5 text-10 transition-colors",
              mode === "tree" ? "bg-surface-3 text-fg" : "text-fg-subtle hover:text-fg",
            )}
          >
            <FileJson size={11} />
            树
          </button>
          <button
            type="button"
            onClick={() => setMode("text")}
            className={cn(
              "flex items-center gap-1 rounded-[5px] px-2 py-0.5 text-10 transition-colors",
              mode === "text" ? "bg-surface-3 text-fg" : "text-fg-subtle hover:text-fg",
            )}
          >
            <FileText size={11} />
            文本
          </button>
        </div>

        {mode === "tree" && (
          <div className="relative flex min-w-0 flex-1 items-center">
            <Search size={11} className="pointer-events-none absolute left-2 text-fg-subtle" />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="搜索键 / 值…"
              className="h-6 w-full rounded-[6px] border border-line bg-surface-1 pl-6 pr-6 text-10 text-fg outline-none placeholder:text-fg-subtle focus:border-accent"
            />
            {query !== "" && (
              <button
                type="button"
                onClick={() => setQuery("")}
                className="absolute right-1.5 text-fg-subtle hover:text-fg"
                aria-label="清空搜索"
              >
                <X size={11} />
              </button>
            )}
          </div>
        )}

        {mode === "tree" && (
          <div className="flex shrink-0 items-center gap-0.5">
            <button
              type="button"
              onClick={() => setCollapsed(new Set(containerPaths))}
              className="rounded-[5px] px-1.5 py-0.5 text-10 text-fg-subtle hover:bg-surface-2 hover:text-fg"
            >
              全部折叠
            </button>
            <button
              type="button"
              onClick={() => setCollapsed(new Set())}
              className="rounded-[5px] px-1.5 py-0.5 text-10 text-fg-subtle hover:bg-surface-2 hover:text-fg"
            >
              展开全部
            </button>
          </div>
        )}

        <button
          type="button"
          onClick={() => void flashCopied(pretty, "whole")}
          className="flex shrink-0 items-center gap-1 rounded-[6px] border border-line bg-surface-1 px-1.5 py-0.5 text-10 text-fg-subtle hover:text-fg"
          title="复制整段 JSON"
        >
          {copiedKey === "whole" ? <Check size={11} /> : <Copy size={11} />}
          {copiedKey === "whole" ? "已复制" : "复制"}
        </button>
      </div>

      {/* 内容 */}
      <div className="min-h-0 flex-1 overflow-auto">
        {mode === "text" ? (
          <button
            type="button"
            data-testid="json-text-copy"
            {...clickCopyProps(() => void copy(pretty))}
            className={cn(COPYABLE, "block w-full")}
            title="点击复制完整 JSON"
          >
            <pre
              style={{ fontFamily: "var(--font-command-output)" }}
              className="w-max min-w-full whitespace-pre px-3 py-2.5 text-12 leading-[1.55] text-fg-muted"
            >
              {pretty}
            </pre>
          </button>
        ) : normalizedQuery !== "" ? (
          matches && matches.length > 0 ? (
            <div className="px-1 py-1">
              {matches.map((entry) => (
                <SearchResultRow
                  key={entry.path}
                  entry={entry}
                  copiedKey={copiedKey}
                  onCopy={flashCopied}
                  copyValue={copy}
                />
              ))}
            </div>
          ) : (
            <div className="px-3 py-6 text-center text-10 text-fg-subtle">无匹配结果</div>
          )
        ) : (
          <JsonTree
            value={value}
            collapsed={collapsed}
            setCollapsed={setCollapsed}
            copiedKey={copiedKey}
            onCopy={flashCopied}
            copyValue={copy}
          />
        )}
      </div>
      <CopyNotice status={status} />
    </div>
  );
}

/* ---------------- 折叠树 ---------------- */

interface TreeRow {
  path: string;
  depth: number;
  keyText: string;
  value: unknown;
  isContainer: boolean;
  collapsed: boolean;
}

function JsonTree({
  value,
  collapsed,
  setCollapsed,
  copiedKey,
  onCopy,
  copyValue,
}: {
  value: unknown;
  collapsed: Set<string>;
  setCollapsed: Dispatch<SetStateAction<Set<string>>>;
  copiedKey: string | null;
  onCopy: (text: string, key: string) => Promise<void>;
  /** 点击叶子节点时复制它的**实际值**。 */
  copyValue: (text: string) => Promise<void>;
}) {
  const rows = useMemo<TreeRow[]>(() => {
    const acc: TreeRow[] = [];
    appendRows(value, "$", 0, collapsed, acc);
    return acc;
  }, [value, collapsed]);

  if (rows.length === 0) {
    // 根是原始值 / 空容器 → 按格式化 JSON 字面量显示（字符串保留引号），
    // 点击即复制它本身。
    return (
      <button
        type="button"
        data-testid="json-root-copy"
        {...clickCopyProps(() => void copyValue(copyTextOf(value)))}
        className={cn(COPYABLE, "block w-full px-3 py-2.5 font-mono text-11 leading-[1.55] text-fg-muted")}
        title="点击复制该值"
      >
        {prettyJson(value)}
      </button>
    );
  }

  return (
    <div className="py-1">
      {rows.map((row) => {
        const containerValue = row.value;
        const isEmpty = isContainer(containerValue) && isEmptyContainer(containerValue);
        // 容器（且非空）→ 点击仍然展开/折叠；其余（叶子 / 空容器）→ 点击复制。
        const canToggle = isContainer(containerValue) && !isEmpty;
        const toggle = () => {
          setCollapsed((prev) => {
            const next = new Set(prev);
            if (next.has(row.path)) next.delete(row.path);
            else next.add(row.path);
            return next;
          });
        };
        return (
          <div
            key={row.path}
            className="group flex items-center gap-1 rounded-[5px] px-2 font-mono text-11 leading-[1.55] hover:bg-surface-2"
            style={{ paddingLeft: 10 + row.depth * 16 }}
          >
            <span className="flex w-3.5 shrink-0 items-center justify-center">
              {row.isContainer && !isEmpty ? (
                <button type="button" onClick={toggle} className="text-fg-subtle hover:text-fg" aria-label={row.collapsed ? "展开" : "折叠"}>
                  {row.collapsed ? <ChevronRight size={11} /> : <ChevronDown size={11} />}
                </button>
              ) : null}
            </span>

            <button
              type="button"
              data-testid="json-node"
              // 叶子点击复制值；容器点击展开/折叠（绝不复制）。
              {...(canToggle ? { onClick: toggle } : clickCopyProps(() => void copyValue(copyTextOf(row.value))))}
              className={cn(
                "flex min-w-0 flex-1 items-baseline gap-0 text-left",
                !canToggle && cn(COPYABLE, "items-baseline"),
              )}
              title={canToggle ? undefined : "点击复制该值"}
            >
              <span className="shrink-0 text-fg">{row.keyText}</span>
              <span className="text-fg-subtle">{": "}</span>
              {row.isContainer ? (
                <span className="truncate text-fg-subtle">
                  {containerPreview(row.value as JsonContainer)}
                </span>
              ) : (
                <ValueToken value={row.value} />
              )}
            </button>

            <span className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
              <button
                type="button"
                onClick={() => void onCopy(row.path, `path:${row.path}`)}
                className="rounded p-0.5 text-fg-subtle hover:bg-surface-3 hover:text-fg"
                title="复制路径"
              >
                {copiedKey === `path:${row.path}` ? <Check size={11} /> : <Copy size={11} />}
              </button>
              <button
                type="button"
                onClick={() => void onCopy(jsonOf(row.value), `value:${row.path}`)}
                className="rounded p-0.5 text-fg-subtle hover:bg-surface-3 hover:text-fg"
                title="复制节点 JSON"
              >
                {copiedKey === `value:${row.path}` ? <Check size={11} /> : <Copy size={11} />}
              </button>
            </span>
          </div>
        );
      })}
    </div>
  );
}

/**
 * 点击复制时写入剪贴板的文本 = 节点的**实际值**：
 * 字符串不带引号（要 JSON 字面量用"复制节点 JSON"按钮），null → `null`，
 * 其余按 JSON 序列化（空容器得到 `{}` / `[]`）。
 */
function copyTextOf(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "null";
  if (typeof value === "object") return jsonOf(value);
  return String(value);
}

function ValueToken({ value }: { value: unknown }) {
  if (typeof value === "string") return <span className="truncate text-fg-muted">{JSON.stringify(value)}</span>;
  if (value === null) return <span className="truncate text-fg-subtle">null</span>;
  return <span className="truncate text-fg-subtle">{String(value)}</span>;
}

/** 深度优先产出可见行（已展开的容器递归进入，折叠的停在摘要行）。 */
function appendRows(
  value: unknown,
  path: string,
  depth: number,
  collapsed: Set<string>,
  out: TreeRow[],
): void {
  if (!isContainer(value)) return;
  for (const [key, child] of entriesOf(value)) {
    const childPath = childPathOf(path, key);
    const container = isContainer(child) && !isEmptyContainer(child);
    out.push({
      path: childPath,
      depth,
      keyText: isArrayContainer(value) ? `[${key}]` : JSON.stringify(key),
      value: child,
      isContainer: isContainer(child),
      collapsed: container && collapsed.has(childPath),
    });
    if (container && !collapsed.has(childPath)) {
      appendRows(child, childPath, depth + 1, collapsed, out);
    }
  }
}

/* ---------------- 搜索 ---------------- */

interface MatchEntry {
  path: string;
  /** 展示用（可能截断）。 */
  text: string;
  /** 原始值 —— 点击复制的是它，不是被截断的展示文本。 */
  value: unknown;
}

/** 扁平的“叶子行 + 空容器行”，用于搜索命中（每行带完整 JSONPath）。 */
function collectMatches(value: unknown, query: string, limit = 500): MatchEntry[] {
  const out: MatchEntry[] = [];
  const walk = (v: unknown, path: string): void => {
    if (out.length >= limit) return;
    if (!isContainer(v)) {
      const text = jsonOf(v);
      if (path.toLowerCase().includes(query) || text.toLowerCase().includes(query)) {
        out.push({ path, text: truncate(text, 300), value: v });
      }
      return;
    }
    if (isEmptyContainer(v)) {
      const text = containerPreview(v);
      if (path.toLowerCase().includes(query) || text.toLowerCase().includes(query)) {
        out.push({ path, text, value: v });
      }
      return;
    }
    for (const [key, child] of entriesOf(v)) {
      const childPath = childPathOf(path, key);
      if (!isContainer(child)) {
        const text = jsonOf(child);
        if (childPath.toLowerCase().includes(query) || text.toLowerCase().includes(query)) {
          if (out.length >= limit) return;
          out.push({ path: childPath, text: truncate(text, 300), value: child });
        }
      } else if (isEmptyContainer(child)) {
        const text = containerPreview(child);
        if (childPath.toLowerCase().includes(query) || text.toLowerCase().includes(query)) {
          if (out.length >= limit) return;
          out.push({ path: childPath, text, value: child });
        }
      } else {
        walk(child, childPath);
      }
    }
  };
  walk(value, "$");
  return out;
}

function SearchResultRow({
  entry,
  copiedKey,
  onCopy,
  copyValue,
}: {
  entry: MatchEntry;
  copiedKey: string | null;
  onCopy: (text: string, key: string) => Promise<void>;
  copyValue: (text: string) => Promise<void>;
}) {
  return (
    <div className="group flex items-center gap-2 rounded-[5px] px-3 py-1 font-mono text-11 leading-[1.55] hover:bg-surface-2">
      <button
        type="button"
        data-testid="json-search-row"
        // 复制**完整值**（entry.text 只是被截断的展示文本）。
        {...clickCopyProps(() => void copyValue(copyTextOf(entry.value)))}
        className={cn(COPYABLE, "flex min-w-0 flex-1 items-center gap-2")}
        title="点击复制完整值"
      >
        <span className="min-w-0 flex-1 truncate text-fg">{entry.path}</span>
        <span className="shrink-0 max-w-[45%] truncate text-fg-subtle">{entry.text}</span>
      </button>
      <span className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
        <button
          type="button"
          onClick={() => void onCopy(entry.path, `path:${entry.path}`)}
          className="rounded p-0.5 text-fg-subtle hover:bg-surface-3 hover:text-fg"
          title="复制路径"
        >
          {copiedKey === `path:${entry.path}` ? <Check size={11} /> : <Copy size={11} />}
        </button>
      </span>
    </div>
  );
}

/* ---------------- 工具函数 ---------------- */

type JsonContainer = Record<string, unknown> | unknown[];

function isContainer(v: unknown): v is JsonContainer {
  return typeof v === "object" && v !== null;
}
function isArrayContainer(v: JsonContainer): v is unknown[] {
  return Array.isArray(v);
}
function isEmptyContainer(v: JsonContainer): boolean {
  return isArrayContainer(v) ? v.length === 0 : Object.keys(v).length === 0;
}
function containerPreview(v: JsonContainer): string {
  if (isArrayContainer(v)) return v.length === 0 ? "[]" : `[…] ${v.length} 项`;
  const count = Object.keys(v).length;
  return count === 0 ? "{}" : `{…} ${count} 键`;
}
function entriesOf(v: JsonContainer): [string, unknown][] {
  if (isArrayContainer(v)) return v.map((item, index) => [String(index), item]);
  return Object.entries(v);
}
/** 追加路径段：标识符用 `.key`，数组/数字键用 `[i]`，其余用 `["…"]`。 */
function childPathOf(parent: string, key: string): string {
  if (/^\d+$/.test(key)) return `${parent}[${key}]`;
  if (/^[A-Za-z_$][A-Za-z0-9_$-]*$/.test(key)) return `${parent}.${key}`;
  return `${parent}[${JSON.stringify(key)}]`;
}
/** 收集所有“非空容器”的路径，供“全部折叠”使用。 */
function collectContainerPaths(value: unknown, path: string, out: string[]): void {
  if (!isContainer(value)) return;
  for (const [key, child] of entriesOf(value)) {
    if (!isContainer(child) || isEmptyContainer(child)) continue;
    const childPath = childPathOf(path, key);
    out.push(childPath);
    collectContainerPaths(child, childPath, out);
  }
}
function prettyJson(value: unknown): string {
  if (value === undefined) return "null";
  return JSON.stringify(value, null, 2);
}
function jsonOf(value: unknown): string {
  if (value === undefined) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  return JSON.stringify(value) ?? String(value);
}
function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}
