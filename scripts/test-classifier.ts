/**
 * Test 5: Run the scam classifier on a real agent transcript.
 * Verifies the full pipeline: transcript → classifyScam → ScamVerdict.
 *
 * Usage: npx tsx scripts/test-classifier.ts
 */
import { classifyScam } from "../lib/scam-classifier.ts";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

async function main() {
  // Load the latest mock-kit transcript (the LLM agent run)
  const files = readdirSync("logs/transcripts")
    .filter((f) => f.endsWith(".json"))
    .sort()
    .reverse();
  const latest = files.find((f) => f.includes("clickmeforreal"));
  if (!latest) {
    console.log("❌ No mock-kit transcript found");
    process.exit(1);
  }
  const d = JSON.parse(readFileSync(resolve("logs/transcripts", latest), "utf8"));
  const transcript = d.result.agentTranscript;
  if (!transcript) {
    console.log("❌ No agentTranscript in", latest);
    process.exit(1);
  }
  console.log("Loaded transcript:", latest);
  console.log("Steps:", transcript.steps.length);
  console.log("Domain:", transcript.context.domain);
  console.log();

  const verdict = await classifyScam(transcript, d.result);
  console.log("=== Scam verdict ===");
  console.log(JSON.stringify(verdict, null, 2));

  const ok = verdict.is_scam === true && verdict.confidence > 0.5;
  console.log();
  console.log(ok ? "✅ PASS — classifier correctly identified the scam" : "❌ FAIL");
  process.exit(ok ? 0 : 1);
}

main().catch((err) => {
  console.error("❌ Error:", err.message);
  process.exit(1);
});
