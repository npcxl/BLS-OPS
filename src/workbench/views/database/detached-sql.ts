/**
 * 独立 SQL 窗口的启动与跨窗口通讯。
 *
 * 通讯分三层：
 * 1. **参数**：SQL/连接信息通过 localStorage 的一次性 key 传递，避免把整段
 *    SQL 塞进 URL（大脚本会超长，也会泄漏在窗口标题/历史里）。
 * 2. **会话**：两个窗口都调用同一个后端 `ensureSession(profileId)`，实际共用
 *    同一 MySQL 会话；后端仍负责“同一会话不能并发跑两条查询”的保护。
 * 3. **事件**：执行完成/关闭通过 Tauri event 广播；浏览器预览用
 *    BroadcastChannel 走同一套 payload，主窗口不需要区分运行环境。
 */
import { isTauri } from "@tauri-apps/api/core";

export interface DetachedSqlPayload {
  profileId: string;
  connectionName: string;
  database: string | null;
  sql: string;
  title: string;
}

export type DetachedSqlEvent =
  | { action: "opened"; id: string; title: string }
  | {
      action: "finished";
      id: string;
      title: string;
      state: string;
      rows: number;
      elapsedMs: number;
    }
  | { action: "closed"; id: string; title: string };

const STORAGE_PREFIX = "bls:detached-sql:";
const EVENT_NAME = "database-detached-sql";

export function detachedSqlStorageKey(id: string) {
  return `${STORAGE_PREFIX}${id}`;
}

export function readDetachedSqlPayload(
  id: string,
): DetachedSqlPayload | null {
  try {
    const raw = localStorage.getItem(detachedSqlStorageKey(id));
    if (!raw) return null;
    return JSON.parse(raw) as DetachedSqlPayload;
  } catch {
    return null;
  }
}

export function consumeDetachedSqlPayload(
  id: string,
): DetachedSqlPayload | null {
  const payload = readDetachedSqlPayload(id);
  try {
    localStorage.removeItem(detachedSqlStorageKey(id));
  } catch {
    // 忽略配额/隐私模式错误；payload 已经读到。
  }
  return payload;
}

export function isDetachedSqlWindow(): boolean {
  if (typeof window === "undefined") return false;
  return new URLSearchParams(window.location.search).get("detached") === "sql";
}

export function detachedSqlId(): string | null {
  if (typeof window === "undefined") return null;
  return new URLSearchParams(window.location.search).get("id");
}

async function tauriRuntime(): Promise<boolean> {
  try {
    return isTauri();
  } catch {
    return false;
  }
}

export async function openDetachedSqlWindow(
  payload: DetachedSqlPayload,
): Promise<void> {
  const id = crypto.randomUUID();
  const key = detachedSqlStorageKey(id);
  try {
    localStorage.setItem(key, JSON.stringify(payload));
  } catch (error) {
    throw new Error(`无法暂存 SQL：${String(error)}`);
  }

  // 用相对 app URL，Tauri 会把它当作应用内页面而不是外部网页；
  // 浏览器预览再用当前 origin 拼成绝对地址。
  const query = new URLSearchParams({ detached: "sql", id }).toString();
  const appUrl = `index.html?${query}`;

  // `isTauri()` 是同步的；必须在第一个 await 之前调 window.open，
  // 否则浏览器会把弹窗当成非用户手势而拦截。
  let inTauri = false;
  try {
    inTauri = isTauri();
  } catch {
    inTauri = false;
  }
  if (!inTauri) {
    const opened = window.open(
      new URL(appUrl, window.location.href).toString(),
      "_blank",
      "popup=yes,width=1100,height=760",
    );
    if (!opened) {
      localStorage.removeItem(key);
      throw new Error("浏览器阻止了新窗口，请允许弹窗后重试");
    }
    try {
      opened.resizeTo(window.screen.availWidth, window.screen.availHeight);
      opened.moveTo(0, 0);
    } catch {
      // 浏览器可能不允许脚本移动窗口；保留普通弹窗即可。
    }
    return;
  }

  try {
    const { WebviewWindow } = await import("@tauri-apps/api/webviewWindow");
    const label = `sql-detached-${id.replace(/-/g, "")}`;
    const window_ = new WebviewWindow(label, {
      url: appUrl,
      title: payload.title,
      width: 1100,
      height: 760,
      minWidth: 720,
      minHeight: 480,
      maximized: true,
      resizable: true,
      decorations: true,
      center: true,
      focus: true,
    });
    await new Promise<void>((resolve, reject) => {
      void window_.once("tauri://created", () => resolve());
      void window_.once("tauri://error", (event) =>
        reject(new Error(String(event.payload))),
      );
    });
  } catch (error) {
    localStorage.removeItem(key);
    throw error;
  }
}

/** 广播独立窗口生命周期；环境不支持时静默失败，绝不能影响查询本身。 */
export async function emitDetachedSqlEvent(
  payload: DetachedSqlEvent,
): Promise<void> {
  try {
    if (await tauriRuntime()) {
      const { emit } = await import("@tauri-apps/api/event");
      await emit(EVENT_NAME, payload);
      return;
    }
    const channel = new BroadcastChannel(EVENT_NAME);
    channel.postMessage(payload);
    channel.close();
  } catch {
    // 事件只是通知，不能阻断查询。
  }
}

export async function listenDetachedSqlEvents(
  handler: (payload: DetachedSqlEvent) => void,
): Promise<() => void> {
  try {
    if (await tauriRuntime()) {
      const { listen } = await import("@tauri-apps/api/event");
      return await listen<DetachedSqlEvent>(EVENT_NAME, (event) =>
        handler(event.payload),
      );
    }
    const channel = new BroadcastChannel(EVENT_NAME);
    channel.onmessage = (event: MessageEvent<DetachedSqlEvent>) =>
      handler(event.data);
    return () => channel.close();
  } catch {
    return () => undefined;
  }
}
