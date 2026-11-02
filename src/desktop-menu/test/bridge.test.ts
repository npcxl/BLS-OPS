import { describe, expect, it, vi } from "vitest";

import type { ContextMenuItem } from "@/components/ui/context-menu";
import { iconByName, iconNameOf } from "../icon-registry";
import { toWireMenu } from "../bridge";

const noop = () => undefined;

describe("desktop menu wire format", () => {
  it("never leaks functions and gives every action a unique id", () => {
    const handlers = new Map<string, () => void>();
    const items: ContextMenuItem[] = [
      { id: "open", label: "Open", onSelect: noop },
      { separator: true },
      {
        id: "more",
        label: "More",
        children: [
          { id: "child-a", label: "A", onSelect: noop },
          { id: "child-b", label: "B", disabled: true, onSelect: noop },
        ],
      },
      { id: "plain", label: "Plain" },
    ];
    const wire = toWireMenu(items, handlers);

    expect(wire[0].actionId).toBe("a0");
    expect(wire[1]).toEqual({ separator: true });
    expect(wire[2].actionId).toBeUndefined();
    expect(wire[2].children?.map((child) => child.actionId)).toEqual(["a1", "a2"]);
    expect(wire[3].actionId).toBeUndefined();
    expect(handlers.size).toBe(3);
    // JSON 往返必须成功：任何函数混进来都会在 IPC 前被卡住。
    expect(() => JSON.stringify(wire)).not.toThrow();
    expect(JSON.stringify(wire)).not.toContain("onSelect");
  });

  it("keeps danger / disabled / hint so the menu window can style the row", () => {
    const handlers = new Map<string, () => void>();
    const wire = toWireMenu(
      [
        {
          id: "delete",
          label: "Delete",
          danger: true,
          disabled: true,
          hint: "Del",
          onSelect: noop,
        },
      ],
      handlers,
    );
    expect(wire[0]).toMatchObject({
      id: "delete",
      label: "Delete",
      danger: true,
      disabled: true,
      hint: "Del",
    });
  });

  it("waits for the action map before invoking (only registered handlers run)", () => {
    const handlers = new Map<string, () => void>();
    const spy = vi.fn();
    toWireMenu([{ id: "x", label: "X", onSelect: spy }], handlers);
    handlers.get("a0")?.();
    expect(spy).toHaveBeenCalledTimes(1);
  });
});

describe("icon registry", () => {
  it("round-trips a known icon component through its name", async () => {
    const { Copy } = await import("@/components/icons");
    const name = iconNameOf(Copy);
    expect(name).toBeTruthy();
    expect(iconByName(name)).toBe(Copy);
  });

  it("returns undefined for unregistered icons instead of throwing", () => {
    const Local = () => null;
    expect(iconNameOf(Local)).toBeUndefined();
    expect(iconNameOf(undefined)).toBeUndefined();
    expect(iconByName("does-not-exist")).toBeUndefined();
  });
});
