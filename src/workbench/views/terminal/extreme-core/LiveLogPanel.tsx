import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Pause, Play, Search, Square } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { ExtremeIconButton } from "./ExtremeIconButton";
import type { LogSource } from "@/api/types/panel";
import { filterLines, visibleLines } from "./log-buffer";
import { activeLogFor, useLogStreamStore } from "./log-stream-store";

/**
 * 实时日志面板。
 *
 * 数据来自 `log-stream-store`（应用级）：收起右栏也不会断，切走再回来还在。
 * 这里只负责展示与"暂停 / 跟随 / 过滤 / 停止"。
 */
export function LiveLogPanel({
  workspaceId,
  sessionId,
  serverId,
  source,
  onChangeSource,
}: {
  workspaceId: string;
  sessionId: string;
  serverId: string | null;
  source: LogSource;
  onChangeSource?: () => void;
}) {
  const { t } = useTranslation();
  const stream = useLogStreamStore((state) => activeLogFor(state, workspaceId));
  const start = useLogStreamStore((state) => state.start);
  const stop = useLogStreamStore((state) => state.stop);
  const pause = useLogStreamStore((state) => state.pause);
  const resume = useLogStreamStore((state) => state.resume);
  const [query, setQuery] = useState("");
  const listRef = useRef<HTMLDivElement>(null);
  /** 用户手动往上翻就暂停跟随；拉回底部自动恢复。 */
  const [follow, setFollow] = useState(true);

  // 这条对话还没有流 / 来源换了：开一条新的（独立于问答任务）。
  useEffect(() => {
    if (!stream || stream.sessionId !== sessionId || stream.source.kind !== source.kind ||
      JSON.stringify(stream.source) !== JSON.stringify(source)) {
      start({ workspaceId, serverId, sessionId, source });
    }
  }, [workspaceId, serverId, sessionId, source, stream, start]);

  const lines = useMemo(
    () => filterLines(visibleLines(stream?.lines ?? []), query),
    [stream?.lines, query],
  );

  // 跟随：新行到达后滚到底。
  useEffect(() => {
    if (!follow) return;
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lines, follow]);

  const paused = stream?.paused ?? false;
  const status = stream?.status ?? "connecting";

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-1 border-b border-line/70 px-2 py-1.5">
        <span className="min-w-0 flex-1 truncate text-11 text-fg-muted" title={source.label}>
          {source.label}
        </span>
        {onChangeSource && (
          <Button variant="ghost" size="xs" onClick={onChangeSource}>
            {t("切换日志来源")}
          </Button>
        )}
        <ExtremeIconButton
          label={paused ? t("继续跟随") : t("暂停滚动")}
          icon={paused ? Play : Pause}
          iconSize={12}
          onClick={() => {
            if (paused) {
              resume(stream!.id);
              setFollow(true);
            } else if (stream) {
              pause(stream.id);
              setFollow(false);
            }
          }}
        />
        <ExtremeIconButton
          label={t("停止监听")}
          icon={Square}
          iconSize={12}
          disabled={status === "stopped"}
          onClick={() => stream && stop(stream.id)}
        />
      </div>

      <div className="flex items-center gap-1 border-b border-line/70 px-2 py-1">
        <Search size={12} className="shrink-0 text-fg-subtle" />
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={t("过滤日志…")}
          aria-label={t("过滤日志")}
          className="min-w-0 flex-1 bg-transparent text-11 text-fg outline-none placeholder:text-fg-subtle"
        />
        {paused && (stream?.unseen ?? 0) > 0 && (
          <span className="shrink-0 text-10 text-warning">
            {t("已暂停，新增 {{n}} 行", { n: stream!.unseen })}
          </span>
        )}
      </div>

      {status === "error" && (
        <div role="status" className="border-b border-danger/40 bg-danger/10 px-2 py-1 text-10 text-danger">
          {stream?.error || t("日志连接已中断")}
          <button
            type="button"
            className="ml-2 underline"
            onClick={() => stream && stop(stream.id)}
          >
            {t("关闭这条日志")}
          </button>
        </div>
      )}

      <div
        ref={listRef}
        role="log"
        aria-live={paused ? "off" : "polite"}
        onScroll={(event) => {
          const el = event.currentTarget;
          const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
          setFollow(atBottom);
          if (atBottom && paused && stream) resume(stream.id);
        }}
        className="min-h-0 flex-1 overflow-auto px-2 py-1 font-mono text-10 leading-relaxed text-fg-muted"
      >
        {lines.length === 0 ? (
          <p className="text-fg-subtle">
            {status === "connecting" ? t("正在连接日志…") : t("还没有日志")}
          </p>
        ) : (
          lines.map((line, index) => (
            // 日志行可以重复，index 是唯一稳定的键（行会被上限裁掉）。
            <div key={`${index}-${line.slice(0, 12)}`} className="whitespace-pre-wrap break-all">
              {line}
            </div>
          ))
        )}
      </div>

      {status === "stopped" && (
        <div className="flex items-center gap-1 border-t border-line/70 px-2 py-1 text-10 text-fg-subtle">
          <span className="min-w-0 flex-1 truncate">
            {t("已停止监听（服务器上的进程已释放）")}
          </span>
          <Button
            variant="ghost"
            size="xs"
            onClick={() => start({ workspaceId, serverId, sessionId, source })}
          >
            {t("重新开始监听")}
          </Button>
        </div>
      )}
    </div>
  );
}
