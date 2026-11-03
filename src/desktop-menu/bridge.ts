/**
 * 主窗口 ↔ 菜单窗口的桥。
 *
 * # 为什么不能直接传 `onSelect`
 *
 * 菜单内容在另一个 WebView 里渲染，函数没法序列化。所以每次打开菜单时：
 * 1. 主窗口给每个可执行项编一个 `actionId`，把回调留在本窗口的 Map 里；
 * 2. 菜单窗口只回传 `{ requestId, actionId }`；
 * 3. Rust 校验 `actionId` 属于当前菜单后转发给来源窗口；
 * 4. 主窗口比对 `requestId` —— 旧菜单的迟到事件直接丢弃，执行一次后清空映射。
 *
 * # 一条动作最多执行一次
 *
 * 选择在**转发前**就把 pending 摘掉（`executed` 同时兜住同一帧的重复点击），
 * 所以双击/连点不会跑两次业务动作；旧 requestId 的 `select` 也不会误伤新菜单。
 *
 * # 失败必须看得见
 *
 * 菜单回调是同步/异步混用的（有的直接 `void promise`）。这里统一包一层：
 * 同步抛错与 Promise 拒绝都变成来源窗口的一条错误提示，绝不静默失败。
 *
 * # 浮层身份
 *
 * 菜单打开期间在**来源窗口**登记一个最上层浮层，Esc/方向键的归属、以及
 * 其它全局快捷键"有浮层就让路"的判断都靠它。
 *
 * # 浏览器预览
 *
 * 没有 Tauri 时 `openDesktopMenu` 直接返回 false，调用方回退到 DOM 菜单。
 */
import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

import type { ContextMenuItem } from "@/components/ui/context-menu";
import { popOverlayLayer, pushOverlayLayer } from "@/components/ui/overlay";
import { pushToast } from "@/components/ui/toast";
import { i18n } from "@/i18n";
import { iconNameOf } from "./icon-registry";

/** 主面板宽度（CSS 像素）。菜单窗口按这个宽度测量，定位逻辑也用它。 */
export const MENU_WIDTH = 220;

/** 来源窗口里的浮层 id：菜单打开期间它是最上层。 */
const OVERLAY_ID = "context-menu";
/** 浮层深度：压过所有弹窗（弹窗按嵌套算，个位数）。 */
const OVERLAY_DEPTH = 1000;
/**
 * 显示确认的超时。
 *
 * 正常路径上 Rust 在 `present` 之后立刻发 `desktop-menu:shown`（几十毫秒）。
 * 超过这个时间还没确认，就**回退到页面内菜单**：桌面窗口这条路一旦在某台
 * 机器上走不通（WebView 白屏、事件没到、布局报错），右键会变成"点了没反应"，
 * 而用户根本无从判断。宁可退化成老菜单，也不能什么都不给。
 *
 * 这个计时器现在只兜"页面活着但 present 卡住"：`desktop_menu_show` 返回时
 * 页面已经量完尺寸，present 只是紧随其后的一次 IPC，正常在几十毫秒内完成。
 * 给它 1.5s 是为了**绝不误收正常菜单** —— 之前 350ms 的短计时器只要丢一次
 * `shown` 事件就会把刚显示的菜单收掉，用户看到的就是"闪一下、点了没反应"。
 */
const PRESENT_TIMEOUT_MS = 1500;

/** 回退只提示一次：每次右键都弹会变成噪音。 */
let fallbackAnnounced = false;

/**
 * 收起原因。
 *
 * `blur` 走独立的 `desktop_menu_blur`：原生侧要复核前台窗口才收，避免
 * WebView 子窗口之间的焦点交接把菜单误关。其余原因都是"来源窗口明确要求
 * 收起"，直接关。
 */
export type MenuCloseReason = "outside" | "blur" | "scroll" | "tab" | "timeout";

/** 走过 IPC 的菜单项：只有数据，没有函数。 */
export interface WireMenuItem {
  id?: string;
  label?: string;
  iconName?: string;
  danger?: boolean;
  disabled?: boolean;
  separator?: boolean;
  hint?: string;
  /** 禁用原因：与主窗口按钮读同一句能力声明。 */
  reason?: string;
  /** 叶子项的动作 id；有 `children` 的父项没有。 */
  actionId?: string;
  children?: WireMenuItem[];
}

export interface MenuShowPayload {
  requestId: string;
  theme: "light" | "dark";
  anchor: { x: number; y: number };
  width: number;
  items: WireMenuItem[];
}

interface PendingMenu {
  requestId: string;
  handlers: Map<string, () => void>;
  /** 已经派发过一次选择：重复/迟到的事件一律丢弃。 */
  executed: boolean;
  /** `desktop-menu:shown` 是否已经到过（决定要不要装最后兜底计时器）。 */
  shown: boolean;
  /** `desktop-menu:shown` 到达时调用（撤掉兜底计时器）。 */
  settleShown: (() => void) | null;
  /** 原生侧主动报告"显示失败"时调到：调用方据此渲染页面内菜单。 */
  onUnavailable?: () => void;
}

let pending: PendingMenu | null = null;
let bridgeReady: Promise<UnlistenFn[]> | null = null;
let openGeneration = 0;

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

/** 动作失败统一回到来源窗口：控制台留证据，界面上给一条错误提示。 */
function reportActionFailure(error: unknown): void {
  console.error("[context-menu] action failed", error);
  pushToast(`${i18n.t("菜单动作执行失败")}：${messageOf(error)}`, "error");
}

/**
 * 桌面窗口没能显示时的提示。
 *
 * 这里**不能静默**：用户右键后什么都没看到时，唯一能解释原因的线索就在这。
 * 只有第一次提示（之后靠 console 记录），避免每次右键都弹一条。
 */
function announceFallback(reason: string): void {
  const message = `${i18n.t("桌面菜单未能显示，已回退到页面内菜单")}（${reason}）`;
  console.warn("[context-menu] desktop menu fallback:", reason);
  if (fallbackAnnounced) return;
  fallbackAnnounced = true;
  pushToast(message, "warning", { detail: i18n.t("右键仍然可用；这条提示每次运行只出现一次") });
}

/** 摘掉 pending 并释放浮层身份。调用方负责把 Rust 侧的菜单收起来。 */
function detachPending(): PendingMenu | null {
  const current = pending;
  current?.settleShown?.();
  pending = null;
  popOverlayLayer(OVERLAY_ID);
  stopSelectionPolling();
  return current;
}

/**
 * 收起菜单（来源窗口主动发起，或来源页面失焦）。
 *
 * DOM blur 不能证明离开应用；原生侧核对前台窗口后才允许清理 pending。
 */
export function cancelDesktopMenu(reason: MenuCloseReason = "outside"): void {
  if (reason === "blur") {
    const current = pending;
    if (!current) return;
    // WebView2 child-focus transitions also emit DOM blur. Keep the callbacks,
    // keyboard routing and overlay alive until Windows confirms an app switch.
    void invoke<boolean>("desktop_menu_blur", { requestId: current.requestId })
      .then(closed => {
        if (closed && pending === current) {
          openGeneration++;
          detachPending();
        }
      }).catch(error => console.warn("[context-menu] foreground check failed", error));
    return;
  }
  openGeneration++;
  const current = detachPending();
  if (!current) return;
  void invoke("desktop_menu_cancel", { requestId: current.requestId, reason }).catch(() => undefined);
}

function currentTheme(): "light" | "dark" {
  return document.documentElement.dataset.theme === "dark" ? "dark" : "light";
}

/**
 * 把菜单树转成可传输结构，并把每个 `onSelect` 登记到 `handlers`。
 *
 * `actionId` 每次打开重新编号（a0、a1…）：它只在本次会话内有效，不需要和
 * 业务 id 对齐，也不怕业务 id 重复。
 */
export function toWireMenu(
  items: ContextMenuItem[],
  handlers: Map<string, () => void>,
): WireMenuItem[] {
  let next = 0;
  const walk = (list: ContextMenuItem[]): WireMenuItem[] =>
    list.map((item) => {
      if (item.separator) return { separator: true };
      const actionId = item.onSelect ? `a${next++}` : undefined;
      if (actionId && item.onSelect) handlers.set(actionId, item.onSelect);
      return {
        id: item.id,
        label: item.label,
        iconName: iconNameOf(item.icon),
        danger: item.danger,
        disabled: item.disabled,
        hint: item.hint,
        reason: item.reason,
        actionId,
        children: item.children?.length ? walk(item.children) : undefined,
      };
    });
  return walk(items);
}

/**
 * 最近打开过的菜单的动作表。
 *
 * 为什么不只用 `pending`：菜单打开后可能因为一次来源窗口的 `blur`、兜底超时
 * 或新菜单替换而把 `pending` 摘掉，但原生窗口**可能还在屏幕上**（取消请求
 * 与它打了个时间差）。此时用户点菜单项，`desktop_menu_select` 仍会发回来 ——
 * 如果这时只认 `pending`，动作就会被静默丢弃：菜单点了没反应。
 *
 * 所以按 requestId 留一份短期动作表，`executed` 保证**仍然只执行一次**。
 */
const RECENT_LIMIT = 8;
const recentActions = new Map<string, { handlers: Map<string, () => void>; executed: boolean }>();
/** 最近一次打开过的菜单。比它旧的 requestId 一律视为"已被替换"。 */
let latestRequestId: string | null = null;

function rememberActions(requestId: string, handlers: Map<string, () => void>): void {
  recentActions.set(requestId, { handlers, executed: false });
  while (recentActions.size > RECENT_LIMIT) {
    const oldest = recentActions.keys().next().value;
    if (oldest === undefined) break;
    recentActions.delete(oldest);
  }
}

/**
 * 派发一次选择。事件与轮询两条路都会走到这里，**重复调用只执行一次**。
 */
function dispatchSelection(actionId: string, requestId: string): void {
  const current = pending;
  if (current?.requestId === requestId) {
    // 正常路径：先摘 pending 再执行，双击/重复事件都跑不到第二次。
    if (current.executed) return;
    current.executed = true;
    recentActions.delete(requestId);
    detachPending();
    runAction(current.handlers, actionId);
    return;
  }
  // pending 已被摘掉（blur/超时），但**没有更新的一版菜单**：原生窗口还是
  // 这一版，动作照常执行一次 —— 不能因为本地状态先走一步就吞掉点击。
  // 反过来，若期间已打开过新菜单（latestRequestId 变了），旧请求的迟到
  // 事件必须丢弃，否则会在新菜单上误执行旧动作。
  if (latestRequestId !== requestId) return;
  const recent = recentActions.get(requestId);
  if (!recent || recent.executed) return;
  recent.executed = true;
  recentActions.delete(requestId);
  runAction(recent.handlers, actionId);
}

/**
 * 菜单打开期间轮询"用户点了哪一项"。
 *
 * 事件是快路径（几十毫秒），但**不能只有它**：事件丢一次，菜单就会"点了
 * 没反应"。原生侧把选择放进信箱，这里取走，两条路有 `dispatchSelection`
 * 的一次性保护，不会重复执行。
 */
let selectionPoll: number | null = null;

function stopSelectionPolling(): void {
  if (selectionPoll === null) return;
  window.clearInterval(selectionPoll);
  selectionPoll = null;
}

function startSelectionPolling(): void {
  if (selectionPoll !== null) return;
  selectionPoll = window.setInterval(() => {
    const current = pending;
    if (!current) {
      stopSelectionPolling();
      return;
    }
    void invoke<string | null>("desktop_menu_take_selection", {
      requestId: current.requestId,
    })
      .then(actionId => {
        if (actionId) dispatchSelection(actionId, current.requestId);
      })
      .catch(() => undefined);
  }, 90);
}

/**
 * 执行一次菜单动作。**只执行一次**：先置 executed 再调用回调，回调里再触发
 * 的任何菜单事件都不会重复进来。
 */
function runAction(handlers: Map<string, () => void>, actionId: string): void {
  const handler = handlers.get(actionId);
  if (!handler) {
    console.warn("[context-menu] unknown action id", actionId);
    return;
  }
  try {
    const result: unknown = handler();
    if (result instanceof Promise) {
      result.catch(reportActionFailure);
    }
  } catch (error) {
    reportActionFailure(error);
  }
}

function ensureBridge(): Promise<UnlistenFn[]> {
  if (bridgeReady) return bridgeReady;
  document.addEventListener(
    "pointerdown",
    event => {
      if (event.button !== 2) cancelDesktopMenu("outside");
    },
    true,
  );
  document.addEventListener("scroll", () => cancelDesktopMenu("scroll"), true);
  window.addEventListener("beforeunload", () => cancelDesktopMenu("outside"));
  // 菜单窗口不激活：键盘仍留在来源 WebView，菜单打开期间阻止穿透到编辑器。
  window.addEventListener(
    "keydown",
    event => {
      const current = pending;
      if (!current) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (
        ["ArrowDown", "ArrowUp", "ArrowLeft", "ArrowRight", "Home", "End", "Enter", "Escape"].includes(
          event.key,
        )
      ) {
        void invoke("desktop_menu_key", {
          requestId: current.requestId,
          key: event.key,
        }).catch(() => undefined);
      } else if (event.key === "Tab") {
        cancelDesktopMenu("tab");
      }
    },
    true,
  );
  // 真正离开来源页面（点击桌面/其他应用、Alt+Tab）时收起。
  // WebView 内部焦点交接也会触发 blur，所以原生侧会用前台窗口复核一次。
  window.addEventListener("blur", () => cancelDesktopMenu("blur"));
  bridgeReady = Promise.all([
    listen<{ requestId: string; actionId: string }>("desktop-menu:select", event => {
      dispatchSelection(event.payload.actionId, event.payload.requestId);
    }),
    listen<{ requestId: string }>("desktop-menu:shown", event => {
      // 菜单真的出现了：标记 + 撤掉最后兜底计时器（即使它还没装，标记也能
      // 让 openDesktopMenu 之后跳过安装）。
      if (pending?.requestId !== event.payload.requestId) return;
      pending.shown = true;
      pending.settleShown?.();
    }),
    // 菜单窗口页面自己报错（模块加载失败、渲染崩溃）：这里的 message 就是
    // 真正的根因，直接带给用户，并回退到页面内菜单。
    listen<{ message: string }>("desktop-menu:failed", event => {
      const unavailable = pending?.onUnavailable;
      announceFallback(event.payload.message);
      if (!pending) return;
      detachPending();
      unavailable?.();
    }),
    listen<{ requestId: string; reason: string }>("desktop-menu:closed", event => {
      if (pending?.requestId !== event.payload.requestId) return;
      // 这两类都是"原生窗口没能给出画面"：回退到页面内菜单，别让右键哑掉。
      const failed =
        event.payload.reason === "layout-error" || event.payload.reason === "menu-dead";
      const unavailable = pending.onUnavailable;
      detachPending();
      // 布局/显示失败不能静默：先记录，再让调用方回退到页面内菜单。
      if (failed) {
        announceFallback(event.payload.reason);
        unavailable?.();
      }
    }),
  ]);
  return bridgeReady;
}

/** 应用启动后调一次：预创建隐藏的菜单窗口，第一次右键不用等 WebView 启动。 */
export function prepareDesktopMenu(): void {
  if (!isTauri()) return;
  void invoke("desktop_menu_prepare", { theme: currentTheme() }).catch(() => {
    // 预创建失败不影响右键：真正打开时会再试一次。
  });
}

/**
 * 在桌面菜单窗口里打开菜单。
 *
 * `anchor` 是来源窗口客户区坐标（CSS 像素，通常是 `event.clientX/clientY`）；
 * 换算成屏幕物理坐标、显示器工作区与翻转全部在 Rust 侧做 —— 主窗口的分辨率
 * 不是屏幕边界，这里不能自己 clamp。
 *
 * 连续右键走**替换**：新请求直接覆盖 pending 与会话，旧窗口不隐藏，
 * 新内容量好尺寸后由一次几何更新换上去。
 *
 * @returns 是否交给了桌面窗口（false 表示当前不是 Tauri，调用方应回退）。
 */
export async function openDesktopMenu(
  items: ContextMenuItem[],
  anchor: { x: number; y: number },
  options?: {
    /**
     * 原生窗口没能在超时内确认显示时回调（调用方据此渲染页面内菜单）。
     *
     * 之所以做成回调而不是抛错：调用点此刻已经拿到了 items 与坐标，
     * 就地回退最省事，也不会让每个调用点都写一遍 catch。
     */
    onUnavailable?: () => void;
  },
): Promise<boolean> {
  if (!isTauri()) return false;
  if (items.length === 0) return true;

  const generation = ++openGeneration;
  await ensureBridge();
  if (generation !== openGeneration) return true;
  const handlers = new Map<string, () => void>();
  const wire = toWireMenu(items, handlers);
  const requestId = crypto.randomUUID();
  // 上一个菜单的 pending（连点右键）：直接丢，别让它的旧状态影响新菜单。
  detachPending();
  const menu: PendingMenu = {
    requestId,
    handlers,
    executed: false,
    shown: false,
    settleShown: null,
    onUnavailable: options?.onUnavailable,
  };
  pending = menu;
  latestRequestId = requestId;
  // 动作表留档：即使 pending 被提前摘掉，迟到的 select 也还能执行一次。
  rememberActions(requestId, handlers);
  pushOverlayLayer(OVERLAY_ID, OVERLAY_DEPTH);
  startSelectionPolling();
  const payload: MenuShowPayload = {
    requestId,
    theme: currentTheme(),
    anchor,
    width: MENU_WIDTH,
    items: wire,
  };
  // `desktop_menu_show` 现在**等页面量完尺寸才返回**：它能 resolve，就说明菜单
  // 窗口活着且 present 紧随其后。所以这里不再需要"等事件确认"的短计时器 ——
  // 那个短计时器正是之前菜单闪一下就消失的原因（事件丢一次就把菜单收掉）。
  try {
    await invoke("desktop_menu_show", { payload });
  } catch (error) {
    if (generation !== openGeneration) return true;
    // 原生窗口没接住这次请求（页面死了/超时）：说清原因并让调用方回退。
    announceFallback(messageOf(error));
    detachPending();
    throw error;
  }
  if (pending !== menu) return true;

  // 只兜"页面活着但 present 卡住"这种极端情况。`shown` 已经到过就不装。
  if (!menu.shown) {
    const timer = window.setTimeout(() => {
      if (pending !== menu) return;
      cancelDesktopMenu("timeout");
      announceFallback(i18n.t("菜单窗口未在 {{ms}}ms 内确认显示", { ms: PRESENT_TIMEOUT_MS }));
      options?.onUnavailable?.();
    }, PRESENT_TIMEOUT_MS);
    menu.settleShown = () => window.clearTimeout(timer);
  }
  return true;
}
