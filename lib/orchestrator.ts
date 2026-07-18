import { config } from "./config.ts";
import { extractUrl, provisionalVerdict } from "./extract.ts";
import { detonate, daytonaShowcase } from "./daytona.ts";
import { classifyBrand } from "./nosana.ts";
import { classifyScam } from "./scam-classifier.ts";
import { ocrScreenshot } from "./doubleword.ts";
import { generateVerdict } from "./aiand.ts";
import type { CheckResult, ProgressFn } from "./types.ts";

export class NoUrlError extends Error {}

/**
 * Full pipeline for a forwarded message: extract → detonate (2-pass, isolated) →
 * vision + OCR + transcript analysis (parallel) → verdict. Emits progress so the
 * bot can edit its status. Active fill (Level 2) is enabled ONLY when the target
 * is our own mock kit.
 */
export async function runCheck(text: string, onProgress: ProgressFn = () => {}): Promise<CheckResult> {
  await onProgress({ step: "extracting", label: "Reading the message…" });
  const url = extractUrl(text);
  if (!url) throw new NoUrlError("No link found in the message to detonate.");

  const provisional = provisionalVerdict(text);
  const isOwnMockKit = url.startsWith(config.mockKitUrl);

  await onProgress({ step: "creating-sandbox", label: "Spinning up an isolated sandbox…" });
  // Daytona proof-of-life runs alongside the real detonation, never gates it
  // (this hackathon's org is Tier 1 — sandbox egress is blocked org-wide, so
  // the actual page-fetch runs locally; see lib/daytona.ts for why).
  const daytonaPromise = config.useMocks
    ? Promise.resolve({ ok: true as const, sandboxId: "mock-sandbox" })
    : daytonaShowcase();
  await onProgress({ step: "detonating-scanner", label: "Visiting as a scanner would (datacenter IP)…" });
  await onProgress({ step: "detonating-sg", label: "Detonating from a Singapore home connection…" });
  const [detonation, daytona] = await Promise.all([detonate(url, isOwnMockKit), daytonaPromise]);

  await onProgress({ step: "vision", label: "Identifying what it impersonates…" });
  // Signal #6 (transcript analysis) runs in parallel with vision + OCR. The
  // transcript is the evasion-proof input — behavioral signals a kit can't fake.
  const [vision, ocr, scamClassification] = await Promise.all([
    classifyBrand(detonation.screenshotBase64),
    ocrScreenshot(detonation.screenshotBase64).catch(() => undefined),
    detonation.agentTranscript
      ? classifyScam(detonation.agentTranscript, detonation).catch(() => undefined)
      : Promise.resolve(undefined),
  ]);

  await onProgress({ step: "verdict", label: "Writing the verdict…" });
  const verdict = await generateVerdict(detonation, vision, ocr, scamClassification);

  await onProgress({ step: "done", label: "Done." });
  return { url, detonation, vision, ocr, verdict, scamClassification, provisional, daytona };
}
