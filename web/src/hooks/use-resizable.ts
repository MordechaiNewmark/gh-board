import { useCallback, useRef, useState, type HTMLAttributes, type KeyboardEvent, type PointerEvent } from "react";

type Options = {
  /** localStorage key the width is saved under. */
  storageKey: string;
  defaultWidth: number;
  min: number;
  max: number;
  /** Which side of the splitter the panel sits on: dragging right grows a "left" panel and shrinks a "right" one. */
  side: "left" | "right";
  label: string;
};

const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, Math.round(v)));

function read(key: string, fallback: number, min: number, max: number) {
  try {
    const raw = localStorage.getItem(key);
    const n = raw === null ? NaN : Number(raw);
    return Number.isFinite(n) ? clamp(n, min, max) : fallback;
  } catch { return fallback; }
}
function write(key: string, value: number | null) {
  try { value === null ? localStorage.removeItem(key) : localStorage.setItem(key, String(value)); } catch { /* storage unavailable */ }
}

/** A draggable, keyboard-operable splitter that controls one panel's width and remembers it. */
export function useResizable({ storageKey, defaultWidth, min, max, side, label }: Options) {
  const [width, setWidth] = useState(() => read(storageKey, defaultWidth, min, max));
  const [dragging, setDragging] = useState(false);
  const drag = useRef<{ x: number; w: number } | null>(null);
  const latest = useRef(width);
  latest.current = width;
  const dir = side === "left" ? 1 : -1;

  const commit = useCallback((w: number, persist = true) => {
    const next = clamp(w, min, max);
    latest.current = next;
    setWidth(next);
    if (persist) write(storageKey, next);
  }, [min, max, storageKey]);

  const end = (e: PointerEvent<HTMLDivElement>) => {
    if (!drag.current) return;
    drag.current = null;
    setDragging(false);
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
    write(storageKey, latest.current);
  };

  const handleProps: HTMLAttributes<HTMLDivElement> & { "data-dragging"?: string } = {
    role: "separator",
    tabIndex: 0,
    "aria-orientation": "vertical",
    "aria-label": label,
    "aria-valuenow": width,
    "aria-valuemin": min,
    "aria-valuemax": max,
    title: "Drag to resize · double-click to reset",
    "data-dragging": dragging ? "true" : undefined,
    onPointerDown: (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      e.currentTarget.setPointerCapture(e.pointerId);
      e.currentTarget.focus();
      drag.current = { x: e.clientX, w: latest.current };
      setDragging(true);
    },
    onPointerMove: (e) => { if (drag.current) commit(drag.current.w + (e.clientX - drag.current.x) * dir, false); },
    onPointerUp: end,
    onPointerCancel: end,
    onDoubleClick: () => { latest.current = defaultWidth; setWidth(defaultWidth); write(storageKey, null); },
    onKeyDown: (e: KeyboardEvent<HTMLDivElement>) => {
      const step = e.shiftKey ? 48 : 16;
      if (e.key === "ArrowLeft") commit(latest.current - step * dir);
      else if (e.key === "ArrowRight") commit(latest.current + step * dir);
      else if (e.key === "Home") commit(min);
      else if (e.key === "End") commit(max);
      else if (e.key === "Enter") { latest.current = defaultWidth; setWidth(defaultWidth); write(storageKey, null); }
      else return;
      e.preventDefault();
    },
  };

  return { width, dragging, handleProps };
}
