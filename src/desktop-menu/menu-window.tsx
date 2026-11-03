/**
 * 菜单窗口的根视图。
 *
 * 这个 React 树跑在**独立的透明 WebView** 里，只做三件事：
 * 1. 把主窗口下发的菜单数据渲染成一棵树（主菜单 + 一层子菜单）；
 * 2. 测量自身尺寸，交给 Rust 决定窗口位置与大小（屏幕边界只有原生侧知道）；
 * 3. 把点击结果按 `{ requestId, actionId }` 回传，绝不执行别处传来的代码。
 *
 * # 显示流程（顺序是硬约束）
 *
 * ```
 * staged ──测量──► layout(revision) ──应用 max-height──► 再测量
 *        └──尺寸稳定──► present(requestId) ──► shown（几何与内容同帧切换）
 * ```
 *
 * 关键点：
 * * **present 之前窗口不动、不显示**。尺寸、最大高度、屏幕边界和 DPI 都在
 *   `layout` 里算完；第一次出现时几何已经是最终值，不存在"先显示再翻转"。
 * * **连续右键不隐藏窗口**。窗口可能正画着上一条菜单，新内容在隐藏的测量层
 *   里量好，`present` 一次性提交几何再换内容。
 * * **revision 单调递增**。同一个 requestId 下并发的两次测量返回顺序不可控，
 *   只有 revision 能挡住迟到的旧结果；Rust 也按 revision 拒绝过期请求。
 * * **主面板屏幕位置稳定**。子菜单左右翻转靠"窗口移动 + 面板偏移补偿"实现，
 *   主面板在屏幕上的矩形不变。
 *
 * 主菜单与子菜单放在同一个窗口里：鼠标从父项移到子菜单不会跨窗口，
 * 也就不会出现"经过间隙时菜单被失焦关掉"的问题。
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

import { MenuItemRow, MenuSeparator, MenuSurface } from "@/components/ui/menu-surface";
import type { ContextMenuItem } from "@/components/ui/context-menu";
import { iconByName } from "./icon-registry";
import type { MenuShowPayload, WireMenuItem } from "./bridge";

interface Point {
  x: number;
  y: number;
}

interface MenuLayout {
  main: Point;
  submenu: Point | null;
  maxHeight: number;
  material: string;
}

interface ShownMenu {
  payload: MenuShowPayload;
  layout: MenuLayout;
}

/** 测量任务：把哪一份菜单、带哪个子菜单，量给布局用。 */
interface Stage {
  payload: MenuShowPayload;
  submenu: number | null;
  /** 子菜单相对主面板顶部的位移（取自已显示的那一版）。 */
  submenuTop: number;
}

/** 子菜单相对主面板的重叠量，和 Rust 的 `SUBMENU_OVERLAP` 保持一致。 */
const SUBMENU_OVERLAP = 6;
/** 测量-布局迭代上限：max-height 与内容高度互相影响时最多收敛三轮。 */
const LAYOUT_ATTEMPTS = 3;

function toMenuItem(wire: WireMenuItem): ContextMenuItem {
  return {
    // actionId 是本次菜单内唯一的动作键；渲染时借 `id` 带过去，
    // 既当 React key，也当回传的 actionId。
    id: wire.actionId ?? wire.id,
    label: wire.label,
    icon: iconByName(wire.iconName),
    danger: wire.danger,
    disabled: wire.disabled,
    separator: wire.separator,
    hint: wire.hint,
    reason: wire.reason,
    children: wire.children?.map(toMenuItem),
  };
}

function translate(point: Point): string {
  return `translate3d(${point.x}px, ${point.y}px, 0)`;
}

function sameSize(
  a: { width: number; height: number },
  b: { width: number; height: number },
): boolean {
  return Math.abs(a.width - b.width) < 0.5 && Math.abs(a.height - b.height) < 0.5;
}

export function DesktopMenuRoot() {
  const [shown, setShown] = useState<ShownMenu | null>(null);
  const [stage, setStage] = useState<Stage | null>(null);
  const [active, setActive] = useState(-1);
  const [submenu, setSubmenu] = useState<number | null>(null);
  const [subActive, setSubActive] = useState(-1);
  const [submenuTop, setSubmenuTop] = useState(0);

  const stageRef = useRef<HTMLDivElement>(null);
  const stageSubRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const submenuRef = useRef<HTMLDivElement>(null);
  /** 显示层主菜单的行节点：子菜单要锚到具体那一行的 offsetTop 上。 */
  const mainItemRefs = useRef(new Map<number, HTMLButtonElement>());
  /** 测量层上**直接**设置的 max-height：布局算出多少就压到多少。 */
  const stageMaxHeightRef = useRef<number | null>(null);

  /** 当前正在服务的请求；关闭与迟到事件都拿它比对。 */
  const requestRef = useRef<string | null>(null);
  /** 布局 revision：每次测量 +1，**永不复用**。 */
  const revisionRef = useRef(0);
  /** 每次换请求/关闭 +1，用来丢弃上一个请求还在路上的异步结果。 */
  const generationRef = useRef(0);

  const shownItems = useMemo(() => shown?.payload.items.map(toMenuItem) ?? [], [shown]);
  const stageItems = useMemo(() => stage?.payload.items.map(toMenuItem) ?? [], [stage]);

  /**
   * 键盘作用于"用户此刻看到的那一版"：已经显示就是显示版，否则是正在测量的
   * 那一版（转发按键可能在 present 之前到达）。
   */
  const keyPayload = shown?.payload ?? stage?.payload ?? null;
  const keyItems = shown ? shownItems : stageItems;
  const keySubmenuItems = submenu === null ? [] : keyItems[submenu]?.children ?? [];
  const shownSubmenuItems = submenu === null ? [] : shownItems[submenu]?.children ?? [];

  /**
   * 本次菜单登记过的动作。没有 `onSelect` 的父项 / 纯展示项不在里面：
   * 点它们不发请求，避免把业务 id 当成动作交给 Rust（那会被直接拒绝）。
   */
  const actionIds = useMemo(() => {
    const ids = new Set<string>();
    const walk = (list: WireMenuItem[]) => {
      for (const item of list) {
        if (item.actionId) ids.add(item.actionId);
        if (item.children) walk(item.children);
      }
    };
    if (keyPayload) walk(keyPayload.items);
    return ids;
  }, [keyPayload]);

  /** 只收起**自己那一次**菜单：迟到的关闭不能带走新菜单。 */
  const closeMenu = useCallback((reason: string, expected?: string | null) => {
    const requestId = requestRef.current;
    if (!requestId) return;
    if (expected !== undefined && expected !== requestId) return;
    requestRef.current = null;
    generationRef.current++;
    setStage(null);
    setShown(null);
    void invoke("desktop_menu_close", { requestId, reason }).catch(() => undefined);
  }, []);

  // ── 接收菜单数据 ────────────────────────────────────────────────────────
  useEffect(() => {
    let alive = true;
    const apply = (next: MenuShowPayload | null) => {
      if (!alive || !next || requestRef.current === next.requestId) return;
      requestRef.current = next.requestId;
      generationRef.current++;
      revisionRef.current = 0;
      stageMaxHeightRef.current = null;
      // **保留**正在显示的上一条菜单：新内容量好之前，屏幕上不该出现空白。
      setActive(-1);
      setSubmenu(null);
      setSubActive(-1);
      setSubmenuTop(0);
      setStage({ payload: next, submenu: null, submenuTop: 0 });
    };
    // Install listeners before reading pending state. A late pending response must
    // never overwrite a newer show event.
    let sawShow = false;
    const unlisten = Promise.all([
      listen<MenuShowPayload>("desktop-menu:show", event => {
        sawShow = true;
        apply(event.payload);
      }),
      listen<{ requestId: string }>("desktop-menu:reset", event => {
        if (!alive || requestRef.current !== event.payload.requestId) return;
        requestRef.current = null;
        generationRef.current++;
        setStage(null);
        setShown(null);
        setSubmenu(null);
      }),
      listen<{ requestId: string; key: string }>("desktop-menu:key", event => {
        if (!alive || requestRef.current !== event.payload.requestId) return;
        window.dispatchEvent(
          new KeyboardEvent("keydown", { key: event.payload.key, cancelable: true }),
        );
      }),
    ]);
    void unlisten
      .then(() => invoke<MenuShowPayload | null>("desktop_menu_pending"))
      .then(next => {
        if (!sawShow) apply(next);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
      void unlisten.then(stops => stops.forEach(stop => stop()));
    };
  }, []);

  // 独立窗口没有页面级主题切换；主题、材质都由本次菜单决定。
  useEffect(() => {
    document.documentElement.dataset.menuWindow = "true";
    return () => {
      delete document.documentElement.dataset.menuWindow;
    };
  }, []);

  // 测量也要用本次菜单的主题：染色层与文字样式必须和最终显示一致。
  useEffect(() => {
    const theme = stage?.payload.theme ?? shown?.payload.theme;
    if (theme) document.documentElement.dataset.theme = theme;
  }, [stage, shown]);

  useEffect(() => {
    if (shown) document.documentElement.dataset.material = shown.layout.material;
  }, [shown]);

  // ── 测量 → 布局 → 提交 ──────────────────────────────────────────────────
  //
  // 整条链路跑在**隐藏的测量层**上：窗口此时要么还没显示，要么还画着上一条
  // 菜单。只有尺寸稳定后的那一次 `present` 才会改几何并换内容。
  useLayoutEffect(() => {
    if (!stage) return;
    const requestId = stage.payload.requestId;
    if (requestRef.current !== requestId) return;
    const generation = generationRef.current;
    // 同一个 requestId 的重新测量 = 子菜单展开/收起，不能重置用户的选择。
    const replacingPayload = shown?.payload.requestId !== requestId;

    const measure = () => {
      const panel = stageRef.current;
      const sub = stage.submenu === null ? null : stageSubRef.current;
      return {
        width: panel?.offsetWidth ?? 0,
        height: panel?.offsetHeight ?? 0,
        submenu:
          sub && panel
            ? {
                left: sub.offsetLeft - panel.offsetLeft,
                top: sub.offsetTop - panel.offsetTop,
                width: sub.offsetWidth,
                height: sub.offsetHeight,
              }
            : null,
      };
    };

    void (async () => {
      let size = measure();
      try {
        let plan: MenuLayout | null = null;
        for (let attempt = 0; attempt < LAYOUT_ATTEMPTS; attempt += 1) {
          plan = await invoke<MenuLayout>("desktop_menu_layout", {
            requestId,
            revision: (revisionRef.current += 1),
            width: size.width,
            height: size.height,
            submenu: size.submenu,
          });
          if (generation !== generationRef.current || requestRef.current !== requestId) return;
          if (Math.abs(plan.maxHeight - (stageMaxHeightRef.current ?? -1)) < 0.5) break;
          stageMaxHeightRef.current = plan.maxHeight;
          // 直接压在测量节点上：立刻重排，下一个 offsetHeight 就是最终高度。
          if (stageRef.current) stageRef.current.style.maxHeight = `${plan.maxHeight}px`;
          const next = measure();
          if (sameSize(next, size)) break;
          size = next;
        }
        if (!plan) return;

        // present 用同一次测量在原生侧重算几何并一次性提交（尺寸+位置+显示）；
        // 它成功之后才换内容，窗口第一次出现时就已经是最终几何。
        await invoke("desktop_menu_present", { requestId });
        if (generation !== generationRef.current || requestRef.current !== requestId) return;
        setShown({ payload: stage.payload, layout: plan });
        if (replacingPayload) {
          setSubmenu(stage.submenu);
          setSubActive(-1);
        }
        setStage(null);
      } catch (error) {
        if (generation !== generationRef.current || requestRef.current !== requestId) return;
        console.error("[desktop-menu] layout failed", error);
        closeMenu("layout-error", requestId);
      }
    })();
  }, [stage, shown?.payload.requestId, closeMenu]);

  // ── 交互 ────────────────────────────────────────────────────────────────
  /** 子菜单锚点：行在面板里的 offsetTop，减去重叠量。 */
  const submenuTopFor = useCallback((index: number) => {
    const node = mainItemRefs.current.get(index);
    return node ? node.offsetTop - SUBMENU_OVERLAP : 0;
  }, []);

  /**
   * 展开/收起子菜单。
   *
   * **先渲染、再量窗口**：子菜单立刻出现在面上（用户点下去就有反馈），
   * 窗口需要变大时由一次 `present` 补上；主面板的屏幕位置由 Rust 保持。
   * `top` 显式传：`setSubmenuTop` 之后同一轮里读到的仍是上一次的值。
   */
  const changeSubmenu = useCallback(
    (index: number | null, top: number) => {
      // **幂等**：悬停同一行会反复触发 pointerenter，若无条件重新测量就会
      // 每次提交一次几何 → 透明窗口反复重绘 → 主界面跟着闪。
      if (index === submenu && Math.abs(top - submenuTop) < 0.5) return;
      setSubmenu(index);
      setSubActive(-1);
      setSubmenuTop(top);
      // 还没有"已显示"的那一版时（present 未完成），改测量层：
      // 子菜单照样立刻出现在 DOM 里，布局会在下一轮把它算进窗口。
      const payload = shown?.payload ?? stage?.payload;
      if (!payload) return;
      setStage({ payload, submenu: index, submenuTop: top });
    },
    [shown, stage?.payload, submenu, submenuTop],
  );

  const openSubmenu = useCallback(
    (index: number) => changeSubmenu(index, submenuTopFor(index)),
    [changeSubmenu, submenuTopFor],
  );

  const activate = useCallback(
    (index: number, inSubmenu: boolean) => {
      const list = inSubmenu ? keySubmenuItems : keyItems;
      const item = list[index];
      if (!keyPayload || !item || item.disabled || item.separator) return;
      if (item.children?.length) {
        if (!inSubmenu) openSubmenu(index);
        return;
      }
      if (!item.id || !actionIds.has(item.id)) return;
      // 提交后由 Rust 收起窗口并转发；本地状态等 reset 事件再清。
      void invoke("desktop_menu_select", {
        requestId: keyPayload.requestId,
        actionId: item.id,
      }).catch(() => undefined);
    },
    [actionIds, keyItems, keyPayload, keySubmenuItems, openSubmenu],
  );

  useEffect(() => {
    if (!keyPayload) return;
    const onKeyDown = (event: KeyboardEvent) => {
      const inSubmenu = submenu !== null;
      const list = inSubmenu ? keySubmenuItems : keyItems;
      const current = inSubmenu ? subActive : active;
      const selectable: number[] = [];
      list.forEach((item, index) => {
        if (!item.separator && !item.disabled) selectable.push(index);
      });
      const setIndex = (index: number) => (inSubmenu ? setSubActive(index) : setActive(index));

      if (event.key === "Escape") {
        event.preventDefault();
        if (inSubmenu) {
          changeSubmenu(null, 0);
          return;
        }
        closeMenu("escape", keyPayload.requestId);
        return;
      }

      if (event.key === "ArrowRight") {
        if (inSubmenu) return;
        const item = keyItems[active];
        if (item?.children?.length) {
          event.preventDefault();
          openSubmenu(active);
        }
        return;
      }

      if (event.key === "ArrowLeft") {
        if (!inSubmenu) return;
        event.preventDefault();
        changeSubmenu(null, 0);
        return;
      }

      if (event.key === "Enter") {
        event.preventDefault();
        const item = list[current];
        if (!item || item.disabled || item.separator) return;
        if (item.children?.length) {
          if (!inSubmenu) openSubmenu(current);
          return;
        }
        activate(current, inSubmenu);
        return;
      }

      if (selectable.length === 0) return;

      if (event.key === "Home" || event.key === "End") {
        event.preventDefault();
        setIndex(event.key === "Home" ? selectable[0] : selectable[selectable.length - 1]);
        return;
      }

      if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
      event.preventDefault();
      const step = event.key === "ArrowDown" ? 1 : -1;
      const at = selectable.indexOf(current);
      if (at < 0) {
        setIndex(step === 1 ? selectable[0] : selectable[selectable.length - 1]);
        return;
      }
      setIndex(selectable[(at + step + selectable.length) % selectable.length]);
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [
    activate,
    active,
    changeSubmenu,
    closeMenu,
    keyItems,
    keyPayload,
    keySubmenuItems,
    openSubmenu,
    subActive,
    submenu,
  ]);

  // 菜单窗口里再右键：收起当前菜单，别让窗口留着不响应。
  useEffect(() => {
    const onContextMenu = (event: MouseEvent) => {
      event.preventDefault();
      closeMenu("outside");
    };
    window.addEventListener("contextmenu", onContextMenu);
    return () => window.removeEventListener("contextmenu", onContextMenu);
  }, [closeMenu]);

  /** 主菜单行（显示层与测量层共用）。 */
  const renderMainPanel = (options: {
    items: ContextMenuItem[];
    submenuIndex: number | null;
    interactive: boolean;
  }) => {
    const showIconColumn = options.items.some(
      (item) => !item.separator && Boolean(item.icon),
    );
    return options.items.map((item, index) =>
      item.separator ? (
        <MenuSeparator key={`sep-${index}`} />
      ) : (
        <MenuItemRow
          key={item.id ?? index}
          item={item}
          highlighted={options.interactive && active === index}
          hasChildren={(item.children?.length ?? 0) > 0}
          submenuOpen={options.interactive && options.submenuIndex === index}
          showIconColumn={showIconColumn}
          buttonRef={
            options.interactive
              ? node => {
                  if (node) mainItemRefs.current.set(index, node);
                  else mainItemRefs.current.delete(index);
                }
              : undefined
          }
          onPointerEnter={() => {
            if (!options.interactive || item.disabled) return;
            setActive(index);
            if (item.children?.length) openSubmenu(index);
            else if (submenu !== null) changeSubmenu(null, 0);
          }}
          onClick={() => {
            if (options.interactive) activate(index, false);
          }}
        />
      ),
    );
  };

  const renderSubmenuPanel = (options: {
    items: ContextMenuItem[];
    interactive: boolean;
  }) => {
    const showIconColumn = options.items.some(
      (item) => !item.separator && Boolean(item.icon),
    );
    return options.items.map((item, index) =>
      item.separator ? (
        <MenuSeparator key={`sub-sep-${index}`} />
      ) : (
        <MenuItemRow
          key={item.id ?? index}
          item={item}
          highlighted={options.interactive && subActive === index}
          showIconColumn={showIconColumn}
          onPointerEnter={() => {
            if (options.interactive && !item.disabled) setSubActive(index);
          }}
          onClick={() => {
            if (options.interactive) activate(index, true);
          }}
        />
      ),
    );
  };

  const stageSubmenuItems =
    stage && stage.submenu !== null ? stageItems[stage.submenu]?.children ?? [] : [];
  const submenuLeft = (shown?.payload.width ?? stage?.payload.width ?? 0) - SUBMENU_OVERLAP;
  // 子菜单最终位置由原生计划给：`layout.submenu` 可能翻到主面板左侧。
  const submenuDelta = shown?.layout.submenu
    ? {
        x: shown.layout.submenu.x - submenuLeft,
        y: shown.layout.submenu.y - submenuTop,
      }
    : null;

  return (
    <div
      className="desktop-menu__stage"
      onMouseDownCapture={(event) => event.preventDefault()}
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) closeMenu("outside");
      }}
    >
      {/* 测量层：不可见、不接收事件，但参与布局，量到的尺寸就是最终尺寸。 */}
      {stage && (
        <div
          aria-hidden="true"
          style={{
            position: "fixed",
            left: 0,
            top: 0,
            visibility: "hidden",
            pointerEvents: "none",
          }}
        >
          <div
            ref={stageRef}
            className="desktop-menu__panel"
            style={{ width: stage.payload.width, position: "absolute", left: 0, top: 0 }}
          >
            <MenuSurface flat className="desktop-menu__surface">
              {renderMainPanel({
                items: stageItems,
                submenuIndex: stage.submenu,
                interactive: false,
              })}
            </MenuSurface>
          </div>
          {stageSubmenuItems.length > 0 && (
            <div
              ref={stageSubRef}
              className="desktop-menu__panel"
              style={{
                width: stage.payload.width,
                position: "absolute",
                left: 0,
                top: 0,
                marginLeft: submenuLeft,
                marginTop: stage.submenuTop,
              }}
            >
              <MenuSurface flat className="desktop-menu__surface">
                {renderSubmenuPanel({ items: stageSubmenuItems, interactive: false })}
              </MenuSurface>
            </div>
          )}
        </div>
      )}

      {shown && (
        <>
          <div
            ref={panelRef}
            className="desktop-menu__panel"
            style={{
              width: shown.payload.width,
              maxHeight: shown.layout.maxHeight,
              overflowY: shown.layout.maxHeight ? "auto" : undefined,
              transform: translate(shown.layout.main),
            }}
          >
            <MenuSurface flat className="desktop-menu__surface">
              {renderMainPanel({
                items: shownItems,
                submenuIndex: submenu,
                interactive: true,
              })}
            </MenuSurface>
          </div>

          {shownSubmenuItems.length > 0 && (
            <div
              ref={submenuRef}
              className="desktop-menu__panel"
              style={{
                width: shown.payload.width,
                maxHeight: shown.layout.maxHeight,
                overflowY: shown.layout.maxHeight ? "auto" : undefined,
                marginLeft: submenuLeft,
                marginTop: submenuTop,
                transform: submenuDelta ? translate(submenuDelta) : undefined,
              }}
            >
              <MenuSurface flat className="desktop-menu__surface">
                {renderSubmenuPanel({ items: shownSubmenuItems, interactive: true })}
              </MenuSurface>
            </div>
          )}
        </>
      )}
    </div>
  );
}
