import { useEffect, useState } from "react";

/**
 * Keep rendering `open` content briefly after it flips to false so the
 * closing overlay can play a fade-out before unmounting.
 *
 * The timer is owned by the effect instance that scheduled it: its cleanup
 * runs only when `open`, `render` or `durationMs` change — never on the
 * `exiting` transition. An earlier version kept `exiting` in the deps and
 * guarded scheduling with `if (render && !exiting)`, so the state flip
 * re-ran the effect, cleared the pending timer, and never rescheduled:
 * the node stayed mounted forever as an invisible overlay that kept
 * blocking clicks.
 */
export function useExiting(open: boolean, durationMs = 130): { render: boolean; exiting: boolean } {
  const [render, setRender] = useState(open);
  const [exiting, setExiting] = useState(false);

  useEffect(() => {
    if (open) {
      // Opening (or re-opening mid-fade): cancel any pending unmount.
      setRender(true);
      setExiting(false);
      return;
    }
    if (!render) {
      setExiting(false);
      return;
    }
    // Closing: stay mounted for the fade-out, then unmount.
    setExiting(true);
    const timer = window.setTimeout(() => {
      setRender(false);
      setExiting(false);
    }, durationMs);
    return () => window.clearTimeout(timer);
  }, [open, render, durationMs]);

  return { render, exiting };
}
