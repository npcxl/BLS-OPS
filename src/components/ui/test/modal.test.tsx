import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Modal } from "@/components/ui/modal";

// React 19 requires this flag for act() outside react-dom/test-utils.
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** The portal mounts directly into document.body. */
const overlay = () => document.body.querySelector<HTMLElement>(":scope > .fixed.inset-0");
const panel = () => document.body.querySelector<HTMLElement>(":scope > .fixed.inset-0 .glass-panel-strong");

/** Modal render durationMs is 150 in production; give the fade room to finish. */
const FADE_MS = 150;
const SETTLE_MS = FADE_MS + 100;

describe("Modal exit animation", () => {
  let holder: HTMLDivElement;
  let root: Root;

  const renderModal = (open: boolean) => {
    act(() => {
      root.render(
        <Modal open={open} title="Test modal" onClose={() => undefined}>
          <p>Content</p>
        </Modal>,
      );
    });
  };

  beforeEach(() => {
    holder = document.createElement("div");
    document.body.appendChild(holder);
    root = createRoot(holder);
  });

  afterEach(() => {
    act(() => root.unmount());
    holder.remove();
  });

  it("renders the overlay and panel while open", () => {
    renderModal(true);
    expect(overlay()).not.toBeNull();
    expect(panel()).not.toBeNull();
  });

  it("keeps the DOM for the fade-out right after closing", () => {
    renderModal(true);
    renderModal(false);
    // Still mounted during the 150 ms fade — removing instantly would clip it.
    expect(overlay()).not.toBeNull();
    expect(panel()).not.toBeNull();
  });

  it("removes the Modal and overlay from the DOM 150 ms after closing", async () => {
    renderModal(true);
    renderModal(false);

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, SETTLE_MS));
    });

    expect(overlay()).toBeNull();
    expect(panel()).toBeNull();
  });

  it("does not leave a stale unmount timer when re-opened mid-fade", async () => {
    renderModal(true);
    renderModal(false);
    // Re-open before the fade finished: the pending unmount must be cancelled.
    renderModal(true);

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, SETTLE_MS));
    });

    expect(overlay()).not.toBeNull();
    expect(panel()).not.toBeNull();
  });
});
