import { useState, useEffect, forwardRef } from "react";

export type ThinkingPhase = "thinking" | "creating" | "analyzing" | "working" | "researching" | "fetching" | "writing" | "optimizing";

const PHASE_LABELS: Record<ThinkingPhase, string> = {
  thinking: "Thinking",
  creating: "Creating",
  analyzing: "Analyzing",
  working: "Working",
  fetching: "Fetching webpage",
  researching: "Researching",
  writing: "Writing",
  optimizing: "Optimizing",
};

type Props = {
  phase?: ThinkingPhase;
};

const TypingIndicator = forwardRef<HTMLDivElement, Props>(({ phase = "thinking" }, ref) => {
  const [dots, setDots] = useState(0);

  useEffect(() => {
    const interval = setInterval(() => {
      setDots((prev) => (prev + 1) % 4);
    }, 400);
    return () => clearInterval(interval);
  }, []);

  const label = PHASE_LABELS[phase] || "Thinking";
  const dotStr = ".".repeat(dots);

  return (
    <div ref={ref} className="flex items-center gap-2 px-4 py-3 max-w-2xl mx-auto animate-fade-in">
      <span className="text-sm text-muted-foreground font-medium">
        {label}{dotStr}
      </span>
    </div>
  );
});

TypingIndicator.displayName = "TypingIndicator";

export default TypingIndicator;

export function detectPhase(content: string, toolId?: string): ThinkingPhase {
  const lower = content.toLowerCase();
  
  if (/\b(analy[sz]e|review|evaluate|assess|compare)\b/.test(lower)) {
    return "analyzing";
  }
  if (/\b(research|find|search|look up|discover)\b/.test(lower)) {
    return "researching";
  }
  if (/\b(write|script|draft|compose|blog|article|story)\b/.test(lower)) {
    return "writing";
  }
  if (/\b(optimi[sz]e|seo|improve|enhance|boost)\b/.test(lower)) {
    return "optimizing";
  }
  
  if (toolId === "script-writer") return "writing";
  if (toolId === "seo-optimizer") return "optimizing";
  if (toolId === "content-optimizer") return "optimizing";
  if (toolId === "content-analyzer") return "analyzing";
  
  return "thinking";
}
