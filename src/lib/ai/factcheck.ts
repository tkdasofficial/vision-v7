// Evidence-based fact-checking for default chat answers. Pure: search, correction and status are injected (tested with mocks).
// A claim is only "verified" when retrieved source text supports it deterministically — never because a model agreed.
import type { TaskStage } from "./task-events";

export type Evidence = { title: string; url: string; snippet: string };
export type ClaimStatus = "verified" | "contradicted" | "partial" | "unverified";
export type ClaimRecord = { id: number; claim: string; status: ClaimStatus; support: Evidence[]; conflict: Evidence[]; excerpt?: string; checkedAt: number };
export type FactCheckResult = { text: string; records: ClaimRecord[]; ran: boolean; corrected: boolean; searchFailed: boolean; rounds: number };

export const FACTCHECK_LIMITS = { maxClaims: 5, maxCorrections: 1, minAnswerChars: 60 } as const;

const NUM = /\b\d{1,3}(?:,\d{3})+(?:\.\d+)?\b|\b\d+(?:\.\d+)?%?/g;
const STOP = new Set("The A An In On Of And Or But It Its This That These Those Is Are Was Were Be For To With By As At From Also However Note Yes No I You We They He She Here There What Which Who When Where Why How".split(" "));

/** Creative, code, opinion and conversational requests are not fact-checked. */
export function needsFactCheck(request: string, answer: string): boolean {
  if (answer.length < FACTCHECK_LIMITS.minAnswerChars) return false;
  if (/\b(write|compose|draft|poem|story|lyrics|joke|imagine|fiction|code|function|script|regex|translate|rewrite|paraphrase|summari[sz]e (this|the following))\b/i.test(request)) return false;
  return extractClaims(answer).length > 0;
}

const keyTerms = (s: string) => [...new Set((s.match(/\b[A-Z][a-zA-Z\u00C0-\u024F'-]{2,}\b/g) ?? []).filter((w) => !STOP.has(w)))];
const numbers = (s: string) => [...new Set((s.match(NUM) ?? []).map((n) => n.replace(/,/g, "")))];

/** Verifiable claims: sentences with a number/date or at least two named entities, outside code. Most specific first. */
export function extractClaims(answer: string): string[] {
  const prose = answer.replace(/```[\s\S]*?```/g, " ").replace(/`[^`]*`/g, " ").replace(/^\s*>\s*\[![A-Z]+\][\s\S]*$/m, " ");
  const sentences = prose
    .split(/\n+|(?<=[.!?])\s+(?=[A-Z])/)
    .map((s) => s.replace(/^[\s>*#|\-\d.)]+/, "").replace(/[*_|]+/g, " ").replace(/\s+/g, " ").trim())
    .filter((s) => s.length >= 25 && s.length <= 400 && !/\?$/.test(s));
  const scored = sentences
    .map((s) => ({ s, score: numbers(s).length * 2 + keyTerms(s).length }))
    .filter((x) => (numbers(x.s).length > 0 && keyTerms(x.s).length > 0) || keyTerms(x.s).length >= 2);
  const seen = new Set<string>();
  return scored.sort((a, b) => b.score - a.score).map((x) => x.s).filter((s) => !seen.has(s) && seen.add(s)).slice(0, FACTCHECK_LIMITS.maxClaims);
}

/** Search query for one claim: its entities and figures, not the full sentence. */
export function claimQuery(claim: string): string {
  return [...keyTerms(claim).slice(0, 5), ...numbers(claim).slice(0, 2)].join(" ") || claim.slice(0, 120);
}

/** Deterministic judgement of one claim against evidence snippets. */
export function judgeClaim(id: number, claim: string, evidence: Evidence[], now = Date.now()): ClaimRecord {
  const terms = keyTerms(claim).map((t) => t.toLowerCase());
  const nums = numbers(claim);
  const support: Evidence[] = [], conflict: Evidence[] = [], partial: Evidence[] = [];
  for (const e of evidence) {
    const text = `${e.title} ${e.snippet}`.toLowerCase().replace(/,(?=\d{3})/g, "");
    const termHits = terms.filter((t) => text.includes(t)).length;
    const relevant = terms.length ? termHits / terms.length >= 0.5 : true;
    if (!relevant) continue;
    const snippetNums = numbers(text);
    const numHits = nums.filter((n) => new RegExp(`(^|[^\\d.])${n.replace(".", "\\.")}([^\\d]|$)`).test(text)).length;
    if (!nums.length) { (termHits === terms.length ? support : partial).push(e); continue; }
    if (numHits === nums.length) support.push(e);
    // Same subject, same kind of figure (e.g. a year or a %), but none of the claimed figures → contradicting evidence.
    else if (numHits === 0 && nums.some((n) => snippetNums.some((m) => sameKind(n, m))) && termHits === terms.length) conflict.push(e);
    else partial.push(e);
  }
  const status: ClaimStatus = support.length && !conflict.length ? "verified"
    : conflict.length && !support.length ? "contradicted"
    : support.length || partial.length ? "partial" : "unverified";
  const ex = (support[0] ?? conflict[0] ?? partial[0])?.snippet;
  return { id, claim, status, support, conflict, excerpt: ex?.slice(0, 240), checkedAt: now };
}

function sameKind(a: string, b: string): boolean {
  const year = (x: string) => /^(1[5-9]|20)\d\d$/.test(x);
  if (year(a) || year(b)) return year(a) && year(b);
  return a.endsWith("%") === b.endsWith("%") && a !== b && Math.abs(Math.log10(+a.replace("%", "") + 1) - Math.log10(+b.replace("%", "") + 1)) < 1;
}

export type FactCheckDeps = {
  search: (query: string) => Promise<{ ok: boolean; results: Evidence[] }>;
  /** Rewrites only the listed claims using the given evidence; returns the full corrected answer (or null). */
  correct?: (answer: string, problems: ClaimRecord[]) => Promise<string | null>;
  emit?: (stage: TaskStage, message?: string) => void;
  /** Evidence already retrieved for this request (reused before new searches). */
  initial?: Evidence[];
  now?: () => number;
};

async function verify(text: string, deps: FactCheckDeps) {
  const emit = deps.emit ?? (() => {});
  const claims = extractClaims(text);
  let searchFailed = false;
  const evidence: Evidence[][] = [];
  emit("searching_web", `Looking up ${claims.length} claim${claims.length === 1 ? "" : "s"}`);
  for (const c of claims) {
    const r = await deps.search(claimQuery(c)).catch(() => ({ ok: false, results: [] as Evidence[] }));
    if (!r.ok) searchFailed = true;
    evidence.push([...(deps.initial ?? []), ...r.results]);
  }
  const total = new Set(evidence.flat().map((e) => e.url)).size;
  if (total) emit("reading_sources", `Reading ${total} source${total === 1 ? "" : "s"}`);
  if (evidence.some((e) => new Set(e.map((x) => x.url)).size > 1)) emit("comparing_sources");
  emit("fact_checking", `Checking ${claims.length} claim${claims.length === 1 ? "" : "s"}`);
  const now = deps.now?.() ?? Date.now();
  return { records: claims.map((c, i) => judgeClaim(i + 1, c, evidence[i], now)), searchFailed };
}

/** Verify → (correct contradicted claims → re-verify), bounded. Returns the answer plus an honest disclosure when needed. */
export async function runFactCheck(answer: string, deps: FactCheckDeps): Promise<FactCheckResult> {
  const emit = deps.emit ?? (() => {});
  if (!extractClaims(answer).length) return { text: answer, records: [], ran: false, corrected: false, searchFailed: false, rounds: 0 };
  emit("verifying_accuracy");
  let text = answer, corrected = false, rounds = 1;
  let { records, searchFailed } = await verify(text, deps);
  for (let i = 0; i < FACTCHECK_LIMITS.maxCorrections && deps.correct; i++) {
    const bad = records.filter((r) => r.status === "contradicted");
    if (!bad.length) break;
    emit("detecting_issues", `${bad.length} claim${bad.length === 1 ? "" : "s"} conflict with sources`);
    emit("fixing_issues");
    const fixed = await deps.correct(text, bad).catch(() => null);
    if (!fixed?.trim()) break;
    text = fixed; corrected = true; rounds++;
    emit("verifying_accuracy", "Re-checking corrected claims");
    ({ records, searchFailed } = await verify(text, deps));
  }
  return { text: text + disclosure(records, searchFailed), records, ran: true, corrected, searchFailed, rounds };
}

/** Sources for verified claims, and an honest note for anything contradicted or unsupported. */
export function disclosure(records: ClaimRecord[], searchFailed: boolean): string {
  if (!records.length) return "";
  const verified = records.filter((r) => r.status === "verified");
  const open = records.filter((r) => r.status === "contradicted" || r.status === "unverified");
  const parts: string[] = [];
  const srcs = [...new Map(verified.flatMap((r) => r.support).map((e) => [e.url, e])).values()].slice(0, 5);
  if (srcs.length) parts.push(`**Sources checked:** ${srcs.map((e) => `[${e.title.replace(/[[\]]/g, "").slice(0, 70) || new URL(e.url).hostname}](${e.url})`).join(" · ")}`);
  if (open.length || searchFailed) {
    const lines = open.map((r) => `> - ${r.status === "contradicted" ? "Sources disagree with" : "Couldn't confirm"}: "${r.claim.slice(0, 140)}"`);
    parts.push(`> [!NOTE]\n> Fact-check: ${verified.length} of ${records.length} key claims were confirmed by sources.${searchFailed ? " Web search was partly unavailable." : ""}${lines.length ? "\n" + lines.join("\n") : ""}`);
  }
  return parts.length ? `\n\n${parts.join("\n\n")}` : "";
}
