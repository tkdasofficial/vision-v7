import { readFileSync } from "node:fs";
import { analyzeRequest } from "@/lib/ai/deep/analyze";
import { validateCandidate } from "@/lib/ai/deep/validators";
import { checkPlot } from "@/lib/ai/deep/plot";
const prompts = JSON.parse(readFileSync("/tmp/acc/prompts.json", "utf8"));
const t = readFileSync(process.argv[2], "utf8");
const a = analyzeRequest(prompts.story);
console.log(JSON.stringify({ analysis: a.items, names: a.instructions?.requiredNames, all: validateCandidate(t, a).map((i) => i.message), plot: checkPlot(t, a.items?.noun ?? "scene").map((i) => i.message) }, null, 1));
