// Deep Thinking Mode — bounded generate → validate → correct → revalidate workflow.
// Pure orchestration: the model call is injected, so this runs in unit tests with mocks.
import type { RequestAnalysis } from "./analyze";
import { nearestFeasible, planDurations } from "./durations";
import { ranges, validateCandidate, type Issue } from "./validators";
import { instructionAddendum, normalizeSections, spliceSections, splitSections } from "./instructions";

export type ChatMsg = { role: "system" | "user" | "assistant"; content: unknown };
export type CallResult = { ok: true; text: string; finishReason: string | null } | { ok: false; status: number; reason: string };
export type ModelCall = (messages: ChatMsg[]) => Promise<CallResult>;

/** Resource limits. Counts are batch sizes and caps on work per request, never assumptions about how many items exist.
 *  batchItems: sections per generation/correction call; reviewWindowChars: text per review call; maxReviewWindows: review calls per pass. */
export const DEEP_LIMITS = { maxCorrections: 2, maxContinuations: 3, budgetMs: 150_000, batchItems: 20, reviewWindowChars: 24_000, maxReviewWindows: 6 };

export type DeepResult =
  | { ok: true; text: string; remaining: Issue[]; corrections: number; continuations: number; stages: string[] }
  | { ok: false; status: number; reason: string; stages: string[] };

/** Extra system instructions derived from the deterministic analysis (incl. a pre-computed feasible timeline). */
export function planAddendum(a: RequestAnalysis): string {
  const lines: string[] = [];
  // Paragraphs/sentences/lines are parts of one text; labelling them ("Paragraph 1") breaks plain-text and "no headings" requests.
  if (a.items && (/^(paragraph|sentence|line|verse|stanza)s?$/i.test(a.items.noun) || a.instructions?.noHeadings)) lines.push(`Deliver exactly ${a.items.count} ${a.items.noun}s in order, separated by blank lines, with no labels or numbers in front of them.`);
  else if (a.items) lines.push(`Deliver exactly ${a.items.count} ${a.items.noun}s, labelled "${cap(a.items.noun)} 1" … "${cap(a.items.noun)} ${a.items.count}", in order. Do not add, merge, skip or reorder any.`);
  if (a.length === "short") lines.push("The user asked for a short answer: keep the final reply brief while keeping every required element.");
  if (a.length === "detailed") lines.push("The user asked for detail: give a complete, thorough answer covering every requested element.");
  if (a.wantsJson) lines.push("Output valid JSON in a single ```json fenced block.");
  if (a.allowedDurations) {
    lines.push(`Clip lengths may only be ${a.allowedDurations.join(", ")} seconds. Write each clip's length as "Duration: Ns" and give start/end times.`);
    if (a.totalDuration) {
      const n = a.items && (a.items.noun === "scene" || a.items.noun === "clip" || a.items.noun === "shot") ? a.items.count : undefined;
      const plan = planDurations(Math.round(a.totalDuration), a.allowedDurations, n);
      if (plan) lines.push(`A verified timeline that sums exactly to ${a.totalDuration}s: ${plan.join("s + ")}s. Use it (or another exact combination fitting the story).`);
      else {
        const near = nearestFeasible(Math.round(a.totalDuration), a.allowedDurations, n);
        lines.push(`It is mathematically impossible to reach exactly ${a.totalDuration}s with these clip lengths${n ? ` and ${n} clips` : ""}. State this conflict clearly and offer feasible alternatives${near.below || near.above ? ` (nearest exact totals: ${[near.below, near.above].filter(Boolean).map((v) => `${v}s`).join(" or ")})` : ""}. Never present an impossible timeline as exact.`);
      }
    }
  }
  if (a.instructions) lines.push(...instructionAddendum(a.instructions, a.items?.noun ?? null));
  return lines.length ? `\n\nRequirements checked automatically after you answer:\n- ${lines.join("\n- ")}` : "";
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

export const REVIEW_SYSTEM = "You are a strict, independent reviewer. You check a draft answer against the user's request before it is shown. Check: does it answer exactly what was asked (task, format, count, length, constraints)? Are facts, numbers, calculations, code and logic correct? Are claims presented as certain that are only assumptions? Is anything required missing? Reply with exactly the single word PASS if there are no real problems. Otherwise reply with a line 'ISSUES:' followed by one '- ' bullet per concrete problem. Do not rewrite the answer.";

/** Parses a reviewer verdict. Anything that is not a clear PASS with no bullets counts as issues. */
export function parseReview(text: string): { pass: boolean; issues: string[] } {
  const t = text.trim();
  const bullets = t.split("\n").map((l) => l.trim()).filter((l) => /^[-*•]\s+/.test(l)).map((l) => l.replace(/^[-*•]\s+/, "").trim()).filter(Boolean);
  if (/^\**PASS\**\.?$/i.test(t) || (/^\**PASS\b/i.test(t) && !bullets.length && !/ISSUES/i.test(t))) return { pass: true, issues: [] };
  return { pass: false, issues: bullets.length ? bullets.slice(0, 8) : [t.slice(0, 300) || "Reviewer returned no verdict"] };
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}\n…[truncated]` : s);

export async function runDeepPipeline(opts: {
  messages: ChatMsg[];
  analysis: RequestAnalysis;
  call: ModelCall;
  limits?: Partial<typeof DEEP_LIMITS>;
  now?: () => number;
  /** Latest user request, used by the hidden plan and review passes. */
  request?: string;
  /** Run a hidden planning pass before the answer (complex requests). */
  plan?: boolean;
  /** Run the independent model review loop after deterministic checks. */
  review?: boolean;
  /** Truthful progress events reflecting the stage actually running. */
  progress?: (stage: "analyzing" | "planning" | "generating" | "verifying" | "correcting" | "assembling") => void;
}): Promise<DeepResult> {
  const prog = opts.progress ?? (() => {});
  const L = { ...DEEP_LIMITS, ...opts.limits };
  const now = opts.now ?? Date.now;
  const start = now();
  const stages: string[] = [];
  const overBudget = () => now() - start > L.budgetMs;
  const request = opts.request ?? "";
  let messages = opts.messages;

  // 0. Hidden plan: analyze the task and outline the solution; never shown to the user.
  if (opts.plan && request) {
    stages.push("plan"); prog("planning");
    const p = await opts.call([
      { role: "system", content: "Analyze the user's request before anyone answers it. Output a concise internal plan: the exact task, required format/length/counts, constraints, sub-problems in order, facts or calculations to double-check, and likely pitfalls. Do not write the answer." },
      { role: "user", content: clip(request, 20000) },
    ]);
    if (p.ok && p.text.trim()) {
      const [sys, ...rest] = messages;
      const note = `\n\nInternal plan (hidden from the user; follow it, do not mention it):\n${clip(p.text.trim(), 6000)}`;
      messages = sys?.role === "system" ? [{ ...sys, content: `${String(sys.content)}${note}` }, ...rest] : [{ role: "system", content: note }, ...messages];
    } else stages.push("plan-failed");
  }

  const noun = opts.analysis.items?.noun ?? null;
  const count = opts.analysis.items?.count ?? 0;
  const label = noun ? cap(noun) : "";
  const contextFor = (txt: string, upTo: number) => {
    // Continuity reference for a batch: the first section (introductions) and the latest section written.
    const secs = splitSections(txt, noun!).sections.filter((x) => x.num < upTo);
    const pick = [secs[0], secs[secs.length - 1]].filter((x, k, a) => x && a.indexOf(x) === k);
    return pick.map((x) => clip(txt.slice(x.start, x.end).trim(), 3000)).join("\n\n");
  };

  // 1. Candidate — one call, or bounded batches of sections when the request is larger than one batch.
  stages.push("generate"); prog("generating");
  let text = "", finish: string | null = "stop", continuations = 0;
  let pending: number[] = [];
  if (noun && count > L.batchItems) {
    stages.push("batched");
    for (let a = 1; a <= count; a += L.batchItems) {
      const b = Math.min(count, a + L.batchItems - 1);
      if (overBudget()) { pending.push(...Array.from({ length: count - a + 1 }, (_, k) => a + k)); break; }
      const want = Array.from({ length: b - a + 1 }, (_, k) => a + k);
      const ctx = text ? `\n\nAlready written (continuity reference — keep characters, clothing, terms and format identical):\n${contextFor(text, a)}` : "";
      const r = await opts.call([...messages, { role: "user", content: `This answer has ${count} ${noun}s in total and is written in parts. Write ONLY ${label} ${a} to ${label} ${b}, labelled "${label} N", following every requirement above. No intro or closing remarks.${ctx}` }]);
      if (!r.ok) { if (!text) return { ok: false, status: r.status, reason: r.reason, stages }; pending.push(...Array.from({ length: count - a + 1 }, (_, k) => a + k)); break; }
      const got = splitSections(r.text, noun).sections.map((x) => x.num).filter((n) => want.includes(n));
      // Explicit completion check per batch: sections the batch skipped stay pending for correction.
      text = got.length ? (spliceSections(text, r.text, noun, got) ?? text) : text;
      if (r.finishReason === "length") stages.push("batch-truncated");
    }
    if (!text) text = "";
  } else {
    const first = await opts.call(messages);
    if (!first.ok) return { ok: false, status: first.status, reason: first.reason, stages };
    text = first.text; finish = first.finishReason;
    // 2. Continuation for provider output limits — append, never silently truncate.
    while (finish === "length" && continuations < L.maxContinuations && !overBudget()) {
      continuations++;
      stages.push("continue");
      const r = await opts.call([...messages, { role: "assistant", content: clip(text, 40000) },
        { role: "user", content: "Continue exactly where you stopped. Do not repeat anything already written and keep the same numbering and format." }]);
      if (!r.ok) break;
      text += r.text;
      finish = r.finishReason;
    }
  }

  // Deterministic structural repair (extras, duplicates, order) before spending model calls.
  if (noun && count) { const n = normalizeSections(text, noun, count); if (n !== text) { stages.push("normalize"); text = n; } }

  let reviewedText: string | null = null, reviewGap = "";
  const review = async (): Promise<Issue[] | null> => {
    stages.push("review"); prog("verifying");
    const consistency = opts.analysis.instructions?.consistency ? "\n\nAlso check continuity: each character's name, appearance and clothing must stay the same unless the story explicitly changes them, and events must follow in a logical order. Name the part number of any inconsistency." : "";
    // Windows of whole sections so every part is reviewed, each with the opening section as a cross-window reference.
    const secs = noun ? splitSections(text, noun).sections : [];
    const windows: { from: number; to: number; body: string }[] = [];
    if (secs.length && text.length > L.reviewWindowChars) {
      let cur: typeof secs = [];
      const flush = () => { if (cur.length) windows.push({ from: cur[0].num, to: cur[cur.length - 1].num, body: cur.map((x) => text.slice(x.start, x.end).trim()).join("\n\n") }); cur = []; };
      for (const x of secs) { if (cur.length && cur.reduce((n, y) => n + y.end - y.start, 0) + x.end - x.start > L.reviewWindowChars) flush(); cur.push(x); }
      flush();
    } else windows.push({ from: 0, to: 0, body: clip(text, L.reviewWindowChars) });
    const ref = secs.length && windows.length > 1 ? `\n\nReference — the opening ${noun} (for continuity only, already reviewed separately):\n${clip(text.slice(secs[0].start, secs[0].end).trim(), 3000)}` : "";
    const out: Issue[] = []; let done = 0;
    for (const w of windows.slice(0, L.maxReviewWindows)) {
      if (overBudget()) break;
      const part = windows.length > 1 ? `\n\nYou are reviewing ${label} ${w.from}–${w.to} of ${count}.` : "";
      const r = await opts.call([
        { role: "system", content: REVIEW_SYSTEM },
        { role: "user", content: `User request:\n${clip(request, 12000)}${consistency}${part}${w.from > 1 ? ref : ""}\n\nDraft answer:\n${w.body}` },
      ]);
      if (!r.ok) { stages.push("review-failed"); continue; }
      done++;
      for (const m of parseReview(r.text).issues) {
        const nums = noun ? [...m.matchAll(new RegExp(`\\b${noun}s?\\s*#?(\\d{1,4})`, "gi"))].map((x) => Number(x[1])).filter((n) => n >= 1 && n <= count) : [];
        out.push({ code: "review", message: m, ...(nums.length ? { items: [...new Set(nums)] } : {}) });
      }
    }
    if (!done) return null;
    reviewGap = done < windows.length ? `the independent review covered ${done} of ${windows.length} parts; the rest had only the automatic checks.` : "";
    reviewedText = text;
    return out;
  };

  // 3. Deterministic validation + independent review → bounded correction → revalidate.
  stages.push("validate");
  let issues = validateCandidate(text, opts.analysis, finish);
  if (opts.review && !issues.some((i) => i.code !== "truncated") && !overBudget()) {
    const r = await review();
    if (r) issues = [...issues, ...r];
  }
  let corrections = 0;
  while (issues.some((i) => i.code !== "truncated") && corrections < L.maxCorrections && !overBudget()) {
    corrections++;
    stages.push("correct"); prog("correcting");
    // Targeted: when every problem is local to labelled sections, rewrite only those (in batches) and splice them back.
    const labelled = noun ? splitSections(text, noun).sections.length > 0 : false;
    const targets = noun && labelled && issues.every((i) => i.items?.length) ? [...new Set(issues.flatMap((i) => i.items!))].sort((x, y) => x - y) : null;
    let candidate: string | null = null, candFinish: string | null = "stop";
    if (targets && noun) {
      stages.push("correct-sections");
      let work = text, any = false;
      for (let k = 0; k < targets.length && !overBudget(); k += L.batchItems) {
        const group = targets.slice(k, k + L.batchItems);
        const related = issues.filter((i) => i.items!.some((n) => group.includes(n))).map((i) => i.message);
        const r = await opts.call([...messages, { role: "assistant", content: clip(work, 40000) },
          { role: "user", content: `Automatic verification found these problems:\n- ${related.join("\n- ")}\nRewrite ONLY ${noun} ${ranges(group)} to fix them (write any missing ones), keeping the same labels ("${label} N"), characters and story. Output only those ${noun}s, nothing else.${contextFor(work, group[0]) ? `\n\nContinuity reference:\n${contextFor(work, group[0])}` : ""}` }]);
        if (!r.ok) break;
        const next = spliceSections(work, r.text, noun, group);
        if (next != null) { work = next; any = true; }
      }
      if (any) candidate = work;
    }
    if (candidate == null) {
      const r = await opts.call([...messages, { role: "assistant", content: clip(text, 40000) },
        { role: "user", content: `Automatic verification found these problems in your answer:\n- ${issues.map((i) => i.message).join("\n- ")}\nReturn the complete corrected answer only (not a diff, no commentary about the correction). Keep everything that was already correct.` }]);
      if (!r.ok) break;
      candidate = r.text; candFinish = r.finishReason;
    }
    if (noun && count) candidate = normalizeSections(candidate, noun, count);
    const r = { text: candidate, finishReason: candFinish };
    // Always revalidate the complete output, so a targeted fix can't hide a regression elsewhere.
    let next = validateCandidate(r.text, opts.analysis, r.finishReason);
    stages.push("revalidate");
    const prevDet = issues.filter((i) => i.code !== "review").length;
    if (next.length <= prevDet) {
      text = r.text;
      if (opts.review && !next.some((i) => i.code !== "truncated") && !overBudget()) {
        const rv = await review();
        if (rv) next = [...next, ...rv];
      }
      issues = next;
    } else stages.push("regression-rejected");
    if (!issues.length) break;
  }

  prog("assembling");
  // 4. Honest disclosure of anything still unresolved, unchecked or not generated within limits.
  const missingNow = noun && count ? issues.filter((i) => i.code === "missing").flatMap((i) => i.items ?? []) : [];
  if (issues.length) {
    text += `\n\n> **Verification note:** some requirements are still not met after ${corrections} correction attempt(s):\n${issues.map((i) => `> - ${i.message}`).join("\n")}`;
  } else if (opts.review && reviewedText !== text) {
    text += "\n\n> **Verification note:** the independent review step could not run for this answer, so only the automatic checks were applied.";
  } else if (reviewGap) text += `\n\n> **Verification note:** ${reviewGap}`;
  if (missingNow.length && (pending.length || overBudget())) {
    text += `\n>\n> The full ${count} ${noun}s could not be completed within this request's time limit. Reply "continue with ${noun}s ${ranges(missingNow)}" to generate the rest.`;
  }
  return { ok: true, text, remaining: issues, corrections, continuations, stages };
}
