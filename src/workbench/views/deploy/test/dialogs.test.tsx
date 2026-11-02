/**
 * Deployment forms share the same field contract as the rest of the app:
 * required fields carry a label star, validation errors sit under the field
 * (not in a page-level banner), and editing clears that field's error.
 */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import "@/i18n";
import { i18n } from "@/i18n";
import { newApplication } from "../form";
import { ApplicationDialog } from "../dialogs";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement | null = null;
let root: Root | null = null;

beforeAll(async () => {
  await i18n.changeLanguage("zh-CN");
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  container = null;
  root = null;
  document.body.innerHTML = "";
});

function render() {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() =>
    root!.render(
      <ApplicationDialog
        open={null}
        draft={newApplication("srv-1")}
        onCancel={() => undefined}
        onSubmit={() => undefined}
      />,
    ),
  );
}

function saveButton() {
  return Array.from(document.querySelectorAll("button")).find(
    (button) => button.textContent === i18n.t("Save"),
  );
}

function type(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("deployment form fields", () => {
  it("renders required markers and puts validation errors under the field", () => {
    render();
    const save = saveButton();
    expect(save).toBeTruthy();

    act(() => save!.click());

    const nameInput = document.querySelector<HTMLInputElement>("input");
    expect(nameInput?.getAttribute("aria-invalid")).toBe("true");
    expect(document.querySelector('[role="alert"]')?.textContent).toBe(
      i18n.t("This field is required"),
    );
    expect(document.body.textContent).toContain("*");
  });

  it("clears a field error as soon as the user edits it", () => {
    render();
    const save = saveButton();
    act(() => save!.click());

    const [nameInput, sourceInput] = Array.from(
      document.querySelectorAll<HTMLInputElement>("input"),
    );
    expect(nameInput.getAttribute("aria-invalid")).toBe("true");

    act(() => type(nameInput, "shop"));
    expect(nameInput.getAttribute("aria-invalid")).toBeNull();

    act(() => type(sourceInput, "/srv/shop"));
    expect(document.querySelector('[role="alert"]')).toBeNull();
    expect(sourceInput.getAttribute("aria-invalid")).toBeNull();
  });
});
