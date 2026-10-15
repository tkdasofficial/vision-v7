import { useEffect, useRef, type RefObject } from "react";
import { ZoomIn, ZoomOut } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/** Shared −/%/+ zoom buttons used by every full-screen viewer. */
export function ZoomControls({ percent, canOut, canIn, onOut, onIn, onReset, className, buttonClassName }: {
  percent: number; canOut: boolean; canIn: boolean; onOut: () => void; onIn: () => void; onReset: () => void; className?: string; buttonClassName?: string;
}) {
  return <div role="group" aria-label="Zoom" className={cn("flex items-center gap-0.5", className)}>
    <Button variant="ghost" size="icon" className={cn("size-9 rounded-full md:size-8 md:rounded-md", buttonClassName)} onClick={onOut} disabled={!canOut} aria-label="Zoom out" title="Zoom out"><ZoomOut /></Button>
    <Button variant="ghost" className={cn("h-9 min-w-12 rounded-full px-1 font-mono text-xs tabular-nums md:h-8 md:rounded-md", buttonClassName)} onClick={onReset} aria-label="Reset zoom" title="Reset zoom">{percent}%</Button>
    <Button variant="ghost" size="icon" className={cn("size-9 rounded-full md:size-8 md:rounded-md", buttonClassName)} onClick={onIn} disabled={!canIn} aria-label="Zoom in" title="Zoom in"><ZoomIn /></Button>
  </div>;
}

/** Two-finger pinch and Ctrl/⌘ + wheel zoom on an element; `get` / `set` work in the caller's units. */
export function usePinchZoom(ref: RefObject<HTMLElement | null>, get: () => number, set: (value: number) => void, wheelStep: number) {
  const api = useRef({ get, set });
  api.current = { get, set };
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let pinch: { d: number; s: number } | null = null;
    const dist = (t: TouchList) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
    const start = (e: TouchEvent) => { if (e.touches.length === 2) pinch = { d: dist(e.touches), s: api.current.get() }; };
    const move = (e: TouchEvent) => { if (e.touches.length === 2 && pinch && pinch.d > 0) { e.preventDefault(); api.current.set(pinch.s * (dist(e.touches) / pinch.d)); } };
    const end = () => { pinch = null; };
    const wheel = (e: WheelEvent) => { if (e.ctrlKey || e.metaKey) { e.preventDefault(); api.current.set(api.current.get() + (e.deltaY < 0 ? wheelStep : -wheelStep)); } };
    el.addEventListener("touchstart", start, { passive: true });
    el.addEventListener("touchmove", move, { passive: false });
    el.addEventListener("touchend", end);
    el.addEventListener("wheel", wheel, { passive: false });
    return () => { el.removeEventListener("touchstart", start); el.removeEventListener("touchmove", move); el.removeEventListener("touchend", end); el.removeEventListener("wheel", wheel); };
  });
}
