import { describe, it, expect } from "vitest";
import { extractClaims, judgeClaim, needsFactCheck, runFactCheck, type Evidence } from "@/lib/ai/factcheck";

const E = (snippet: string, url = `https://s${Math.random()}.org`): Evidence => ({ title: "Source", url, snippet });
const claim = "The Eiffel Tower in Paris was completed in 1889.";

describe("fact-check judgement (mocked evidence)", () => {
  it("verifies supported claims, flags contradicted, conflicting and missing evidence", () => {
    expect(judgeClaim(1, claim, [E("The Eiffel Tower in Paris opened in 1889.")]).status).toBe("verified");
    expect(judgeClaim(1, claim, [E("The Eiffel Tower in Paris was finished in 1887 according to records.")]).status).toBe("contradicted");
    expect(judgeClaim(1, claim, [E("Eiffel Tower Paris 1889"), E("Eiffel Tower Paris 1887")]).status).toBe("partial");
    expect(judgeClaim(1, claim, []).status).toBe("unverified");
  });
  it("skips creative and code requests, extracts factual claims", () => {
    expect(needsFactCheck("write a poem about Paris", claim + " " + claim)).toBe(false);
    expect(extractClaims(`Intro text here.\n\n${claim}\n\n\`\`\`js\nconst x = 1999;\n\`\`\``)).toEqual([claim]);
  });
});

describe("runFactCheck pipeline", () => {
  const answer = `${claim} It is a famous landmark.`;
  it("does nothing (no statuses) when there are no claims", async () => {
    const st: string[] = [];
    const r = await runFactCheck("Sure, happy to help with that today.", { search: async () => ({ ok: true, results: [] }), emit: (s) => st.push(s) });
    expect(r.ran).toBe(false); expect(st).toEqual([]);
  });
  it("corrects a contradicted claim and re-verifies it", async () => {
    const st: string[] = [];
    const r = await runFactCheck(answer.replace("1889", "1887"), {
      search: async () => ({ ok: true, results: [E("The Eiffel Tower in Paris was completed in 1889.", "https://a.org"), E("Eiffel Tower Paris completed 1889", "https://b.org")] }),
      correct: async (t) => t.replace("1887", "1889"), emit: (s) => st.push(s),
    });
    expect(r.corrected).toBe(true);
    expect(r.records[0].status).toBe("verified");
    expect(st).toEqual(["verifying_accuracy", "searching_web", "reading_sources", "comparing_sources", "fact_checking", "detecting_issues", "fixing_issues", "verifying_accuracy", "searching_web", "reading_sources", "comparing_sources", "fact_checking"]);
    expect(st).not.toContain("completed");
    expect(r.text).toContain("Sources checked");
  });
  it("discloses when a correction still fails, bounded to one round", async () => {
    let calls = 0;
    const r = await runFactCheck(answer.replace("1889", "1887"), {
      search: async () => ({ ok: true, results: [E("The Eiffel Tower in Paris was completed in 1889.")] }),
      correct: async (t) => { calls++; return t; },
    });
    expect(calls).toBe(1); expect(r.rounds).toBe(2);
    expect(r.text).toContain("Sources disagree with");
  });
  it("reports failed retrieval honestly", async () => {
    const st: string[] = [];
    const r = await runFactCheck(answer, { search: async () => { throw new Error("down"); }, emit: (s) => st.push(s) });
    expect(r.searchFailed).toBe(true);
    expect(r.records[0].status).toBe("unverified");
    expect(st).not.toContain("reading_sources");
    expect(r.text).toContain("Web search was partly unavailable");
  });
});
