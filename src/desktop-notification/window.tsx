/**
 * 通知槽窗口：**一个窗口只渲染一张卡片**。
 *
 * 窗口由 Rust 的 `desktop-notification` 管理器创建（label
 * `desktop-notification-0..N`），这里只负责：
 * 1. 接收本槽的通知内容（`desktop-notification:show` / `reset`）；
 * 2. 卡片渲染完测量高度并上报（`desktop_notification_present`）——
 *    窗口先定位到最终位置，卡片在首帧之前保持透明；
 * 3. 接收轻量帧事件（`desktop-notification:frame`），按 `lastSeq` 拉最新帧，
 *    写进 canvas 当 GlassSurface 的纹理；
 * 4. 自己那条独立计时，到点调 `desktop_notification_dismiss`。
 *
 * # 三个阶段（解决"先露白底再切玻璃"）
 *
 * ```
 * waiting：整卡透明，窗口已就位，等首帧 + WebGL 实际绘制
 * glass  ：首帧画完 → 整卡一次性淡入（第一次可见就是玻璃）
 * solid  ：采集不支持/超时/WebGL 失败 → 直接淡入实色底，本条不再变脸
 * ```
 *
 * # 帧协议
 *
 * 响应是 `seq(u64 LE) + width(u32 LE) + height(u32 LE) + RGBA`。原生侧保证
 * 帧属于**当前通知与当前几何**；没有新帧时返回 16 字节全 0 的空头，前端
 * 直接跳过。每个槽同一时间最多一个请求在途。
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

import {
  DesktopNotificationCard,
  type DesktopNotificationPhase,
  type DesktopNotificationTone,
} from "@/components/ui/desktop-notification";
import {
  activateDesktopNotification,
  decideDesktopNotification,
  type DesktopNotificationAction,
} from "@/desktop-notification/bridge";

interface NotificationPayload {
  id: string;
  title: string;
  body?: string | null;
  source?: string | null;
  meta?: string | null;
  time?: string | null;
  tone?: DesktopNotificationTone | null;
  /** 停留时长（毫秒）；`0` 表示常驻，`null`/缺省用默认值。 */
  durationMs?: number | null;
  /** 点击卡片要执行的动作。 */
  action?: DesktopNotificationAction | null;
  /** 卡片上的按钮（审批）：`key` 原样转回主窗口。 */
  buttons?: { key: string; label: string }[] | null;
}

/** 默认停留时长：和系统通知同量级，够读完两三行。 */
const DEFAULT_DURATION_MS = 6000;
/** 首帧等待上限：超时直接回退实色，不让通知一直隐形。 */
const FIRST_FRAME_TIMEOUT_MS = 700;
/** 兜底轮询：帧事件丢了也能追上（正常情况下几乎不触发）。 */
const FALLBACK_POLL_MS = 1000;
/** 退场淡出时长；动画走完才让原生释放槽位（补位在这之后开始）。 */
const EXIT_MS = 130;
/** 二进制头：seq(u64) + width(u32) + height(u32)。 */
const FRAME_HEADER_BYTES = 16;

/**
 * 通知窗口的主题。
 *
 * 这个窗口不跑 `initTheme`：那会把**本窗口**的原生主题固定成某个值，而它
 * 是纯透明自绘窗口。这里只按用户存下的主题模式 + 系统深浅落 `data-theme`，
 * 保证底色与玻璃蒙版的亮/暗用对。
 */
function applyWindowTheme(): void {
  let mode: string | null = null;
  try {
    mode = localStorage.getItem("ops.theme");
  } catch {
    // localStorage 不可用：按系统深浅兜底。
  }
  const dark =
    mode === "dark" ||
    (mode !== "light" &&
      Boolean(window.matchMedia?.("(prefers-color-scheme: dark)").matches));
  document.documentElement.dataset.theme = dark ? "dark" : "light";
}

applyWindowTheme();

export function DesktopNotificationWindow() {
  const [notification, setNotification] = useState<NotificationPayload | null>(null);
  const [phase, setPhase] = useState<DesktopNotificationPhase>("waiting");
  /** 是否已经收到过有效帧；false 时不挂 GlassSurface。 */
  const [hasFrame, setHasFrame] = useState(false);
  /** 系统"减少动画"：只保留简短淡入淡出。 */
  const [reducedMotion, setReducedMotion] = useState(false);
  /** 关闭请求去重：手动关闭与自动到期可能同一帧触发。 */
  const dismissingRef = useRef(false);

  const cardRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  /** 已画到 canvas 上的帧序号，作为下一次拉取的 `lastSeq`。 */
  const frameSeqRef = useRef(0);
  /** 同一时间只允许一次拉取在飞。 */
  const pullingRef = useRef(false);
  /** 阶段 / 是否有帧的 ref 版本：回调里判断，避免闭包旧值。 */
  const phaseRef = useRef<DesktopNotificationPhase>("waiting");
  const hasFrameRef = useRef(false);
  /** 通知开始渲染的时间点，用来量首帧与玻璃首帧的耗时。 */
  const shownAtRef = useRef(0);
  const firstFrameLoggedRef = useRef(false);
  /** 最近的帧到达时间，用来算 P95 帧间隔（每 120 帧输出一次）。 */
  const frameTimesRef = useRef<number[]>([]);

  const resetState = useCallback(() => {
    frameSeqRef.current = 0;
    hasFrameRef.current = false;
    phaseRef.current = "waiting";
    shownAtRef.current = performance.now();
    firstFrameLoggedRef.current = false;
    dismissingRef.current = false;
    setHasFrame(false);
    setPhase("waiting");
  }, []);

  const enterPhase = useCallback((next: DesktopNotificationPhase) => {
    if (phaseRef.current === next) return;
    phaseRef.current = next;
    setPhase(next);
  }, []);

  useEffect(() => {
    let alive = true;
    const unlisteners: Array<() => void> = [];

    void (async () => {
      const offShow = await listen<NotificationPayload>(
        "desktop-notification:show",
        (event) => {
          if (!alive) return;
          // 槽被复用：旧通知的帧和首帧回调不能影响新通知。
          resetState();
          setNotification(event.payload);
        },
      );
      const offReset = await listen("desktop-notification:reset", () => {
        if (!alive) return;
        setNotification(null);
        resetState();
      });
      unlisteners.push(offShow, offReset);

      // 事件可能早于页面就绪：主动拉一次本槽当前的通知。
      // 窗口池刚创建时管理器可能还没就绪（返回 null），短暂重试几次；
      // 之后 push 的事件会正常送达，不需要一直轮询。
      for (let attempt = 0; attempt < 5 && alive; attempt += 1) {
        const pending = await invoke<NotificationPayload | null>(
          "desktop_notification_pending",
        ).catch(() => null);
        if (!alive) return;
        if (pending) {
          setNotification((current) => current ?? pending);
          return;
        }
        await new Promise((resolve) => window.setTimeout(resolve, 200));
      }
    })().catch((error) => {
      console.warn("[desktop-notification] init failed", error);
    });

    return () => {
      alive = false;
      for (const off of unlisteners) off();
    };
  }, [resetState]);

  // 内容变化后测高并上报：窗口先定位到最终位置，卡片此时仍然透明。
  useLayoutEffect(() => {
    if (!notification || !cardRef.current) return;
    const height = Math.ceil(cardRef.current.getBoundingClientRect().height);
    if (height <= 0) return;
    void invoke("desktop_notification_present", { height }).catch((error) => {
      console.warn("[desktop-notification] present failed", error);
    });
  }, [notification]);

  // 首帧等待上限：采集不支持 / WebGL 失败时，别让通知一直隐形。
  useEffect(() => {
    if (!notification || phase !== "waiting") return;
    const timer = window.setTimeout(() => {
      if (phaseRef.current !== "waiting") return;
      enterPhase("solid");
      console.debug("[desktop-notification] first frame timeout → solid");
    }, FIRST_FRAME_TIMEOUT_MS);
    return () => window.clearTimeout(timer);
  }, [notification, phase, enterPhase]);

  // 帧拉取：事件驱动 + 低频兜底轮询；单飞，慢帧直接跳过。
  useEffect(() => {
    if (!notification) return;
    let alive = true;

    const pull = async () => {
      if (!alive || pullingRef.current) return;
      // 已经回退实色 / 正在退场：不再拉帧。
      if (phaseRef.current === "solid" || phaseRef.current === "leaving") return;
      // 冷启动（事件早于页面就绪）时没有 `show` 可 reset，这里补一个起点。
      if (shownAtRef.current === 0) shownAtRef.current = performance.now();
      pullingRef.current = true;
      try {
        const buffer = await invoke<ArrayBuffer>("desktop_notification_frame", {
          lastSeq: frameSeqRef.current,
        });
        if (!alive || !(buffer instanceof ArrayBuffer) || buffer.byteLength < FRAME_HEADER_BYTES) {
          return;
        }
        const header = new DataView(buffer);
        const seq = Number(header.getBigUint64(0, true));
        const width = header.getUint32(8, true);
        const height = header.getUint32(12, true);
        // 空头（没有新帧 / 帧不属于当前通知或几何）：什么都不做。
        if (!seq || !width || !height || seq === frameSeqRef.current) return;

        const canvas = canvasRef.current;
        const context = canvas?.getContext("2d");
        if (!canvas || !context) return;

        if (canvas.width !== width) canvas.width = width;
        if (canvas.height !== height) canvas.height = height;
        const pixels = new Uint8ClampedArray(buffer, FRAME_HEADER_BYTES, width * height * 4);
        context.putImageData(new ImageData(pixels, width, height), 0, 0);
        // GlassSurface 用它判断"是否需要重新上传纹理"：同一序号不重复上传。
        canvas.dataset.frameSeq = String(seq);
        frameSeqRef.current = seq;

        if (!firstFrameLoggedRef.current && shownAtRef.current > 0) {
          firstFrameLoggedRef.current = true;
          console.debug(
            `[desktop-notification] frame +${(performance.now() - shownAtRef.current).toFixed(0)}ms ` +
              `(${width}x${height}, seq ${seq})`,
          );
        }

        // 帧间隔 P95：每 120 帧打一次，用来确认 30 FPS 是否真的到手。
        const now = performance.now();
        const times = frameTimesRef.current;
        times.push(now);
        if (times.length >= 121) {
          const gaps = times.slice(1).map((time, index) => time - times[index]);
          gaps.sort((a, b) => a - b);
          const p95 = gaps[Math.min(gaps.length - 1, Math.floor(gaps.length * 0.95))];
          console.debug(
            `[desktop-notification] frame interval p95 ${p95.toFixed(1)}ms ` +
              `(avg ${(gaps.reduce((sum, gap) => sum + gap, 0) / gaps.length).toFixed(1)}ms)`,
          );
          frameTimesRef.current = [];
        }
        if (!hasFrameRef.current) {
          hasFrameRef.current = true;
          setHasFrame(true);
        }
      } catch (error) {
        // 采集没就绪：保持主题底色，下一次继续拉。
        console.debug("[desktop-notification] frame pull skipped", error);
      } finally {
        pullingRef.current = false;
      }
    };

    let offFrame: (() => void) | null = null;
    void listen("desktop-notification:frame", () => {
      if (alive) void pull();
    }).then((off) => {
      offFrame = off;
      if (!alive) off();
    });
    const fallback = window.setInterval(() => {
      void pull();
    }, FALLBACK_POLL_MS);
    void pull();

    return () => {
      alive = false;
      window.clearInterval(fallback);
      offFrame?.();
    };
  }, [notification]);

  /** 关闭：手动点 × 与自动到期走同一条路径（先淡出，再让原生释放槽位）。 */
  const requestDismiss = useCallback(() => {
    if (!notification || dismissingRef.current) return;
    dismissingRef.current = true;
    enterPhase("leaving");
    window.setTimeout(() => {
      void invoke("desktop_notification_dismiss", { id: notification.id }).catch(
        () => undefined,
      );
    }, EXIT_MS);
  }, [notification, enterPhase]);

  /**
   * 审批按钮：点一次就不再受理。
   *
   * 主窗口收到决定后会把**同一条**通知更新成「已允许 / 已拒绝」，所以这里不
   * 自己关窗口 —— 否则用户点完只看到通知消失，不知道生效没有。
   */
  const decidedRef = useRef<string | null>(null);
  useEffect(() => {
    decidedRef.current = null;
  }, [notification?.id, notification?.buttons]);

  /** 点击卡片：把动作转给主窗口（跳转/安装更新），并收起这条通知。 */
  const handleActivate = useCallback(() => {
    if (!notification) return;
    activateDesktopNotification(notification.id);
    requestDismiss();
  }, [notification, requestDismiss]);

  // 倒计时从卡片**实际可见**开始：还在等首帧（waiting）时不计时。
  // 补位只移动原生窗口，不重建 React 树，所以计时不会重置。
  useEffect(() => {
    if (!notification) return;
    if (phase !== "glass" && phase !== "solid") return;
    const ttl = notification.durationMs ?? DEFAULT_DURATION_MS;
    if (ttl <= 0) return;
    const timer = window.setTimeout(() => requestDismiss(), ttl);
    return () => window.clearTimeout(timer);
  }, [notification, phase, requestDismiss]);

  // 系统"减少动画"：位置直接更新（原生侧），前端只保留简短淡入淡出。
  useEffect(() => {
    const query = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    if (!query) return;
    const sync = () => {
      setReducedMotion(query.matches);
      void invoke("desktop_notification_set_motion", {
        reduced: query.matches,
      }).catch(() => undefined);
    };
    sync();
    query.addEventListener("change", sync);
    return () => query.removeEventListener("change", sync);
  }, []);

  /** 玻璃首帧真正画完：整卡一次性淡入（可见的第一帧就是玻璃）。 */
  const handleFirstFrame = useCallback(() => {
    if (phaseRef.current !== "waiting") return;
    if (shownAtRef.current > 0) {
      console.debug(
        `[desktop-notification] glass +${(performance.now() - shownAtRef.current).toFixed(0)}ms`,
      );
    }
    enterPhase("glass");
  }, [enterPhase]);

  if (!notification) return null;

  return (
    <div ref={cardRef}>
      <DesktopNotificationCard
        item={{
          id: notification.id,
          title: notification.title,
          body: notification.body ?? undefined,
          source: notification.source ?? undefined,
          meta: notification.meta ?? undefined,
          time: notification.time ?? undefined,
          tone: notification.tone ?? undefined,
          onDismiss: requestDismiss,
          actions: (notification.buttons ?? []).map((button) => ({
            label: button.label,
            onClick: () => {
              if (decidedRef.current) return;
              decidedRef.current = button.key;
              decideDesktopNotification(notification.id, button.key);
            },
          })),
        }}
        canvasRef={canvasRef}
        phase={phase}
        showGlass={hasFrame}
        reduced={reducedMotion}
        onActivate={notification.action ? handleActivate : undefined}
        onFirstFrame={handleFirstFrame}
      />
    </div>
  );
}
