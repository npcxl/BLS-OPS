import { create } from "zustand";
import { opsApi } from "@/api/ops-api";
import type { LogSource } from "./panel-target";
import { appendChunk, emptyBuffer, type LogBuffer } from "./log-buffer";

/**
 * 实时日志流：**独立于问答任务**的一条长连接。
 *
 * 放在应用级 store，而不是面板组件里：收起右栏不该断流，切到别的对话也应
 * 继续接收（只是不在当前界面显示）。停止监听 / 关闭日志标签时才释放远端命令。
 */

export type LogStatus = "connecting" | "live" | "stopped" | "error";

export interface LogStreamState extends LogBuffer {
  id: string;
  workspaceId: string;
  /** 服务器配置 id：日志**只属于**打开它的那台。 */
  serverId: string | null;
  sessionId: string;
  source: LogSource;
  status: LogStatus;
  error?: string;
  paused: boolean;
  /** 暂停期间新到的行数（回到列表时要提示）。 */
  unseen: number;
}

interface LogStreamStore {
  streams: Record<string, LogStreamState>;
  /** 每条对话当前挂的那条流（同一条对话只保留一条日志面板）。 */
  activeByWorkspace: Record<string, string>;

  start: (input: {
    workspaceId: string;
    serverId: string | null;
    sessionId: string;
    source: LogSource;
    lines?: number;
  }) => string;
  stop: (id: string) => void;
  /** 只停当前对话的那条。 */
  stopWorkspace: (workspaceId: string) => void;
  pause: (id: string) => void;
  resume: (id: string) => void;
  push: (id: string, chunk: string) => void;
  setStatus: (id: string, status: LogStatus, error?: string) => void;
}

let sequence = 0;
/** 待提交的日志分片（按流合并，最多 80ms 提交一次）。 */
const pendingChunks = new Map<string, string[]>();
let flushTimer = 0;

export const useLogStreamStore = create<LogStreamStore>()((set, get) => ({
  streams: {},
  activeByWorkspace: {},

  start: ({ workspaceId, serverId, sessionId, source, lines = 200 }) => {
    // 同一条对话已经有日志：先停掉旧的，避免两条远端 tail 同时跑。
    get().stopWorkspace(workspaceId);
    const id = `log-${(sequence += 1)}-${Date.now()}`;
    const stream: LogStreamState = {
      id,
      workspaceId,
      serverId,
      sessionId,
      source,
      status: "connecting",
      paused: false,
      unseen: 0,
      ...emptyBuffer(),
    };
    set((state) => ({
      streams: { ...state.streams, [id]: stream },
      activeByWorkspace: { ...state.activeByWorkspace, [workspaceId]: id },
    }));

    void opsApi
      .extremeLogStart(
        {
          streamId: id,
          sessionId,
          server: serverId ?? "",
          source,
          lines,
        },
        (event) => {
          if (event.kind === "started") {
            get().setStatus(id, "live");
          } else if (event.kind === "line" && typeof event.text === "string") {
            get().push(id, event.text);
          } else if (event.kind === "error") {
            get().setStatus(id, "error", event.error ?? "");
          } else if (event.kind === "closed") {
            const current = get().streams[id];
            // 远端正常结束（被停止）与异常中断要分开显示。
            if (current && current.status !== "stopped") {
              get().setStatus(id, "stopped");
            }
          }
        },
      )
      .catch((cause: unknown) => {
        get().setStatus(id, "error", cause instanceof Error ? cause.message : String(cause));
      });

    return id;
  },

  stop: (id) => {
    const stream = get().streams[id];
    if (!stream) return;
    // 停止前的积压分片一律作废：它们不代表"现在还在监听"。
    pendingChunks.delete(id);
    // 先把请求发出去，**收到后端确认**（kill + 取消 SSH 执行都完成）再显示已停止，
    // 避免界面先显示"已停止"、远端 tail 还在跑。
    void opsApi
      .extremeLogStop(id)
      .then(() => get().setStatus(id, "stopped"))
      .catch((cause: unknown) =>
        get().setStatus(id, "error", cause instanceof Error ? cause.message : String(cause)),
      );
  },

  stopWorkspace: (workspaceId) => {
    const id = get().activeByWorkspace[workspaceId];
    if (id) get().stop(id);
  },

  pause: (id) =>
    set((state) => {
      const stream = state.streams[id];
      if (!stream) return state;
      return { streams: { ...state.streams, [id]: { ...stream, paused: true } } };
    }),

  resume: (id) =>
    set((state) => {
      const stream = state.streams[id];
      if (!stream) return state;
      return { streams: { ...state.streams, [id]: { ...stream, paused: false, unseen: 0 } } };
    }),

  /**
   * 追加日志。
   *
   * **合并写入**：一条活跃的 nginx 日志每秒可能来几十个分片，逐片 `set` 会让
   * 整个面板每秒重渲染几十次（还要重算过滤），看起来就是"点了没反应"。
   * 这里先攒起来，最多每 80ms 提交一次。
   */
  push: (id, chunk) => {
    const queued = pendingChunks.get(id) ?? [];
    queued.push(chunk);
    pendingChunks.set(id, queued);
    if (flushTimer) return;
    flushTimer = window.setTimeout(() => {
      flushTimer = 0;
      const batch = [...pendingChunks.entries()];
      pendingChunks.clear();
      set((state) => {
        const streams = { ...state.streams };
        for (const [streamId, chunks] of batch) {
          const stream = streams[streamId];
          if (!stream) continue;
          // 已经停止/出错：迟到的批次不能把状态写回 live，也不该再塞进缓冲。
          if (stream.status === "stopped" || stream.status === "error") continue;
          let buffer = stream;
          let added = 0;
          for (const piece of chunks) {
            const next = appendChunk(buffer, piece);
            added += next.lines.length - buffer.lines.length;
            buffer = { ...buffer, ...next };
          }
          streams[streamId] = {
            ...buffer,
            status: "live",
            // 暂停滚动时继续接收，但把"有多少新行"累计起来。
            unseen: stream.paused ? stream.unseen + added : 0,
          };
        }
        return { streams };
      });
    }, 80);
  },

  setStatus: (id, status, error) =>
    set((state) => {
      const stream = state.streams[id];
      if (!stream) return state;
      if (stream.status === "stopped" && status !== "stopped") return state;
      return {
        streams: { ...state.streams, [id]: { ...stream, status, error } },
      };
    }),
}));

/** 当前对话的日志流（没有就是 `undefined`）。 */
export function activeLogFor(state: LogStreamStore, workspaceId: string | null) {
  if (!workspaceId) return undefined;
  const id = state.activeByWorkspace[workspaceId];
  return id ? state.streams[id] : undefined;
}
