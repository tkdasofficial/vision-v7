import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Check, Copy, Download, Expand, Eye } from "lucide-react";
import { Button } from "@/components/ui/button";
import { downloadText, filenameFor } from "@/lib/code-files";
import FullScreenCodeView from "@/components/chat/full-screen-code-view";
import { useCopy } from "@/components/chat/use-copy";
import { detectLanguage, highlight } from "@/components/chat/highlight";
import { codeLanguageLabel } from "@/lib/code-language-label";

type Props = { code: string; language?: string; filename?: string; children?: ReactNode; copyText?: string; copyHtml?: () => string | undefined; label?: string; regionLabel?: string };
// Content-sized canvas capped at a square. Each code line stays on one line and is clipped at the edge.
// The canvas never scrolls or zooms itself: tapping, swiping or pinching it opens the full-screen viewer.
export default function CodeBlock({ code, language, filename, children, copyText, copyHtml, label, regionLabel }: Props) {
  const [open, setOpen] = useState(false);
  const [initialView, setInitialView] = useState<"code" | "preview">("code");
  const { copied, copy } = useCopy();
  const box = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const viewport = useRef<HTMLDivElement>(null);
  const [clipped, setClipped] = useState(false);
  const lang = useMemo(() => regionLabel ? language : detectLanguage(code, language), [code, language, regionLabel]);
  const hl = useMemo(() => highlight(code, lang), [code, lang]);
  const name = filenameFor(lang, filename);
  const canPreview = ["html", "htm", "svg"].includes(lang ?? "");
  const format = label || codeLanguageLabel(lang);

  useEffect(() => {
    const body = content.current;
    const area = viewport.current;
    if (!body || !area) return;
    const measure = () => setClipped(body.scrollHeight > area.clientHeight + 1);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(body);
    ro.observe(area);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const openIt = (e: Event) => { e.preventDefault(); setOpen(true); };
    let sx = 0, sy = 0;
    const ts = (e: TouchEvent) => { if (e.touches.length > 1) return openIt(e); sx = e.touches[0].clientX; sy = e.touches[0].clientY; };
    // Horizontal swipe or pinch opens the viewer; vertical swipes keep scrolling the chat.
    const tm = (e: TouchEvent) => {
      if (e.touches.length > 1) return openIt(e);
      const dx = Math.abs(e.touches[0].clientX - sx), dy = Math.abs(e.touches[0].clientY - sy);
      if (dx > 12 && dx > dy) openIt(e);
    };
    const wh = (e: WheelEvent) => { if (e.ctrlKey || e.metaKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) openIt(e); };
    el.addEventListener("touchstart", ts, { passive: false });
    el.addEventListener("touchmove", tm, { passive: false });
    el.addEventListener("wheel", wh, { passive: false });
    return () => { el.removeEventListener("touchstart", ts); el.removeEventListener("touchmove", tm); el.removeEventListener("wheel", wh); };
  }, []);

  return (
    <div ref={box} role={regionLabel ? "region" : undefined} aria-label={regionLabel} className="content-block my-3 w-full min-w-0 max-w-full">
      <div className="code-canvas content-block-frame relative flex max-h-[100cqw] flex-col overflow-hidden rounded-lg border border-border">
      <header className="content-block-header relative z-10 flex h-11 shrink-0 items-center gap-1 border-b border-border px-2">
        <span className="min-w-0 flex-1 truncate px-2 font-mono text-xs font-medium" title={`${format} · ${name}`}>{format}</span>
        {canPreview && <Button variant="ghost" size="icon" className="size-9 shrink-0 rounded-full md:size-8 md:rounded-md" aria-label="Preview code" title="Preview code" onClick={() => { setInitialView("preview"); setOpen(true); }}><Eye /></Button>}
        <Button variant="ghost" size="icon" className="size-9 shrink-0 rounded-full md:size-8 md:rounded-md" aria-label="Download code" title="Download code" onClick={() => downloadText(code, name)}><Download /></Button>
        <Button variant="ghost" size="icon" className="size-9 shrink-0 rounded-full md:size-8 md:rounded-md" aria-label={copied ? "Copied" : regionLabel ? `Copy ${format}` : "Copy code"} title={copied ? "Copied" : `Copy ${format}`} onClick={() => copy(copyText ?? code, copyHtml?.())}>{copied ? <Check /> : <Copy />}</Button>
        <Button variant="ghost" size="icon" className="hidden size-8 rounded-md md:inline-flex" aria-label="Expand code" title="Expand code" onClick={() => { setInitialView("code"); setOpen(true); }}><Expand /></Button>
      </header>
      <div
        ref={viewport}
        role="button" tabIndex={0} aria-label="Open code full screen"
        onClick={() => { setInitialView("code"); setOpen(true); }}
        onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setOpen(true); } }}
        className="relative min-h-0 shrink cursor-zoom-in overflow-hidden focus-visible:outline-2 focus-visible:outline-ring"
      >
        <div ref={content} className="content-block-body flow-root">
          {children ?? <pre className="m-0 overflow-hidden whitespace-pre p-4"><code className="hljs bg-transparent p-0 font-mono text-[13px] leading-[1.7]" dangerouslySetInnerHTML={{ __html: hl.html }} /></pre>}
        </div>
        {clipped && <div aria-hidden="true" className="content-block-fade pointer-events-none absolute inset-x-0 bottom-0 h-10" />}
      </div>
      <div className="content-block-footer hidden h-7 shrink-0 items-center justify-between gap-2 border-t border-border px-4 font-mono text-[11px] text-muted-foreground md:flex"><span className="truncate">{name}</span><span className="shrink-0">{code.split("\n").length} {code.includes("\n") ? "lines" : "line"}</span></div>
      </div>
      {open && <FullScreenCodeView code={code} language={lang} filename={filename} initialView={initialView} copyText={copyText} copyHtml={copyHtml} onClose={() => setOpen(false)} />}
    </div>
  );
}
