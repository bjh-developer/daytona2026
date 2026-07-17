import OpenAI from "openai";
import { config } from "./config.ts";
import { humanFields, templateVerdict } from "./verdict.ts";
import type { DetonationResult, OcrResult, VisionResult, Verdict } from "./types.ts";

const SYSTEM =
  "You are a consumer scam explainer for Singaporeans. Given technical evidence from a " +
  "detonated phishing page, write a plain-English verdict a worried non-technical person understands. " +
  "Be direct, calm, specific. No jargon. Respond ONLY with JSON matching the schema.";

function buildUserPrompt(det: DetonationResult, vision: VisionResult, ocr?: OcrResult): string {
  return JSON.stringify({
    impersonated_brand: vision.brand,
    is_login_form: vision.is_login_form,
    vision_confidence: vision.confidence,
    fields_asked_for: humanFields(det),
    spread_signals: det.spreadSignals,
    ocr_evidence: ocr?.evidenceLines ?? [],
    redirect_chain: det.redirectChain,
    schema: {
      level: "scam|suspicious|unknown|clean",
      headline: "short, with a leading emoji",
      explanation: "2-3 sentences, plain English",
      wormLine: "one sentence on how it spreads to contacts",
    },
  });
}

/**
 * Consumer verdict copy via ai&. Falls back to the deterministic template
 * (which is always correct on the mock kit) if ai& is unavailable or errors.
 */
export async function generateVerdict(
  det: DetonationResult,
  vision: VisionResult,
  ocr?: OcrResult,
): Promise<Verdict> {
  if (config.useMocks || !config.aiand.apiKey) return templateVerdict(det, vision, ocr);

  try {
    const client = new OpenAI({ baseURL: config.aiand.baseUrl, apiKey: config.aiand.apiKey });
    const res = await client.chat.completions.create({
      model: config.aiand.model,
      max_tokens: 400,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: SYSTEM },
        { role: "user", content: buildUserPrompt(det, vision, ocr) },
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
