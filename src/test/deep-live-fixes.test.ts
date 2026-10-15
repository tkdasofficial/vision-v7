import { describe, it, expect } from "vitest";
import { parseInstructions, checkInstructions } from "@/lib/ai/deep/instructions";
import { asksForSources } from "@/lib/ai/request-route";

describe("Deep Thinking live-test regressions", () => {
  it("'no headings' is parsed and a heading in the answer is flagged", () => {
    const ins = parseInstructions("exactly 3 paragraphs; no headings, no bullet lists");
    expect(ins.noHeadings).toBe(true);
    expect(checkInstructions("## Paragraph 1\n\nText.", ins, null).map((i) => i.code)).toContain("headings");
    expect(checkInstructions("Text only.\n\nMore text.", ins, null).map((i) => i.code)).not.toContain("headings");
  });
  it("asking for sources triggers a real search, source code does not", () => {
    expect(asksForSources("Who won the 2018 World Cup? Cite sources.")).toBe(true);
    expect(asksForSources("Explain photosynthesis with sources")).toBe(true);
    expect(asksForSources("Show me the source code for a todo app")).toBe(false);
  });
});

import { shouldDecompose } from "@/lib/ai/deep/engine";
import { analyzeRequest } from "@/lib/ai/deep/analyze";
describe("Deep engine decomposition", () => {
  it("paragraphs of one text are written together, separate deliverables still split", () => {
    expect(shouldDecompose(analyzeRequest("Write a product description in exactly 3 paragraphs, each 40-60 words."))).toBe(false);
    expect(shouldDecompose(analyzeRequest("Write 6 visual prompts for a story about a fox"))).toBe(true);
  });
});

describe("unlabelled paragraph word counts", () => {
  it("checks each blank-line paragraph, not the whole answer", () => {
    const ins = parseInstructions("exactly 3 paragraphs; each paragraph between 5 and 8 words");
    const w = (n: number) => Array(n).fill("word").join(" ");
    expect(checkInstructions(`${w(6)}\n\n${w(7)}\n\n${w(5)}`, ins, "paragraph").filter((i) => i.code === "word_count")).toEqual([]);
    expect(checkInstructions(`${w(6)}\n\n${w(12)}\n\n${w(5)}`, ins, "paragraph")[0]?.message).toMatch(/paragraph 2 has 12/);
  });
});

import { validateCandidate } from "@/lib/ai/deep/validators";
describe("unlabelled paragraph count", () => {
  it("three plain paragraphs satisfy 'exactly 3 paragraphs'; two do not", () => {
    const a = analyzeRequest("Write exactly 3 paragraphs about bottles, no headings.");
    expect(validateCandidate("One here.\n\nTwo here.\n\nThree here?", a).map((i) => i.code)).not.toContain("missing");
    expect(validateCandidate("One here.\n\nThree here?", a).map((i) => i.code)).toContain("count");
  });
});
