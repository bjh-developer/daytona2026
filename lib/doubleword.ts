import OpenAI from "openai";
import { config } from "./config.ts";
import { mockOcr } from "./mocks.ts";
import type { OcrResult } from "./types.ts";

const OCR_PROMPT =
  "Read ALL visible text in this screenshot (OCR), including the address bar and form labels. " +
  "Return JSON: {\"fullText\": string, \"evidenceLines\": string[]}. " +
  "evidenceLines = the 1-3 most incriminating phrases for a phishing page " +
  "(e.g. asking for a login code, OTP, or 2FA password).";

/** OCR the trap screenshot via Doubleword DeepSeek-OCR-2. Distinct from the
 * Nosana brand-classifier: this reads the literal text as evidence. Polish tier. */
export async function ocrScreenshot(screenshotBase64: string): Promise<OcrResult> {
  if (config.useMocks || !config.doubleword.apiKey) return mockOcr();

  try {
    const client = new OpenAI({ baseURL: config.doubleword.baseUrl, apiKey: config.doubleword.apiKey });
    const res = await client.chat.completions.create({
      model: config.doubleword.model,
      max_tokens: 500,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: OCR_PROMPT },
            { type: "image_url", image_url: { url: `data:image/png;base64,${screenshotBase64}` } },
          ],
        },
      ],
    });
    const json = JSON.parse(res.choices[0].message.content ?? "{}");
    return {
      fullText: String(json.fullText ?? ""),
      evidenceLines: Array.isArray(json.evidenceLines) ? json.evidenceLines.map(String) : [],
      source: "doubleword",
    };
  } catch (err) {
    console.warn("[doubleword] OCR failed, using mock:", (err as Error).message);
    return mockOcr();
  }
}
