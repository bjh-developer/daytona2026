#!/usr/bin/env tsx
/**
 * Capture the scam-detection training corpus.
 *
 * Reads scripts/fixtures/corpus/targets.json, spawns detonation/worker.mjs with
 * CAPTURE_TRANSCRIPT=1 per target, parses the __DETONATION_JSON__ output, and
 * appends one TrainingExample JSONL line per target to corpus.jsonl.
 *
 * Mock-kit targets set ACTIVE_FILL=1 (dummy values only — never against real sites).
 * Benign targets are observe-only (ACTIVE_FILL=0).
 *
 * Usage:
 *   npm run capture-corpus                                          # mock-kit + benign (targets.json)
 *   npm run capture-corpus -- --targets scripts/fixtures/corpus/targets-openphish.json
 *   npm run capture-corpus -- --out scripts/fixtures/corpus/corpus.jsonl
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { AgentTranscript, DetonationResult, ScamVerdict, TrainingExample, ScamType } from "../lib/types.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const WORKER_PATH = resolve(__dirname, "../detonation/worker.mjs");
const DEFAULT_TARGETS = resolve(__dirname, "fixtures/corpus/targets.json");
const DEFAULT_OUT = resolve(__dirname, "fixtures/corpus/corpus.jsonl");

interface Target {
  id: string;
  url: string;
  scam_type: ScamType;
  active_fill?: boolean;
  ground_truth: ScamVerdict;
}

function parseArgs(): { targets: string; out: string } {
  const args = process.argv.slice(2);
  let targets = DEFAULT_TARGETS;
  let out = DEFAULT_OUT;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--targets" && args[i + 1]) targets = resolve(args[++i]);
    else if (args[i] === "--out" && args[i + 1]) out = resolve(args[++i]);
  }
  return { targets, out };
}

function parseWorkerOutput(stdout: string): DetonationResult {
  const m = stdout.match(/__DETONATION_JSON__([\s\S]*?)__END__/);
  if (!m) throw new Error("worker produced no __DETONATION_JSON__ marker");
  return JSON.parse(m[1]) as DetonationResult;
}

/** Run the worker once against a target. Returns the DetonationResult. */
function runWorker(target: Target): Promise<DetonationResult> {
  return new Promise((resolveP, rejectP) => {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      TARGET_URL: target.url,
      CAPTURE_TRANSCRIPT: "1",
      ACTIVE_FILL: target.active_fill ? "1" : "0",
      // No proxies for corpus capture — dev machine has direct egress, and
      // localhost mock-kit targets can't be reached through a remote proxy anyway.
      PROXY_SERVER: "",
      SCANNER_PROXY_SERVER: "",
    };
    const proc = spawn("node", [WORKER_PATH], { env });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (d) => (stdout += d.toString()));
    proc.stderr.on("data", (d) => (stderr += d.toString()));
    proc.on("error", rejectP);
    proc.on("close", (code) => {
      if (code !== 0) {
        rejectP(new Error(`worker exited ${code} for ${target.url}\n${stderr}`));
        return;
      }
      try {
        resolveP(parseWorkerOutput(stdout));
      } catch (err) {
        rejectP(new Error(`failed to parse worker output for ${target.url}: ${(err as Error).message}\n${stdout.slice(-500)}`));
      }
    });
  });
}

/** Enrich the transcript context with brand/domain notes the classifier reasons over. */
function enrichContext(transcript: AgentTranscript, target: Target): AgentTranscript {
  const ctx = { ...transcript.context };
  // Heuristic brand inference from the scam_type label + domain.
  if (!ctx.claimed_brand) {
    if (target.scam_type === "telegram_login_clone") ctx.claimed_brand = "Telegram";
    else if (target.scam_type === "government_impersonation") ctx.claimed_brand = "Government / MSF";
    else if (target.scam_type === "meme_scam") ctx.claimed_brand = "None (bait-and-switch)";
    else ctx.claimed_brand = "Unknown";
  }
  if (!ctx.real_brand_domain) {
    if (ctx.claimed_brand?.toLowerCase().includes("telegram")) ctx.real_brand_domain = "web.telegram.org";
    else if (ctx.claimed_brand?.toLowerCase().includes("government")) ctx.real_brand_domain = "gov.sg";
  }
  if (!ctx.brand_note && ctx.claimed_brand?.toLowerCase().includes("telegram")) {
    ctx.brand_note = "Telegram never asks for login codes on a website.";
  }
  return { ...transcript, context: ctx };
}

async function main() {
  const { targets: targetsPath, out: outPath } = parseArgs();
  const targets: Target[] = JSON.parse(readFileSync(targetsPath, "utf8"));
  console.log(`[capture-corpus] ${targets.length} targets from ${targetsPath}`);

  mkdirSync(dirname(outPath), { recursive: true });
  // Start fresh each run — corpus is fully regenerated from targets.json.
  writeFileSync(outPath, "");

  let ok = 0;
  let failed = 0;
  const fh = (await import("node:fs/promises")).open(outPath, "w");

  for (const target of targets) {
    process.stdout.write(`[capture-corpus] ${target.id} ← ${target.url} ... `);
    try {
      const det = await runWorker(target);
      if (!det.agentTranscript) {
        throw new Error("worker returned no agentTranscript (CAPTURE_TRANSCRIPT=1 not honored?)");
      }
      const transcript = enrichContext(det.agentTranscript, target);
      const example: TrainingExample = {
        id: target.id,
        source_url: target.url,
        scam_type: target.scam_type,
        transcript,
        ground_truth: target.ground_truth,
        captured_at: new Date().toISOString(),
      };
      const line = JSON.stringify(example);
      (await fh).write(line + "\n");
      console.log(`OK (${transcript.steps.length} steps)`);
      ok++;
    } catch (err) {
      console.log(`FAIL: ${(err as Error).message.split("\n")[0]}`);
      failed++;
    }
  }
  (await fh).close();

  console.log(`\n[capture-corpus] done: ${ok} ok, ${failed} failed → ${outPath}`);
  if (existsSync(outPath)) {
    const lines = readFileSync(outPath, "utf8").trim().split("\n").filter(Boolean);
    const labels = new Set<string>();
    for (const l of lines) {
      try { labels.add((JSON.parse(l) as TrainingExample).scam_type); } catch { /* skip */ }
    }
    console.log(`[capture-corpus] ${lines.length} examples, labels: ${[...labels].join(", ")}`);
  }
  if (failed > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error("[capture-corpus] fatal:", err);
  process.exit(1);
});
