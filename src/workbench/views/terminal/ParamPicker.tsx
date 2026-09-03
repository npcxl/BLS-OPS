import { useEffect, useMemo, useState } from "react";
import { Loader2 } from "lucide-react";
import { opsApi, toErrorMessage } from "@/api/ops-api";
import { cn } from "@/lib/cn";
import { placeholdersIn, type ParamKind } from "@/workbench/views/command-center/complete";
import type { SuggestAnchor } from "./terminal-suggest";

const PARAM_TITLES: Record<ParamKind, string> = {
  unit: "选择服务单元",
  container: "选择容器",
  path: "选择目录",
};

/**
 * 二级参数选择器：候选语法含 `<unit>` / `<容器>` / `<路径>` 时打开，
 * 从**服务器实时**拉真实取值（`systemctl list-units` / `docker ps` / 远程目录），
 * 用户选中后替换该占位符再写入终端 —— 占位符本身绝不会进 shell。
 *
 * 交互与一级提示面板一致：↑↓ 选择、Enter/→ 确认、←/Esc 取消、IME 不拦截。
 */
export function ParamPicker({
  sessionId,
  syntax,
  onPick,
  onCancel,
  anchor,
}: {
  sessionId: string;
  /** 当前（已部分替换的）命令语法。取第一个占位符的种类决定拉什么数据。 */
  syntax: string;
  onPick: (value: string) => void;
  onCancel: () => void;
  anchor: SuggestAnchor | null;
}) {
  const next = placeholdersIn(syntax)[0];
  const kind = next?.kind ?? null;
  const [values, setValues] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);

  // 占位符种类变化（多选时进入下一个参数）→ 重新拉数据。
  useEffect(() => {
    if (!kind) return;
    let alive = true;
    setLoading(true);
    setError(null);
    setValues([]);
    setActiveIndex(0);
    setFilter("");
    opsApi
      .commandParamValues(sessionId, kind)
      .then((list) => {
        if (!alive) return;
        setValues(list);
      })
      .catch((cause) => {
        if (alive) setError(toErrorMessage(cause));
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [sessionId, kind]);

  const visible = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    if (!needle) return values;
    return values.filter((value) => value.toLowerCase().includes(needle));
  }, [values, filter]);

  // ↑↓/Enter/←/Esc 与一级面板一致（Esc 与 ← 都取消）。
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.isComposing || event.keyCode === 229) return;
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setActiveIndex((i) => Math.min(i + 1, Math.max(visible.length - 1, 0)));
      } else if (event.key === "ArrowUp") {
        event.preventDefault();
        setActiveIndex((i) => Math.max(i - 1, 0));
      } else if (event.key === "Enter" || event.key === "ArrowRight") {
        event.preventDefault();
        const value = visible[activeIndex];
        if (value) onPick(value);
      } else if (event.key === "Escape" || event.key === "ArrowLeft") {
        event.preventDefault();
        onCancel();
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [visible, activeIndex, onPick, onCancel]);

  if (!kind || !anchor) return null;

  return (
    <div
      className="absolute z-30 w-[320px] overflow-hidden rounded-[8px] border border-line bg-surface-1 shadow-[0_6px_20px_rgb(15_23_42/0.2)]"
      style={{ left: anchor.x, top: anchor.y }}
    >
      <div className="flex items-center justify-between gap-2 border-b border-line px-2.5 py-1">
        <span className="text-10 font-semibold text-fg-muted">{PARAM_TITLES[kind]}</span>
        <code className="min-w-0 truncate font-mono text-9 text-fg-subtle" title={syntax}>
          {syntax}
        </code>
      </div>
      <div className="border-b border-line px-2 py-1">
        <input
          autoFocus
          value={filter}
          onChange={(event) => {
            setFilter(event.target.value);
            setActiveIndex(0);
          }}
          placeholder="筛选…"
          spellCheck={false}
          className="h-[22px] w-full rounded-[5px] border border-line bg-surface-2 px-1.5 text-11 text-fg outline-none focus:border-accent"
        />
      </div>
      {loading && (
        <div className="flex items-center gap-1.5 px-2.5 py-2 text-11 text-fg-subtle">
          <Loader2 size={11} className="animate-spin" />
          正在读取服务器上的{kind === "unit" ? "服务" : kind === "container" ? "容器" : "目录"}…
        </div>
      )}
      {error && <div className="px-2.5 py-2 text-11 text-danger">{error}</div>}
      {!loading && !error && visible.length === 0 && (
        <div className="px-2.5 py-2 text-11 text-fg-subtle">没有可用的取值</div>
      )}
      {!loading && !error && visible.length > 0 && (
        <div className="max-h-[180px] overflow-y-auto py-0.5">
          {visible.map((value, index) => (
            <button
              key={value}
              type="button"
              // mousedown 而非 click：抢在终端失焦之前完成选择。
              onMouseDown={(event) => {
                event.preventDefault();
                onPick(value);
              }}
              onMouseEnter={() => setActiveIndex(index)}
              className={cn(
                "block w-full truncate px-2.5 py-1 text-left font-mono text-11 transition-colors",
                index === activeIndex ? "bg-accent/12 text-fg" : "text-fg-muted hover:bg-surface-hover",
              )}
            >
              {value}
            </button>
          ))}
        </div>
      )}
      <div className="border-t border-line bg-surface-2/60 px-2.5 py-0.5 text-9 text-fg-subtle">
        ↑↓ 选择 · Enter 填入 · Esc 取消
      </div>
    </div>
  );
}
