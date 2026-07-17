import { config } from "./config.ts";
import { extractUrl, provisionalVerdict } from "./extract.ts";
import { detonate } from "./daytona.ts";
import { classifyBrand } from "./nosana.ts";
import { ocrScreenshot } from "./doubleword.ts";
import { generateVerdict } from "./aiand.ts";
import type { CheckResult, ProgressFn } from "./types.ts";

export class NoUrlError extends Error {}

/**
 * Full pipeline for a forwarded message: extract → detonate (2-pass, isolated) →
 * vision + OCR (parallel) → verdict. Emits progress so the bot can edit its status.
 * Active fill (Level 2) is enabled ONLY when the target is our own mock kit.
 */
export async function runCheck(text: string, onProgress: ProgressFn = () => {}): Promise<CheckResult> {
  await onProgress({ step: "extracting", label: "Reading the message…" });
  const url = extractUrl(text);
  if (!url) throw new NoUrlError("No link found in the message to detonate.");

  const provisional = provisionalVerdict(text);
  const isOwnMockKit = url.startsWith(config.mockKitUrl);

  await onProgress({ step: "creating-sandbox", label: "Spinning up an isolated sandbox…" });
  await onProgress({ step: "detonating-scanner", label: "Visiting as a scanner would (datacenter IP)…" });
  await onProgress({ step: "detonating-sg", label: "Detonating from a Singapore home connection…" });
  const detonation = await detonate(url, isOwnMockKit);

  await onProgress({ step: "vision", label: "Identifying what it impersonates…" });
  const [vision, ocr] = await Promise.all([
    classifyBrand(detonation.screenshotBase64),
    ocrScreenshot(detonation.screenshotBase64).catch(() => undefined),
  ]);

  await onProgress({ step: "verdict", label: "Writing the verdict…" });
  const verdict = await generateVerdict(detonation, vision, ocr);

  await onProgress({ step: "done", label: "Done." });
  return { url, detonation, vision, ocr, verdict, provisional };
}
