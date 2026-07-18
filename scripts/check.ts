// End-to-end pipeline run without Telegram. Works today in USE_MOCKS mode,
// and against real sponsors once keys are set. Usage: npm run check
import { runCheck } from "../lib/orchestrator.ts";
import { config } from "../lib/config.ts";

const SAMPLE =
  "🎉 GST Voucher 2026! Eligible Singaporeans can claim up to $850 cash. " +
  "Verify your identity via Telegram to receive your payout: " +
  `${config.mockKitUrl}/verify`;

const result = await runCheck(SAMPLE, (e) => console.log(`  … ${e.label}`));

console.log("\n=== VERDICT ===");
console.log(result.verdict.headline);
console.log(result.verdict.explanation);
console.log("Harvests:", result.verdict.harvestedFields.join(", "));
console.log(
  `Vision: ${result.vision.brand} login=${result.vision.is_login_form} ` +
    `${Math.round(result.vision.confidence * 100)}% (${result.vision.source})`,
);
if (result.ocr) console.log("OCR evidence:", result.ocr.evidenceLines.join(" | "));
console.log("Cloak detected:", result.detonation.cloakDetected);
if (result.scamClassification) {
  console.log(
    `Scam classification: is_scam=${result.scamClassification.is_scam} ` +
      `${result.scamClassification.brand_impersonated} ` +
      `${Math.round(result.scamClassification.confidence * 100)}% (${result.scamClassification.source})`,
  );
  for (const e of result.scamClassification.evidence) console.log(`  • ${e}`);
}
console.log("Verdict source:", result.verdict.source);
console.log(
  `Screenshots: real=${result.detonation.screenshotBase64.length}b64 ` +
    `decoy=${result.detonation.decoyScreenshotBase64?.length ?? 0}b64`,
);
console.log(
  "Daytona:",
  result.daytona.ok ? `sandbox ${result.daytona.sandboxId} created ✅` : `unavailable (${result.daytona.reason})`,
);
