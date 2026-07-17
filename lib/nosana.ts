import OpenAI from "openai";
import { config } from "./config.ts";
import { mockVision } from "./mocks.ts";
import type { VisionResult } from "./types.ts";

const VISION_PROMPT =
  "You are a phishing brand classifier. Look at this webpage screenshot. " +
  "Respond ONLY with JSON: {\"brand\": string, \"is_login_form\": boolean, \"confidence\": number 0..1}. " +
  "brand = the company the page is impersonating (e.g. Telegram). " +
  "is_login_form = true if it asks for login credentials/codes.";

function parseVision(raw: string, source: string): VisionResult {
  const json = JSON.parse(raw.match(/\{[\s\S]*\}/)?.[0] ?? raw);
  return {
    brand: String(json.brand ?? "Unknown"),
    is_login_form: Boolean(json.is_login_form),
    confidence: Number(json.confidence ?? 0),
    source,
  };
}

async function callVision(
  client: OpenAI,
  model: string,
  screenshotBase64: string,
  source: string,
): Promise<VisionResult> {
  const res = await client.chat.completions.create({
    model,
    max_tokens: 200,
    response_format: { type: "json_object" },
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: VISION_PROMPT },
          { type: "image_url", image_url: { url: `data:image/png;base64,${screenshotBase64}` } },
        ],
      },
    ],
  });
  return parseVision(res.choices[0].message.content ?? "{}", source);
}

/**
 * Brand-impersonation classification. Primary = Nosana vLLM (Qwen2.5-VL);
 * falls back to ai&'s vision model (kimi) via a baseURL swap, then to a mock.
 */
export async function classifyBrand(screenshotBase64: string): Promise<VisionResult> {
  if (config.useMocks) return mockVision();

  const nosanaUp = config.nosana.baseUrl && !config.nosana.forceFallback;
  if (nosanaUp) {
    try {
      const client = new OpenAI({ baseURL: config.nosana.baseUrl, apiKey: config.nosana.apiKey });
      return await callVision(client, config.nosana.model, screenshotBase64, "nosana");
    } catch (err) {
      console.warn("[nosana] vision failed, falling back to ai&:", (err as Error).message);
    }
  }

  if (config.aiand.apiKey) {
    const client = new OpenAI({ baseURL: config.aiand.baseUrl, apiKey: config.aiand.apiKey });
    return await callVision(client, config.aiand.visionModel, screenshotBase64, "aiand-fallback");
  }

  return mockVision();
}
