/**
 * Quick verification that the agent-transcript → scam-classification pipeline
 * works end-to-end with USE_MOCKS=true. Not a test suite — just a smoke check
 * that the wiring is correct. Run: USE_MOCKS=true npx tsx scripts/check-agent.ts
 */
import { runCheck } from "../lib/orchestrator.ts";

const result = await runCheck("Check this out http://localhost:8080/verify");

console.log("=== Verdict ===");
console.log("level:", result.verdict.level);
console.log("source:", result.verdict.source);
console.log("headline:", result.verdict.headline);

console.log("\n=== Agent transcript ===");
console.log("hasTranscript:", !!result.detonation.agentTranscript);
console.log("steps:", result.detonation.agentTranscript?.steps.length);

console.log("\n=== Scam classification (signal #6) ===");
console.log(JSON.stringify(result.scamClassification, null, 2));

const ok =
  result.verdict.level === "scam" &&
  !!result.detonation.agentTranscript &&
  !!result.scamClassification?.is_scam;

console.log("\n=== Result ===");
console.log(ok ? "✅ PASS — agent transcript + scam classification wired correctly" : "❌ FAIL");
process.exit(ok ? 0 : 1);
