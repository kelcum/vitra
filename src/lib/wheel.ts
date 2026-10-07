import { useCallback, useRef } from "react";

/**
 * Lets the mouse wheel scroll a horizontal row. The page keeps scrolling as usual once the row
 * reaches its end, so a row never traps the wheel. Returns a callback ref, so it also works on rows
 * that appear later.
 */
export function useWheelScrollX<T extends HTMLElement>() {
  const detach = useRef<(() => void) | null>(null);
  return useCallback((el: T | null) => {
    detach.current?.();
    detach.current = null;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (Math.abs(e.deltaX) > Math.abs(e.deltaY) || e.ctrlKey) return;
      const max = el.scrollWidth - el.clientWidth;
      if (max <= 0) return;
      const atStart = el.scrollLeft <= 0 && e.deltaY < 0;
      const atEnd = el.scrollLeft >= max - 1 && e.deltaY > 0;
      if (atStart || atEnd) return;
      e.preventDefault();
      el.scrollBy({ left: e.deltaY });
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    detach.current = () => el.removeEventListener("wheel", onWheel);
  }, []);
}
