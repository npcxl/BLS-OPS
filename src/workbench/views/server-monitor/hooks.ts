import { useEffect, useState } from "react";
import type { WorkbenchPane } from "@/workbench/types";

/** True when `tabId` is the visible tab of any pane (tabs stay mounted when hidden). */
export function isTabVisibleInPanes(tabId: string, pane: WorkbenchPane): boolean {
  if (!pane.children || pane.children.length === 0) return pane.activeTabId === tabId;
  return pane.children.some((child) => isTabVisibleInPanes(tabId, child));
}

/** Polling stops when the window is hidden — no point measuring a hidden page. */
export function usePageVisible(): boolean {
  const [visible, setVisible] = useState(() => !document.hidden);
  useEffect(() => {
    const onChange = () => setVisible(!document.hidden);
    document.addEventListener("visibilitychange", onChange);
    return () => document.removeEventListener("visibilitychange", onChange);
  }, []);
  return visible;
}
