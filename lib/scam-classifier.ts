import OpenAI from "openai";
import { config } from "./config.ts";
import { mockScamVerdict } from "./mocks.ts";
import { templateScamVerdict } from "./verdict.ts";
import type { AgentTranscript, DetonationResult, ScamVerdict } from "./types.ts";

const SYSTEM =
  "You are a scam analyst. Analyze the agent transcript of a page visit. " +
  "Every piece of evidence is something a scam kit MUST do to steal credentials. " +
  "Respond ONLY with JSON: " +
  '{"is_scam":boolean,"brand_impersonated":string,"evidence":string[],"confidence":number,"explanation":string}.';

/** Render the transcript to the text the model reasons over (doc §5.1). */
function renderTranscript(t: AgentTranscript): string {
  const lines: string[] = ["=== AGENT TRANSCRIPT ===", `Goal: ${t.goal}`];
  t.steps.forEach((s, i) => {
    const tag = s.kind === "action" ? "Action" : s.kind === "observed" ? "Observed" : "Observed after action";
    lines.push(`Step ${i} — ${tag}: ${s.label}`);
    if (s.detail) lines.push(`  ${s.detail}`);
  });
  lines.push("", "=== CONTEXT ===");
  if (t.context.domain) lines.push(`Domain: ${t.context.domain}`);
  if (t.context.claimed_brand) lines.push(`Claimed brand (from page): ${t.context.claimed_brand}`);
  if (t.context.real_brand_domain) lines.push(`Real ${t.context.claimed_brand || "brand"} domain: ${t.context.real_brand_domain}`);
  if (t.context.brand_note) lines.push(t.context.brand_note);
  lines.push(
    "",
    "=== TASK ===",
    "Analyze this transcript. Is this a scam? Respond ONLY with JSON: " +
      '{"is_scam":boolean,"brand_impersonated":string,"evidence":string[],"confidence":number,"explanation":string}.',
  );
  return lines.join("\n");
}

function parseVerdict(raw: string, source: string): ScamVerdict {
  const json = JSON.parse(raw.match(/\{[\s\S]*\}/)?.[0] ?? raw);
  return {
    is_scam: Boolean(json.is_scam),
    brand_impersonated: String(json.brand_impersonated ?? "Unknown"),
    evidence: Array.isArray(json.evidence) ? json.evidence.map(String) : [],
    confidence: Math.min(1, Math.max(0, Number(json.confidence ?? 0))),
    explanation: String(json.explanation ?? ""),
    source,
  };
}

async function callClassifier(
  client: OpenAI,
  model: string,
  transcript: AgentTranscript,
  fewShot: { user: string; assistant: string }[],
  source: string,
): Promise<ScamVerdict> {
  const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
    { role: "system", content: SYSTEM },
  ];
  for (const ex of fewShot) {
    messages.push({ role: "user", content: ex.user });
    messages.push({ role: "assistant", content: ex.assistant });
  }
  messages.push({ role: "user", content: renderTranscript(transcript) });
  const res = await client.chat.completions.create({
    model,
    max_tokens: 400,
    response_format: { type: "json_object" },
    messages,
  });
  return parseVerdict(res.choices[0].message.content ?? "{}", source);
}

/** Load few-shot examples from the corpus for in-context learning (doc §7). */
async function loadFewShotExamples(): Promise<{ user: string; assistant: string }[]> {
  try {
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const __dirname = fileURLToPath(new URL(".", import.meta.url));
    const path = resolve(__dirname, "../scripts/fixtures/corpus/few-shot.jsonl");
    const content = readFileSync(path, "utf8");
    return content
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const ex = JSON.parse(line);
        return {
          user: renderTranscript(ex.transcript),
          assistant: JSON.stringify(ex.ground_truth),
        };
      });
  } catch {
    // No few-shot file yet — zero-shot. That's the first baseline measurement.
    return [];
  }
}

/**
 * Classify a detonation transcript as scam or legitimate (signal #6, doc §8).
 *
 * Resolution order:
 *   1. Mock (USE_MOCKS=true) — canned positive example.
 *   2. Nosana text model (qwen2.5-7b-instruct) with few-shot examples.
 *   3. ai& text model (deepseek-v4-flash) with few-shot examples.
 *   4. Heuristic fallback (templateScamVerdict — the zero-AI floor).
 *
 * The fine-tuned model path (Phase 4) is the same client pointed at a Nosana
 * inference endpoint serving the tuned adapter — same OpenAI-compatible wire format.
 */
export async function classifyScam(
  transcript: AgentTranscript,
  det?: DetonationResult,
): Promise<ScamVerdict> {
  if (config.useMocks) return mockScamVerdict();

  const fewShot = await loadFewShotExamples();

  // Primary: Nosana text model.
  const nosanaUp = config.nosana.baseUrl && !config.nosana.forceFallback;
  if (nosanaUp) {
    try {
      const client = new OpenAI({ baseURL: config.nosana.baseUrl, apiKey: config.nosana.apiKey });
      return await callClassifier(client, config.nosana.textModel, transcript, fewShot, "nosana");
    } catch (err) {
      console.warn("[scam-classifier] Nosana failed, falling back to ai&:", (err as Error).message);
    }
  }

  // Fallback: ai& text model.
  if (config.aiand.apiKey) {
    try {
      const client = new OpenAI({ baseURL: config.aiand.baseUrl, apiKey: config.aiand.apiKey });
      return await callClassifier(client, config.aiand.model, transcript, fewShot, "aiand-fallback");
    } catch (err) {
      console.warn("[scam-classifier] ai& failed, using heuristic:", (err as Error).message);
    }
  }

  // Zero-AI floor.
  return templateScamVerdict(transcript, det);
}
