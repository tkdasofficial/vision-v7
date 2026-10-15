// Typed task-lifecycle events streamed from /api/chat (`vision_task` SSE lines). Pure and browser-safe.

export type TaskStage =
  | "thinking" | "planning" | "analyzing" | "researching" | "searching_web" | "reading_sources"
  | "processing" | "building" | "writing" | "reviewing" | "validating" | "detecting_issues"
  | "correcting" | "retrying" | "finalizing" | "rendering" | "completed" | "failed" | "cancelled";

export const STAGE_LABELS: Record<TaskStage, string> = {
  thinking: "Thinking", planning: "Planning", analyzing: "Analyzing", researching: "Researching",
  searching_web: "Searching the Web", reading_sources: "Reading Sources", processing: "Processing Data",
  building: "Building", writing: "Writing", reviewing: "Reviewing", validating: "Validating",
  detecting_issues: "Detecting Issues", correcting: "Correcting", retrying: "Retrying",
  finalizing: "Finalizing", rendering: "Rendering Response", completed: "Completed", failed: "Failed", cancelled: "Cancelled",
};

export type TaskEvent = { taskId: string; seq: number; stage: TaskStage; message?: string; ts: number; meta?: Record<string, number | string> };
export type TaskState = { taskId: string; seq: number; stage: TaskStage; message?: string; history: TaskStage[] };

const STAGES = new Set(Object.keys(STAGE_LABELS));
export const isTerminalStage = (s: TaskStage) => s === "completed" || s === "failed" || s === "cancelled";

/** Validates an untrusted event; malformed events return null. */
export function parseTaskEvent(raw: unknown): TaskEvent | null {
  const e = raw as any;
  if (!e || typeof e.taskId !== "string" || !Number.isInteger(e.seq) || !STAGES.has(e.stage)) return null;
  return { taskId: e.taskId, seq: e.seq, stage: e.stage, message: typeof e.message === "string" ? e.message.slice(0, 160) : undefined, ts: Number(e.ts) || Date.now(), meta: e.meta && typeof e.meta === "object" ? e.meta : undefined };
}

/** Applies an event in order: other tasks, duplicates, out-of-order events and anything after a terminal stage are ignored. */
export function applyTaskEvent(state: TaskState | null, ev: TaskEvent, activeTaskId?: string): TaskState | null {
  if (activeTaskId && ev.taskId !== activeTaskId) return state;
  if (state && state.taskId === ev.taskId) {
    if (ev.seq <= state.seq || isTerminalStage(state.stage)) return state;
    const history = state.history[state.history.length - 1] === ev.stage ? state.history : [...state.history, ev.stage];
    return { taskId: ev.taskId, seq: ev.seq, stage: ev.stage, message: ev.message, history };
  }
  return { taskId: ev.taskId, seq: ev.seq, stage: ev.stage, message: ev.message, history: [ev.stage] };
}

/** Server-side emitter: numbers events per task so the client can order and de-duplicate them. */
export function taskEmitter(taskId: string, send: (line: string) => void) {
  let seq = 0;
  return (stage: TaskStage, message?: string, meta?: TaskEvent["meta"]) => {
    const ev: TaskEvent = { taskId, seq: ++seq, stage, message, ts: Date.now(), ...(meta ? { meta } : {}) };
    send(`data: ${JSON.stringify({ vision_task: ev })}\n\n`);
  };
}

/** Requests that depend on current or changing facts get a live search automatically (in "auto" search mode). */
export function needsLiveFacts(text: string): boolean {
  return /\b(latest|today'?s?|right now|currently|this (week|month|year)|recent(ly)?|news|breaking|price of|stock price|exchange rate|weather|score|election|20(2[5-9]|3\d))\b/i.test(text);
}
