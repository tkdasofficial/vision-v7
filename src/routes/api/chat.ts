import { createFileRoute } from "@tanstack/react-router";
import { normalizeMode } from "@/lib/ai/modes";
import { classifyTask } from "@/lib/ai/task-router";

// Orchestrator: auth + validation, then Task Router → model candidates → provider stream.
export const Route = createFileRoute("/api/chat")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        {
          const { factsFrom, assertSameOrigin } = await import("@/lib/cloud/security.server");
          try { assertSameOrigin(factsFrom(request.headers, null)); } catch (e: any) { return Response.json({ error: e.message }, { status: 403 }); }
        }
        const { getCaller } = await import("@/lib/cloud/auth.server");
        const caller = await getCaller();
        if (!caller) return Response.json({ error: "Please sign in to chat." }, { status: 401 });
        {
          const { d1Store } = await import("@/lib/cloud/security.server");
          const { enforceLimits, SECURITY_CONFIG } = await import("../../../security");
          try { await enforceLimits(d1Store, [[`chat:user:${caller.user.id}`, SECURITY_CONFIG.limits.chatPerUser]]); }
          catch (e: any) { return Response.json({ error: e.message }, { status: 429 }); }
        }

        const body: any = await request.json().catch(() => null);
        const raw = Array.isArray(body?.messages) ? body.messages.slice(-30) : [];
        let lastHasMedia = false;
        const messages = raw
          .map((m: any, i: number) => {
            const role = m.role === "assistant" ? "assistant" : "user";
            if (typeof m.content === "string") return { role, content: m.content.slice(0, 20000) };
            if (!Array.isArray(m.content)) return { role, content: "" };
            const text = m.content.filter((p: any) => p.type === "text").map((p: any) => String(p.text ?? "")).join("\n").slice(0, 20000);
            const images = role === "user" && i === raw.length - 1
              ? m.content.filter((p: any) => p.type === "image_url" && typeof p.image_url?.url === "string").slice(0, 4)
              : [];
            if (!images.length) return { role, content: text };
            lastHasMedia = true;
            return { role, content: [{ type: "text", text }, ...images.map((p: any) => ({ type: "image_url", image_url: { url: p.image_url.url } }))] };
          })
          .filter((m: any) => (typeof m.content === "string" ? m.content.trim() : m.content.length));
        if (!messages.length) return Response.json({ error: "Message is empty." }, { status: 400 });
        // Budgeted context: keep the newest turns and earlier standing instructions instead of blind truncation.
        const { budgetHistory } = await import("@/lib/ai/context");
        const budgeted = budgetHistory(messages);
        messages.splice(0, messages.length, ...budgeted.messages);

        const last = messages[messages.length - 1].content;
        const lastText = typeof last === "string" ? last : last.map((p: any) => p.text ?? "").join(" ");
        const legacyCoding = typeof body?.toolId === "string" && body.toolId.includes("code");
        const mode = legacyCoding ? "coding" : normalizeMode(body?.mode);
        const prevUser = [...messages].slice(0, -1).reverse().find((m: any) => m.role === "user");
        const previousText = prevUser ? (typeof prevUser.content === "string" ? prevUser.content : prevUser.content.map((p: any) => p.text ?? "").join(" ")) : undefined;
        const task = classifyTask({ text: lastText, mode, hasMedia: lastHasMedia, previousText });

        const { candidatesFor } = await import("@/lib/ai/models.server");
        const { streamFromProvider } = await import("@/lib/ai/providers.server");
        const { systemPromptFor } = await import("@/lib/ai/prompts.server");
        const deep = task.executionMode !== "default";
        // User preferences (Settings → AI Preferences) are read server-side, never trusted from the request.
        const { parsePrefs, promptAddendum } = await import("@/lib/settings");
        // One query loads prefs + this chat's project and its Memory setting (owner-checked).
        const { loadChatContext, loadProjectMemory } = await import("@/lib/ai/memory.server");
        const { includesPersonal } = await import("@/lib/ai/memory");
        const chatId = typeof body?.conversationId === "string" ? body.conversationId.slice(0, 64) : undefined;
        const chatCtx = await loadChatContext(caller.user.id, chatId);
        const prefs = parsePrefs(chatCtx.prefsRaw);
        let system = `${systemPromptFor(task)}\n\n${promptAddendum(prefs, { personal: includesPersonal(chatCtx.scope) })}`;
        if (chatCtx.scope === "project" && chatCtx.projectId && chatId) {
          const pm = await loadProjectMemory(caller.user.id, chatCtx.projectId, chatId);
          if (pm) system += `\n\n${pm}`;
        }
        let contentIntent: import("@/lib/ai/content-intent").IntentResult | null = null;
        // Content intent (copy-ready deliverable / code / data / normal answer) shapes the output format only.
        {
          const { detectContentIntent, intentAddendum } = await import("@/lib/ai/content-intent");
          contentIntent = lastHasMedia ? null : detectContentIntent(lastText, previousText);
          if (contentIntent) system += intentAddendum(contentIntent);
        }
        let searchUsed = "none";
        // "auto" also searches when any mode is explicitly asked for sources, so citations come from a real search, not memory.
        const { asksForSources } = await import("@/lib/ai/request-route");
        // The Web Search plugin forces a real retrieval for this message regardless of the auto setting.
        const pluginSearch = body?.webSearch === true;
        const wantSearch = pluginSearch || prefs.webSearch === "always" || (prefs.webSearch === "auto" && (task.executionMode === "research" || asksForSources(lastText)));
        if (wantSearch && lastText.trim()) {
          const { webSearch, sourcesBlock } = await import("@/lib/search/search.server");
          try {
            const s = await webSearch(pluginSearch ? lastText.replace(/^@Web Search\s*/i, "") : lastText, { signal: request.signal });
            searchUsed = `${s.status}:${s.used.join(",") || "none"}`;
            system += `\n\n${sourcesBlock(s.results, s.status, s.failed)}`;
          } catch (e) { console.error("[search]", e); system += "\n\nLive web search was unavailable; say so in the answer."; }
        }
        // Deep Thinking Mode: deterministic analysis; complex requests go through the bounded verify/correct pipeline.
        let deepAnalysis: import("@/lib/ai/deep/analyze").RequestAnalysis | null = null;
        const baseSystem = system;
        if (task.executionMode === "deep") {
          const { analyzeRequest } = await import("@/lib/ai/deep/analyze");
          const { planAddendum } = await import("@/lib/ai/deep/pipeline");
          const { buildRequirements, requirementsPrompt } = await import("@/lib/ai/requirements");
          const { taskBrief } = await import("@/lib/ai/context");
          deepAnalysis = analyzeRequest(lastText);
          const brief = taskBrief(lastText);
          system += planAddendum(deepAnalysis) + requirementsPrompt(buildRequirements(deepAnalysis, lastText)) + (brief ? `\n\n${brief}` : "");
        }
        if (budgeted.dropped) system += `\n\nNote: ${budgeted.dropped} older message(s) were left out to fit the context budget; if the user refers to them, say you can't see them instead of guessing.`;
        const fullMessages = [{ role: "system", content: system }, ...messages];

        if (deepAnalysis && !lastHasMedia) {
          const { runDeepPipeline } = await import("@/lib/ai/deep/pipeline");
          const { collectStream, sseChunk, sseDone, sseComment, sseStatus } = await import("@/lib/ai/deep/sse");
          const models = candidatesFor(task);
          let usedModel = "";
          const callWith = (order: typeof models) => async (msgs: unknown[]) => {
            let last: { ok: false; status: number; reason: string } = { ok: false, status: 502, reason: "no model" };
            for (const t of order) {
              const r = await streamFromProvider(t, msgs, { maxTokens: 8192, deep: true }, request.signal);
              if (r.ok) {
                try { const c = await collectStream(r.body); usedModel = t.label; return { ok: true as const, ...c }; }
                catch (e: any) { last = { ok: false, status: request.signal.aborted ? 499 : 502, reason: e?.message ?? "stream error" }; continue; }
              }
              last = { ok: false, status: r.status, reason: r.reason };
              if (r.status === 499) return last;
              console.error("[chat:deep]", t.provider, t.model, r.status, r.reason);
            }
            return last;
          };
          const call = callWith(models);
          // Verification prefers a different configured model than generation, for independent evidence.
          const reviewCall = callWith(models.length > 1 ? [...models.slice(1), models[0]] : models);
          const requestId = typeof body?.requestId === "string" && /^[\w-]{8,64}$/.test(body.requestId) ? body.requestId : crypto.randomUUID();
          const conversationId = typeof body?.conversationId === "string" ? body.conversationId.slice(0, 64) : undefined;
          const stream = new ReadableStream<Uint8Array>({
            async start(ctrl) {
              const ping = setInterval(() => { try { ctrl.enqueue(sseComment("thinking")); } catch { /* closed */ } }, 8000);
              ctrl.enqueue(sseComment("thinking"));
              try {
                const t0 = Date.now();
                const progress = (stage: string, detail?: string) => { try { ctrl.enqueue(sseStatus(stage, detail)); } catch { /* closed */ } };
                const { shouldDecompose, runDeepEngine } = await import("@/lib/ai/deep/engine");
                if (shouldDecompose(deepAnalysis!)) {
                  const { d1ExecutionStore } = await import("@/lib/ai/deep/store.server");
                  const r = await runDeepEngine({ request: lastText, requestId, conversationId, analysis: deepAnalysis!, baseSystem, call: call as any, reviewCall: reviewCall as any, store: d1ExecutionStore(caller.user.id), limits: { maxRetries: (await import("@/lib/ai/limits")).AI_LIMITS.outerRetries }, progress, log: (e) => console.log("[chat:deep:engine]", JSON.stringify({ user: caller.user.id, requestId, ...e })) });
                  console.log("[chat:deep]", JSON.stringify({ user: caller.user.id, engine: "tasks", model: usedModel, overall: r.state.overall, final: r.state.finalValidation, calls: r.calls, reused: r.reused, ms: Date.now() - t0 }));
                  if (r.state.overall === "failed" && !r.state.tasks.some((t) => t.output)) ctrl.enqueue(sseChunk(r.state.tasks.some((t) => /\(429\)/.test(t.findings.join(" "))) ? "AI is busy right now. Please try again in a moment." : "Deep Thinking couldn't produce an answer right now — no result was generated. Please try again."));
                  else for (let i = 0; i < r.text.length; i += 400) ctrl.enqueue(sseChunk(r.text.slice(i, i + 400)));
                  return;
                }
                progress("analyzing");
                const res = await runDeepPipeline({ messages: fullMessages as any, analysis: deepAnalysis!, call, request: lastText, plan: deepAnalysis!.complex || lastText.length > 400, review: true, progress });
                console.log("[chat:deep]", JSON.stringify({ user: caller.user.id, model: usedModel, ok: res.ok, stages: res.stages, corrections: res.ok ? res.corrections : 0, remaining: res.ok ? res.remaining.length : null, ms: Date.now() - t0 }));
                if (res.ok) {
                  for (let i = 0; i < res.text.length; i += 400) ctrl.enqueue(sseChunk(res.text.slice(i, i + 400)));
                } else if (res.status !== 499) {
                  ctrl.enqueue(sseChunk(res.status === 429 ? "AI is busy right now. Please try again in a moment." : "Deep Thinking couldn't produce an answer right now — no result was generated. Please try again."));
                }
              } catch (e) {
                console.error("[chat:deep]", e);
                ctrl.enqueue(sseChunk("Deep Thinking stopped because of an internal error — no verified answer was produced."));
              } finally {
                clearInterval(ping);
                try { ctrl.enqueue(sseDone()); ctrl.close(); } catch { /* closed */ }
              }
            },
          });
          return new Response(stream, {
            headers: {
              "Content-Type": "text/event-stream",
              "Cache-Control": "no-store",
              "X-Vision-Model": models[0]?.label ?? "",
              "X-Vision-Execution": task.executionMode,
              "X-Vision-Output": task.output,
              "X-Vision-Search": searchUsed,
              "X-Vision-Deep": "pipeline",
            },
          });
        }

        let lastStatus = 502;
        for (const t of candidatesFor(task)) {
          const r = await streamFromProvider(t, fullMessages, { maxTokens: deep ? 8192 : 4096, deep }, request.signal);
          if (r.ok) {
            // Some reasoning models end after thinking with no answer text; fall through to the next model then.
            const { untilAnswer } = await import("@/lib/ai/answer-guard");
            const guarded = await untilAnswer(r.body);
            if (!guarded) { console.error("[chat]", t.provider, t.model, "empty answer"); lastStatus = 502; continue; }
            const { wrapCopyReady } = await import("@/lib/ai/copy-ready-stream");
            const body = contentIntent?.intent === "deliverable" && contentIntent.single ? wrapCopyReady(guarded, contentIntent.rawMarkdown ? "text" : "markdown") : guarded;
            return new Response(body, {
              headers: {
                "Content-Type": "text/event-stream",
                "Cache-Control": "no-store",
                "X-Vision-Model": t.label,
                "X-Vision-Execution": task.executionMode,
                "X-Vision-Output": task.output,
                "X-Vision-Search": searchUsed,
              },
            });
          }
          if (r.status === 499) return new Response(null, { status: 499 });
          lastStatus = r.status;
          console.error("[chat]", t.provider, t.model, r.status, r.reason);
          // Auth/permission problems won't fix themselves on retry; try the next provider instead.
        }
        const status = lastStatus === 429 ? 429 : 502;
        return Response.json({ error: status === 429 ? "AI is busy right now. Please try again in a moment." : "AI couldn't answer right now." }, { status });
      },
    },
  },
});
