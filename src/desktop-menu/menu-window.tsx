/**
 * 菜单窗口的根视图。
 *
 * 这个 React 树跑在**独立的透明 WebView** 里，只做三件事：
 * 1. 把主窗口下发的菜单数据渲染成一棵树（主菜单 + 一层子菜单）；
 * 2. 测量自身尺寸，交给 Rust 决定窗口位置与大小（屏幕边界只有原生侧知道）；
 * 3. 把点击结果按 `{ requestId, actionId }` 回传，绝不执行别处传来的代码。
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

/** 子菜单相对主面板的重叠量，和 Rust 的 `SUBMENU_OVERLAP` 保持一致。 */
const SUBMENU_OVERLAP = 6;

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
    children: wire.children?.map(toMenuItem),
  };
}

function translate(point: Point): string {
  return `translate3d(${point.x}px, ${point.y}px, 0)`;
}

export function DesktopMenuRoot() {
  const [payload, setPayload] = useState<MenuShowPayload | null>(null);
  const [layout, setLayout] = useState<MenuLayout | null>(null);
  const [active, setActive] = useState(-1);
  const [submenu, setSubmenu] = useState<number | null>(null);
  const [subActive, setSubActive] = useState(-1);
  const [submenuTop, setSubmenuTop] = useState(0);

  const mainRef = useRef<HTMLDivElement>(null);
  const subRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef(new Map<number, HTMLButtonElement>());
  const layoutRef = useRef<MenuLayout | null>(null);
  const requestRef = useRef<string | null>(null);
  const layoutSequence = useRef(0);
  const presentedRef = useRef<string | null>(null);
  const measuredRef = useRef({ width: 0, height: 0, subWidth: 0, subHeight: 0 });

  const items = useMemo(() => payload?.items.map(toMenuItem) ?? [], [payload]);
  const submenuItems = submenu === null ? [] : items[submenu]?.children ?? [];
  /**
   * 本次菜单登记过的动作。没有 `onSelect` 的父项 / 纯展示项不在里面：
   * 点它们不发请求，避免把业务 id 当成动作交给 Rust（那会直接被拒绝）。
   */
  const actionIds = useMemo(() => {
    const ids = new Set<string>();
    const walk = (list: WireMenuItem[]) => {
      for (const item of list) {
        if (item.actionId) ids.add(item.actionId);
        if (item.children) walk(item.children);
      }
    };
    if (payload) walk(payload.items);
    return ids;
  }, [payload]);
  const showIconColumn = items.some((item) => !item.separator && Boolean(item.icon));
  const showSubIconColumn = submenuItems.some(
    (item) => !item.separator && Boolean(item.icon),
  );

  const closeMenu = useCallback((reason: string) => {
    const requestId = requestRef.current;
    if (!requestId) return;
    requestRef.current = null;
    layoutSequence.current++;
    setPayload(null);
    setLayout(null);
    void invoke("desktop_menu_close", { requestId, reason }).catch(() => undefined);
  }, []);

  // ── 接收菜单数据 ────────────────────────────────────────────────────────
  useEffect(() => {
    let alive = true;
    const apply = (next: MenuShowPayload | null) => {
      if (!alive || !next || requestRef.current === next.requestId) return;
      requestRef.current = next.requestId;
      presentedRef.current = null;
      layoutSequence.current++;
      document.documentElement.dataset.theme = next.theme;
      layoutRef.current = null;
      measuredRef.current = { width: 0, height: 0, subWidth: 0, subHeight: 0 };
      setLayout(null);
      setActive(-1);
      setSubmenu(null);
      setSubActive(-1);
      setPayload(next);
    };
    // Install listeners before reading pending state. A late pending response must
    // never overwrite a newer show event.
    let sawShow = false;
    const unlisten = Promise.all([
      listen<MenuShowPayload>("desktop-menu:show", event => { sawShow = true; apply(event.payload); }),
      listen<{requestId: string}>("desktop-menu:reset", event => {
        if (!alive || requestRef.current !== event.payload.requestId) return;
        requestRef.current = null;
        layoutSequence.current++;
        setPayload(null); setLayout(null); setSubmenu(null);
      }),
      listen<{requestId: string; key: string}>("desktop-menu:key", event => {
        if (!alive || requestRef.current !== event.payload.requestId) return;
        window.dispatchEvent(new KeyboardEvent("keydown", {key: event.payload.key, cancelable: true}));
      }),
    ]);
    void unlisten.then(() => invoke<MenuShowPayload | null>("desktop_menu_pending"))
      .then(next => { if (!sawShow) apply(next); }).catch(() => undefined);
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

  useEffect(() => {
    if (payload) document.documentElement.dataset.theme = payload.theme;
  }, [payload]);

  useEffect(() => {
    if (layout) document.documentElement.dataset.material = layout.material;
  }, [layout]);

  // ── 测量并请原生侧定位 ──────────────────────────────────────────────────
  const requestLayout = useCallback(
    async (force: boolean) => {
      const main = mainRef.current;
      if (!payload || !main || requestRef.current !== payload.requestId) return;
      const sub = submenu === null ? null : subRef.current;
      const size = {
        width: main.offsetWidth,
        height: main.offsetHeight,
        subWidth: sub?.offsetWidth ?? 0,
        subHeight: sub?.offsetHeight ?? 0,
      };
      const last = measuredRef.current;
      const changed =
        Math.abs(last.width - size.width) > 0.5 ||
        Math.abs(last.height - size.height) > 0.5 ||
        Math.abs(last.subWidth - size.subWidth) > 0.5 ||
        Math.abs(last.subHeight - size.subHeight) > 0.5;
      if (!force && !changed) return;
      measuredRef.current = size;

      const submenuRect = sub
        ? {
            left: sub.offsetLeft - main.offsetLeft,
            top: sub.offsetTop - main.offsetTop,
            width: sub.offsetWidth,
            height: sub.offsetHeight,
          }
        : null;
      const sequence = ++layoutSequence.current;
      try {
        const next = await invoke<MenuLayout>("desktop_menu_layout", {
          requestId: payload.requestId,
          width: size.width,
          height: size.height,
          submenu: submenuRect,
        });
        if (requestRef.current !== payload.requestId || sequence !== layoutSequence.current) return;
        layoutRef.current = next;
        setLayout(next);
      } catch (error) {
        if (requestRef.current !== payload.requestId || sequence !== layoutSequence.current) return;
        console.error("[desktop-menu] layout failed", error);
        closeMenu("layout-error");
      }
    },
    [payload, submenu, closeMenu],
  );

  useLayoutEffect(() => {
    if (!payload) return;
    void requestLayout(true);
  }, [payload, requestLayout]);

  useEffect(() => {
    if (!payload || !layout || presentedRef.current === payload.requestId) return;
    const requestId = payload.requestId;
    const frame = requestAnimationFrame(() => {
      if (requestRef.current !== requestId) return;
      presentedRef.current = requestId;
      void invoke("desktop_menu_present", { requestId }).catch(() => {
        if (requestRef.current === requestId) closeMenu("layout-error");
      });
    });
    return () => cancelAnimationFrame(frame);
  }, [payload, layout, closeMenu]);

  // 菜单不取得焦点；来源窗口负责外部点击/失焦关闭，并转发菜单导航按键。

  // 应用 max-height 后内容会变矮：再测一次，让窗口贴合最终高度。
  useEffect(() => {
    if (!payload) return;
    const observer = new ResizeObserver(() => {
      void requestLayout(false);
    });
    if (mainRef.current) observer.observe(mainRef.current);
    if (subRef.current) observer.observe(subRef.current);
    return () => observer.disconnect();
  }, [payload, submenu, requestLayout]);

  // ── 交互 ────────────────────────────────────────────────────────────────
  const openSubmenu = useCallback((index: number) => {
    if (submenu === index) return;
    const node = itemRefs.current.get(index);
    setSubmenu(index);
    setSubActive(-1);
    setSubmenuTop(node ? node.offsetTop - SUBMENU_OVERLAP : 0);
  }, [submenu]);

  const activate = useCallback(
    (index: number, inSubmenu: boolean) => {
      const list = inSubmenu ? submenuItems : items;
      const item = list[index];
      if (!payload || !item || item.disabled || item.separator) return;
      if (item.children?.length) {
        if (!inSubmenu) openSubmenu(index);
        return;
      }
      if (!item.id || !actionIds.has(item.id)) return;
      void invoke("desktop_menu_select", {
        requestId: payload.requestId,
        actionId: item.id,
      }).catch(() => undefined);
    },
    [actionIds, items, openSubmenu, payload, submenuItems],
  );

  useEffect(() => {
    if (!payload) return;
    const onKeyDown = (event: KeyboardEvent) => {
      const inSubmenu = submenu !== null;
      const list = inSubmenu ? submenuItems : items;
      const current = inSubmenu ? subActive : active;
      const selectable: number[] = [];
      list.forEach((item, index) => {
        if (!item.separator && !item.disabled) selectable.push(index);
      });
      const setIndex = (index: number) =>
        inSubmenu ? setSubActive(index) : setActive(index);

      if (event.key === "Escape") {
        event.preventDefault();
        if (inSubmenu) {
          setSubmenu(null);
          setSubActive(-1);
          return;
        }
        closeMenu("escape");
        return;
      }

      if (event.key === "ArrowRight") {
        if (inSubmenu) return;
        const item = items[active];
        if (item?.children?.length) {
          event.preventDefault();
          openSubmenu(active);
        }
        return;
      }

      if (event.key === "ArrowLeft") {
        if (!inSubmenu) return;
        event.preventDefault();
        setSubmenu(null);
        setSubActive(-1);
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
    closeMenu,
    items,
    openSubmenu,
    payload,
    subActive,
    submenu,
    submenuItems,
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

  if (!payload) return <div className="desktop-menu__stage" />;

  const mainTransform = layout ? translate(layout.main) : "translate3d(-9999px, -9999px, 0)";
  const submenuLeft = payload.width - SUBMENU_OVERLAP;
  const submenuTransform = layout?.submenu
    ? translate({
        x: layout.submenu.x - submenuLeft,
        y: layout.submenu.y - submenuTop,
      })
    : "translate3d(-9999px, -9999px, 0)";
  const maxHeight = layout?.maxHeight;

  return (
    <div
      className="desktop-menu__stage"
      onMouseDownCapture={(event) => event.preventDefault()}
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) closeMenu("outside");
      }}
    >
      <div
        ref={mainRef}
        className="desktop-menu__panel"
        style={{
          width: payload.width,
          maxHeight,
          overflowY: maxHeight ? "auto" : undefined,
          transform: mainTransform,
          opacity: layout ? 1 : 0,
        }}
      >
        <MenuSurface flat className="desktop-menu__surface">
          {items.map((item, index) =>
            item.separator ? (
              <MenuSeparator key={`sep-${index}`} />
            ) : (
              <MenuItemRow
                key={item.id ?? index}
                item={item}
                highlighted={active === index}
                hasChildren={(item.children?.length ?? 0) > 0}
                submenuOpen={submenu === index}
                showIconColumn={showIconColumn}
                buttonRef={(node) => {
                  if (node) itemRefs.current.set(index, node);
                  else itemRefs.current.delete(index);
                }}
                onPointerEnter={() => {
                  if (item.disabled) return;
                  setActive(index);
                  if (item.children?.length) openSubmenu(index);
                  else setSubmenu(null);
                }}
                onClick={() => activate(index, false)}
              />
            ),
          )}
        </MenuSurface>
      </div>

      {submenuItems.length > 0 && (
        <div
          ref={subRef}
          className="desktop-menu__panel"
          style={{
            marginLeft: submenuLeft,
            marginTop: submenuTop,
            maxHeight,
            overflowY: maxHeight ? "auto" : undefined,
            transform: submenuTransform,
            opacity: layout?.submenu ? 1 : 0,
          }}
        >
          <MenuSurface flat className="desktop-menu__surface">
            {submenuItems.map((item, index) =>
              item.separator ? (
                <MenuSeparator key={`sub-sep-${index}`} />
              ) : (
                <MenuItemRow
                  key={item.id ?? index}
                  item={item}
                  highlighted={subActive === index}
                  showIconColumn={showSubIconColumn}
                  onPointerEnter={() => {
                    if (!item.disabled) setSubActive(index);
                  }}
                  onClick={() => activate(index, true)}
                />
              ),
            )}
          </MenuSurface>
        </div>
      )}
    </div>
  );
}
