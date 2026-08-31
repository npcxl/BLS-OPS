import { useEffect } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";

type ResizeDirection = "East" | "North" | "NorthEast" | "NorthWest" | "South" | "SouthEast" | "SouthWest" | "West";

const EDGE = 6;

const HIT_BOX: Record<ResizeDirection, string> = {
  North: "ns-resize",
  South: "ns-resize",
  East: "ew-resize",
  West: "ew-resize",
  NorthEast: "nesw-resize",
  SouthWest: "nesw-resize",
  NorthWest: "nwse-resize",
  SouthEast: "nwse-resize",
};

function directionAt(x: number, y: number, w: number, h: number): ResizeDirection | null {
  const n = y <= EDGE;
  const s = y >= h - EDGE;
  const e = x >= w - EDGE;
  const wEdge = x <= EDGE;

  if (n && e) return "NorthEast";
  if (n && wEdge) return "NorthWest";
  if (s && e) return "SouthEast";
  if (s && wEdge) return "SouthWest";
  if (n) return "North";
  if (s) return "South";
  if (e) return "East";
  if (wEdge) return "West";
  return null;
}

/**
 * Re-enables window resizing for decorations:false windows.
 * Shows edge/corner resize cursors and initiates native resize on mousedown.
 */
export function useWindowResizeEdges() {
  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      const dir = directionAt(e.clientX, e.clientY, window.innerWidth, window.innerHeight);
      document.body.style.cursor = dir ? HIT_BOX[dir] : "";
    };

    const onDown = (e: MouseEvent) => {
      const dir = directionAt(e.clientX, e.clientY, window.innerWidth, window.innerHeight);
      if (!dir) return;
      e.preventDefault();
      void getCurrentWindow().startResizeDragging(dir);
    };

    window.addEventListener("mousemove", onMove);
    window.addEventListener("mousedown", onDown);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mousedown", onDown);
      document.body.style.cursor = "";
    };
  }, []);
}