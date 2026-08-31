import { useEffect, useRef, useState } from "react";

/**
 * Keep rendering `open` content briefly after it flips to false so the
 * closing overlay can play a fade-out before unmounting.
 */
export function useExiting(open: boolean, durationMs = 130): { render: boolean; exiting: boolean } {
  const [render, setRender] = useState(open);
  const [exiting, setExiting] = useState(false);
  const timer = useRef<number | null>(null);

  useEffect(() => {
    if (open) {
      if (timer.current) window.clearTimeout(timer.current);
      timer.current = null;
      setExiting(false);
      setRender(true);
      return;
    }
    if (render && !exiting) {
      setExiting(true);
      timer.current = window.setTimeout(() => {
        setRender(false);
        setExiting(false);
      }, durationMs);
    }
    return () => {
      if (timer.current) window.clearTimeout(timer.current);
      timer.current = null;
    };
  }, [open, render, exiting, durationMs]);

  return { render, exiting };
}
