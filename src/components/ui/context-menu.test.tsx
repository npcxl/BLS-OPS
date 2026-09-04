import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ContextMenu, useContextMenu, type ContextMenuItem } from "@/components/ui/context-menu";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * Host component: one right-clickable area plus the menu, which is how every
 * real call site is wired.
 */
function Harness({ items }: { items: ContextMenuItem[] }) {
  const menu = useContextMenu();
  return (
    <div>
      <div data-testid="target" onContextMenu={menu.onContextMenu(() => items)} />
      <div data-testid="outside" />
      <ContextMenu {...menu.props} />
    </div>
  );
}

const menuEl = () => document.body.querySelector<HTMLElement>('[role="menu"]');
/** Every open menu: index 0 is the root, index 1 the submenu panel. */
const menuEls = () => Array.from(document.body.querySelectorAll<HTMLElement>('[role="menu"]'));
const menuItems = () => Array.from(document.body.querySelectorAll<HTMLElement>('[role="menuitem"]'));

/** happy-dom needs the geometry properties the menu clamps against. */
function stubViewport(width = 1200, height = 800) {
  Object.defineProperty(window, "innerWidth", { value: width, configurable: true });
  Object.defineProperty(window, "innerHeight", { value: height, configurable: true });
}

let holder: HTMLDivElement;
let root: Root;

function render(items: ContextMenuItem[]) {
  act(() => {
    root.render(<Harness items={items} />);
  });
}

/** Fires a real right-click sequence: pointerdown, then contextmenu. */
function rightClick(selector: string, x = 10, y = 10) {
  const target = holder.querySelector<HTMLElement>(selector)!;
  act(() => {
    target.dispatchEvent(
      new (window as unknown as { PointerEvent: typeof MouseEvent }).PointerEvent("pointerdown", {
        bubbles: true,
        button: 2,
        clientX: x,
        clientY: y,
      }),
    );
    target.dispatchEvent(
      new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: x, clientY: y }),
    );
  });
}

function leftClick(selector: string) {
  const target = holder.querySelector<HTMLElement>(selector)!;
  act(() => {
    target.dispatchEvent(
      new (window as unknown as { PointerEvent: typeof MouseEvent }).PointerEvent("pointerdown", {
        bubbles: true,
        button: 0,
      }),
    );
  });
}

function pressKey(key: string) {
  act(() => {
    window.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
  });
}

const simpleItems: ContextMenuItem[] = [
  { id: "open", label: "打开" },
  { id: "sep", separator: true },
  { id: "delete", label: "删除", danger: true },
];

beforeEach(() => {
  stubViewport();
  holder = document.createElement("div");
  document.body.appendChild(holder);
  root = createRoot(holder);
});

afterEach(() => {
  act(() => root.unmount());
  holder.remove();
});

describe("ContextMenu", () => {
  it("stays closed until a right-click opens it", () => {
    render(simpleItems);
    expect(menuEl()).toBeNull();

    rightClick("[data-testid=target]");
    expect(menuEl()).not.toBeNull();
    expect(menuItems().map((item) => item.textContent)).toEqual(["打开", "删除"]);
  });

  it("closes on a left click anywhere outside the menu", () => {
    render(simpleItems);
    rightClick("[data-testid=target]");
    expect(menuEl()).not.toBeNull();

    leftClick("[data-testid=outside]");
    expect(menuEl()).toBeNull();
  });

  it("closes on Escape", () => {
    render(simpleItems);
    rightClick("[data-testid=target]");

    pressKey("Escape");
    expect(menuEl()).toBeNull();
  });

  it("closes when the window loses focus", () => {
    render(simpleItems);
    rightClick("[data-testid=target]");

    act(() => {
      window.dispatchEvent(new Event("blur"));
    });
    expect(menuEl()).toBeNull();
  });

  it("survives the right-click pointerdown, so re-opening elsewhere never flickers", () => {
    render(simpleItems);
    rightClick("[data-testid=target]", 100, 100);
    const first = menuEl();
    expect(first).not.toBeNull();

    // A right-click emits pointerdown *before* contextmenu. Closing on that
    // pointerdown is what makes the menu blank out and reappear; it must only
    // move instead. Same DOM node == never unmounted.
    rightClick("[data-testid=target]", 300, 200);
    expect(menuEl()).toBe(first);
  });

  it("closes when a right-click lands somewhere with no menu handler", () => {
    render(simpleItems);
    // Open from the handled element…
    rightClick("[data-testid=target]");
    expect(menuEl()).not.toBeNull();

    // …then right-click on a plain div: no handler prevents the default, so
    // the menu must go away instead of being left orphaned.
    const plain = document.createElement("div");
    document.body.appendChild(plain);
    act(() => {
      plain.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
    });
    expect(menuEl()).toBeNull();
    plain.remove();
  });

  it("runs the item and closes when one is clicked", () => {
    const onSelect = vi.fn();
    render([{ id: "open", label: "打开", onSelect }]);
    rightClick("[data-testid=target]");

    act(() => {
      menuItems()[0].click();
    });

    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(menuEl()).toBeNull();
  });

  it("never runs a disabled item", () => {
    const onSelect = vi.fn();
    render([{ id: "nope", label: "禁用", disabled: true, onSelect }]);
    rightClick("[data-testid=target]");

    act(() => {
      menuItems()[0].click();
    });

    expect(onSelect).not.toHaveBeenCalled();
    expect(menuEl()).not.toBeNull();
  });

  it("walks past separators and disabled items with the arrow keys", () => {
    const onSelect = vi.fn();
    render([
      { id: "a", label: "A", disabled: true, onSelect },
      { id: "sep", separator: true },
      { id: "b", label: "B", onSelect },
      { id: "c", label: "C", onSelect },
    ]);
    rightClick("[data-testid=target]");

    pressKey("ArrowDown");
    pressKey("Enter");
    // Down from nothing lands on the first *enabled* item (B), not A.
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(menuEl()).toBeNull();
  });

  it("Enter does nothing until an item is highlighted", () => {
    const onSelect = vi.fn();
    render([{ id: "a", label: "A", onSelect }]);
    rightClick("[data-testid=target]");

    pressKey("Enter");
    expect(onSelect).not.toHaveBeenCalled();
    expect(menuEl()).not.toBeNull();
  });

  it("clamps itself inside the viewport instead of overflowing", () => {
    stubViewport(400, 300);
    render(simpleItems);
    // Ask for a position far outside the window.
    rightClick("[data-testid=target]", 395, 295);

    const el = menuEl()!;
    const left = Number.parseFloat(el.style.left);
    const top = Number.parseFloat(el.style.top);
    expect(left).toBeLessThan(400);
    expect(top).toBeLessThan(300);
    expect(left).toBeGreaterThanOrEqual(0);
    expect(top).toBeGreaterThanOrEqual(0);
  });

  it("renders the optional title above the items", () => {
    act(() => {
      root.render(
        <ContextMenu open x={0} y={0} items={simpleItems} title="nginx.conf" onClose={() => undefined} />,
      );
    });
    expect(menuEl()?.textContent).toContain("nginx.conf");
  });

  it("renders nothing while closed", () => {
    act(() => {
      root.render(<ContextMenu open={false} x={0} y={0} items={simpleItems} onClose={() => undefined} />);
    });
    expect(menuEl()).toBeNull();
  });
});

describe("ContextMenu submenu", () => {
  /** Second `[role=menu]` in the document is always the submenu panel. */
  const submenuEl = () => menuEls()[1] ?? null;
  const submenuItems = () =>
    submenuEl() ? Array.from(submenuEl()!.querySelectorAll<HTMLElement>('[role="menuitem"]')) : [];

  const childItems: ContextMenuItem[] = [
    { id: "g0", label: "未分组" },
    { id: "g1", label: "生产环境" },
  ];
  const parentItems: ContextMenuItem[] = [
    { id: "open", label: "打开终端" },
    { id: "move", label: "移动到分组", children: childItems },
    { id: "delete", label: "删除", danger: true },
  ];

  function clickItem(item: HTMLElement) {
    act(() => {
      item.click();
    });
  }

  it("stays closed until the parent row is activated", () => {
    render(parentItems);
    rightClick("[data-testid=target]");

    expect(submenuEl()).toBeNull();
    expect(menuItems().map((item) => item.textContent)).toEqual(["打开终端", "移动到分组", "删除"]);
  });

  it("opens on click and lists the child items", () => {
    render(parentItems);
    rightClick("[data-testid=target]");

    clickItem(menuItems()[1]);

    expect(submenuEl()).not.toBeNull();
    expect(submenuItems().map((item) => item.textContent)).toEqual(["未分组", "生产环境"]);
    // The root menu must stay open behind it.
    expect(menuEl()).not.toBeNull();
  });

  it("runs the child handler and closes the whole menu", () => {
    const onSelect = vi.fn();
    const onParentSelect = vi.fn();
    render([
      { id: "move", label: "移动到分组", onSelect: onParentSelect, children: [{ id: "g1", label: "生产环境", onSelect }] },
    ]);
    rightClick("[data-testid=target]");

    clickItem(menuItems()[0]);
    clickItem(submenuItems()[0]);

    expect(onSelect).toHaveBeenCalledTimes(1);
    // A parent with children is a container, never an action itself.
    expect(onParentSelect).not.toHaveBeenCalled();
    expect(menuEl()).toBeNull();
  });

  it("Escape closes the submenu first, then the menu", () => {
    render(parentItems);
    rightClick("[data-testid=target]");
    clickItem(menuItems()[1]);
    expect(submenuEl()).not.toBeNull();

    pressKey("Escape");
    expect(submenuEl()).toBeNull();
    expect(menuEl()).not.toBeNull();

    pressKey("Escape");
    expect(menuEl()).toBeNull();
  });

  it("opens with ArrowRight and closes with ArrowLeft", () => {
    render(parentItems);
    rightClick("[data-testid=target]");

    // Down once lands on 打开终端 (no children); the second reaches the parent.
    pressKey("ArrowDown");
    pressKey("ArrowDown");
    pressKey("ArrowRight");
    expect(submenuEl()).not.toBeNull();

    pressKey("ArrowLeft");
    expect(submenuEl()).toBeNull();
  });

  it("walks the child items with the arrow keys and Enter", () => {
    const first = vi.fn();
    const second = vi.fn();
    render([
      { id: "move", label: "移动到分组", children: [{ id: "a", label: "A", onSelect: first }, { id: "b", label: "B", onSelect: second }] },
    ]);
    rightClick("[data-testid=target]");

    clickItem(menuItems()[0]);
    pressKey("ArrowDown");
    pressKey("Enter");

    expect(first).toHaveBeenCalledTimes(1);
    expect(menuEl()).toBeNull();
  });

  it("closes any open submenu when the cursor moves to a plain item", () => {
    render(parentItems);
    rightClick("[data-testid=target]");
    clickItem(menuItems()[1]);
    expect(submenuEl()).not.toBeNull();

    act(() => {
      // React derives onPointerEnter from the native pointerover event.
      menuItems()[0].dispatchEvent(new MouseEvent("pointerover", { bubbles: true }));
    });

    expect(submenuEl()).toBeNull();
  });
});
