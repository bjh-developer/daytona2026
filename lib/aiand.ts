import OpenAI from "openai";
import { config } from "./config.ts";
import { humanFields, templateVerdict } from "./verdict.ts";
import type { DetonationResult, OcrResult, ScamVerdict, VisionResult, Verdict } from "./types.ts";

const SYSTEM =
  "You are a consumer scam explainer for Singaporeans. Given technical evidence from a " +
  "detonated phishing page, write a plain-English verdict a worried non-technical person understands. " +
  "Be direct, calm, specific. No jargon. Respond ONLY with JSON matching the schema. " +
  "IMPORTANT: if the funnel has more than one step, explain the WHOLE journey — what the " +
  "first page pretends to be and what it hands you off to. A page collecting NRIC/identity + " +
  "phone that then leads to a login page is a two-stage trap: a fake government/reward claim " +
  "that redirects to a fake login to steal the account. Describe that flow, not just the last page.";

function buildUserPrompt(
  det: DetonationResult,
  vision: VisionResult,
  ocr?: OcrResult,
  scam?: ScamVerdict,
): string {
  return JSON.stringify({
    impersonated_brand: vision.brand,
    is_login_form: vision.is_login_form,
    vision_confidence: vision.confidence,
    fields_asked_for: humanFields(det),
    spread_signals: det.spreadSignals,
    ocr_evidence: ocr?.evidenceLines ?? [],
    funnel_steps: det.redirectChain.length,
    redirect_chain: det.redirectChain,
    // Signal #6 — the evasion-proof behavioral verdict from the agent transcript
    // (docs/nosana-finetuning.md §5). Stronger than pixel-based vision; weight it.
    behavioral_verdict: scam
      ? {
          is_scam: scam.is_scam,
          confidence: scam.confidence,
          evidence: scam.evidence,
          explanation: scam.explanation,
        }
      : null,
    schema: {
      level: "scam|suspicious|unknown|clean",
      headline: "short, with a leading emoji — name the lure (e.g. fake GST voucher claim) if multi-step",
      explanation: "2-3 sentences covering the full funnel: entry lure → what it redirects to → what it steals",
      wormLine: "one sentence on how it spreads to contacts",
    },
  });
}

/**
 * Consumer verdict copy via ai&. Falls back to the deterministic template
 * (which is always correct on the mock kit) if ai& is unavailable or errors.
 * The behavioral scam verdict (signal #6) is passed through to the LLM as the
 * strongest single signal — when present, it should dominate the verdict level.
 */
export async function generateVerdict(
  det: DetonationResult,
  vision: VisionResult,
  ocr?: OcrResult,
  scam?: ScamVerdict,
): Promise<Verdict> {
  // Trust the behavioral classifier: a confident "not a scam" means the page is
  // legitimate (e.g. a real GitHub login on github.com). Short-circuit to a clean
  // verdict — don't let the scam-framed LLM prompt manufacture a false alarm.
  if (scam && !scam.is_scam && scam.confidence >= 0.6) {
    const brand =
      scam.brand_impersonated && !/^(none|unknown)$/i.test(scam.brand_impersonated)
        ? scam.brand_impersonated
        : "this site";
    return {
      level: "clean",
      headline: `✅ Looks legitimate — genuine ${brand}`,
      explanation:
        scam.explanation ||
        `This appears to be the real ${brand} on its official domain, not a phishing clone. Always double-check the address bar, but nothing here looks like a scam.`,
      harvestedFields: [],
      wormLine: "",
      source: "behavioral-classifier",
    };
  }

  if (config.useMocks || !config.aiand.apiKey) return templateVerdict(det, vision, ocr);

  try {
    const client = new OpenAI({ baseURL: config.aiand.baseUrl, apiKey: config.aiand.apiKey });
    const res = await client.chat.completions.create({
      model: config.aiand.model,
      max_tokens: 400,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: SYSTEM },
        { role: "user", content: buildUserPrompt(det, vision, ocr, scam) },
      ],
    });
    const json = JSON.parse(res.choices[0].message.content ?? "{}");
    const level = ["scam", "suspicious", "unknown", "clean"].includes(json.level)
      ? json.level
      : "suspicious";
    return {
      level,
      headline: String(json.headline ?? "⚠️ SUSPICIOUS"),
      explanation: String(json.explanation ?? ""),
      harvestedFields: humanFields(det),
      wormLine: String(json.wormLine ?? ""),
      source: "aiand",
    };
  } catch (err) {
    console.warn("[aiand] verdict failed, using template:", (err as Error).message);
    return templateVerdict(det, vision, ocr);
  }
}
