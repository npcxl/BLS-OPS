import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import {
  PageHeader,
  PageTabs,
  SegmentedControl,
} from "@/workbench/page-layout";

/**
 * Page skeleton contract: category tabs are a named tablist with roving focus,
 * segmented controls expose pressed state, and every page renders one h1.
 */

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

function render(ui: React.ReactNode) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root!.render(ui));
  return container;
}

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

function TabsHarness() {
  const [value, setValue] = useState<"a" | "b">("a");
  return (
    <PageTabs
      value={value}
      onChange={setValue}
      label="Sections"
      panelId="panel"
      items={[
        { id: "a", label: "First" },
        { id: "b", label: "Second" },
      ]}
    />
  );
}

describe("page skeleton", () => {
  it("renders one page title with optional context and actions", () => {
    const view = render(
      <PageHeader title="Deployment" description="Plan first" context="web-01" actions={<button>New</button>} />,
    );
    const heading = view.querySelector("h1");
    expect(heading?.textContent).toBe("Deployment");
    expect(view.querySelector(".page-description")?.textContent).toBe("Plan first");
    expect(view.querySelector(".page-context")?.textContent).toBe("web-01");
    expect(view.querySelector(".page-actions button")?.textContent).toBe("New");
  });

  it("moves selection and focus with arrow keys", () => {
    const view = render(<TabsHarness />);
    const tabs = () => Array.from(view.querySelectorAll<HTMLButtonElement>('[role="tab"]'));
    expect(tabs()[0]?.getAttribute("aria-selected")).toBe("true");
    expect(tabs()[0]?.tabIndex).toBe(0);
    expect(tabs()[1]?.tabIndex).toBe(-1);

    act(() => {
      tabs()[0]!.dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true }),
      );
    });

    expect(tabs()[1]?.getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement).toBe(tabs()[1]);
  });

  it("exposes segmented controls as pressed buttons, not tabs", () => {
    const seen: string[] = [];
    const view = render(
      <SegmentedControl
        value="comfortable"
        onChange={(value) => seen.push(value)}
        label="Density"
        items={[
          { id: "comfortable", label: "Comfortable" },
          { id: "compact", label: "Compact" },
        ]}
      />,
    );
    const buttons = Array.from(view.querySelectorAll<HTMLButtonElement>("button"));
    expect(buttons.map((button) => button.getAttribute("aria-pressed"))).toEqual(["true", "false"]);
    expect(view.querySelector('[role="tablist"]')).toBeNull();

    act(() => buttons[1]!.click());
    expect(seen).toEqual(["compact"]);
  });
});
