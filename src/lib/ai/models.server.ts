// Model inventory per provider and per-mode candidate selection. Server-only.
import type { TaskClassification } from "./task-router";

export type Provider = "groq" | "nvidia" | "cf";
export type ModelRef = { provider: Provider; model: string; label: string };

export const MODELS = {
  nemotronSuper: { provider: "nvidia", model: "nvidia/nemotron-3-super-120b-a12b", label: "Nemotron 3 Super" },
  nemotronOmni: { provider: "nvidia", model: "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning", label: "Nemotron 3 Nano Omni" },
  groq20b: { provider: "groq", model: "openai/gpt-oss-20b", label: "GPT-OSS 20B (Groq)" },
  groq120b: { provider: "groq", model: "openai/gpt-oss-120b", label: "GPT-OSS 120B (Groq)" },
  cf20b: { provider: "cf", model: "@cf/openai/gpt-oss-20b", label: "GPT-OSS 20B (Cloudflare)" },
  cf120b: { provider: "cf", model: "@cf/openai/gpt-oss-120b", label: "GPT-OSS 120B (Cloudflare)" },
  cfQwen3: { provider: "cf", model: "@cf/qwen/qwen3-30b-a3b-fp8", label: "Qwen3 30B A3B (Cloudflare)" },
  cfQwq: { provider: "cf", model: "@cf/qwen/qwq-32b", label: "QwQ 32B (Cloudflare)" },
  cfVision: { provider: "cf", model: "@cf/meta/llama-4-scout-17b-16e-instruct", label: "Llama 4 Scout (Cloudflare)" },
  cfCoder: { provider: "cf", model: "@cf/qwen/qwen2.5-coder-32b-instruct", label: "Qwen2.5-Coder 32B (Cloudflare)" },
} satisfies Record<string, ModelRef>;

// Ordered candidates: first is preferred, the rest are tried only if it fails. At most 3 per request.
export function candidatesFor(c: TaskClassification): ModelRef[] {
  const m = MODELS;
  if (c.requiresMultimodalProcessing) return [m.nemotronOmni, m.cfVision];
  switch (c.executionMode) {
    case "deep": return [m.groq120b, m.nemotronSuper, m.cf120b];
    case "research": return [m.groq120b, m.nemotronSuper, m.cfQwen3];
    case "coding": return [m.cfCoder, m.groq120b, m.cf120b];
    default:
      return c.taskType === "light" ? [m.groq20b, m.cf20b, m.nemotronSuper] : [m.nemotronSuper, m.groq20b, m.cf20b];
  }
}
