#!/usr/bin/env tsx
/**
 * Render the captured corpus into the final fine-tuning training format.
 *
 * Reads scripts/fixtures/corpus/corpus.jsonl (raw TrainingExample records) and
 * writes scripts/fixtures/corpus/training.jsonl in the chat-template format the
 * fine-tuner expects (docs/nosana-finetuning.md §6.3).
 *
 * Each output line:
 *   { "messages": [ {system}, {user}, {assistant} ] }
 *
 * The assistant response is the RAW JSON STRING of the ground-truth ScamVerdict —
 * no markdown fences, no explanation — exactly what the inference parser in
 * lib/scam-classifier.ts expects to receive.
 *
 * This is the deliverable handed to whoever builds the training job.
 *
 * Usage:
 *   npm run capture-corpus        # first — produces corpus.jsonl
 *   npm run render-training        # this script — produces training.jsonl
 *   npm run render-training -- --split 0.2   # hold out 20% as eval.jsonl
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import type { AgentTranscript, ScamVerdict, TrainingExample } from "../lib/types.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CORPUS_PATH = resolve(__dirname, "fixtures/corpus/corpus.jsonl");
const TRAIN_OUT = resolve(__dirname, "fixtures/corpus/training.jsonl");
const EVAL_OUT = resolve(__dirname, "fixtures/corpus/eval.jsonl");

const SYSTEM_PROMPT =
  "You are a scam analyst. Analyze the agent transcript of a page visit. " +
  "Every piece of evidence is something a scam kit MUST do to steal credentials. " +
  "Respond ONLY with JSON: " +
  '{"is_scam":boolean,"brand_impersonated":string,"evidence":string[],"confidence":number,"explanation":string}.';

interface RenderedExample {
  messages: {
    role: "system" | "user" | "assistant";
    content: string;
  }[];
}

/** Render an AgentTranscript to the text block the model reasons over (doc §5.1). */
function renderTranscript(t: AgentTranscript): string {
  const lines: string[] = ["=== AGENT TRANSCRIPT ===", `Goal: ${t.goal}`];
  t.steps.forEach((s, i) => {
    const tag =
      s.kind === "action" ? "Action" : s.kind === "observed" ? "Observed" : "Observed after action";
    lines.push(`Step ${i} — ${tag}: ${s.label}`);
    if (s.detail) lines.push(`  ${s.detail}`);
  });
  lines.push("", "=== CONTEXT ===");
  if (t.context.domain) lines.push(`Domain: ${t.context.domain}`);
  if (t.context.claimed_brand) lines.push(`Claimed brand (from page): ${t.context.claimed_brand}`);
  if (t.context.real_brand_domain)
    lines.push(`Real ${t.context.claimed_brand || "brand"} domain: ${t.context.real_brand_domain}`);
  if (t.context.brand_note) lines.push(t.context.brand_note);
  lines.push(
    "",
    "=== TASK ===",
    "Analyze this transcript. Is this a scam? Respond ONLY with JSON: " +
      '{"is_scam":boolean,"brand_impersonated":string,"evidence":string[],"confidence":number,"explanation":string}.',
  );
  return lines.join("\n");
}

/** Strip the `source` field from the ground-truth — it's metadata, not a model output. */
function modelOutput(v: ScamVerdict): ScamVerdict {
  const { source: _source, ...rest } = v;
  return rest as ScamVerdict;
}

function renderExample(ex: TrainingExample): RenderedExample {
  return {
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: renderTranscript(ex.transcript) },
      // Assistant response = raw JSON string, no markdown, no explanation.
      { role: "assistant", content: JSON.stringify(modelOutput(ex.ground_truth)) },
    ],
  };
}

function parseArgs(): { split: number; seed: number } {
  const args = process.argv.slice(2);
  let split = 0;
  let seed = 42;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--split" && args[i + 1]) split = Number(args[++i]);
    else if (args[i] === "--seed" && args[i + 1]) seed = Number(args[++i]);
  }
  return { split, seed };
}

/** Deterministic shuffle (seeded) so train/eval splits are reproducible. */
function shuffle<T>(arr: T[], seed: number): T[] {
  const a = [...arr];
  let s = seed;
  for (let i = a.length - 1; i > 0; i--) {
    s = (s * 9301 + 49297) % 233280;
    const j = Math.floor((s / 233280) * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** Stratified split — keeps class balance in both train and eval sets. */
function stratifiedSplit(examples: TrainingExample[], evalFraction: number, seed: number) {
  const byLabel: Record<string, TrainingExample[]> = {};
  for (const ex of examples) {
    (byLabel[ex.scam_type] ??= []).push(ex);
  }
  const train: TrainingExample[] = [];
  const evalSet: TrainingExample[] = [];
  for (const label of Object.keys(byLabel).sort()) {
    const shuffled = shuffle(byLabel[label], seed + label.length);
    const n = Math.max(1, Math.round(shuffled.length * evalFraction));
    evalSet.push(...shuffled.slice(0, n));
    train.push(...shuffled.slice(n));
  }
  return { train: shuffle(train, seed), evalSet: shuffle(evalSet, seed + 1) };
}

function writeJsonl(path: string, examples: RenderedExample[]): void {
  mkdirSync(dirname(path), { recursive: true });
  const lines = examples.map((e) => JSON.stringify(e));
  writeFileSync(path, lines.join("\n") + (lines.length ? "\n" : ""));
}

function labelStats(examples: TrainingExample[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const ex of examples) counts[ex.scam_type] = (counts[ex.scam_type] ?? 0) + 1;
  return counts;
}

function main() {
  if (!existsSync(CORPUS_PATH)) {
    console.error(`[render-training] corpus not found: ${CORPUS_PATH}`);
    console.error("[render-training] run `npm run capture-corpus` first.");
    process.exit(1);
  }
  const corpus: TrainingExample[] = readFileSync(CORPUS_PATH, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as TrainingExample);
  console.log(`[render-training] loaded ${corpus.length} examples from ${CORPUS_PATH}`);
  console.log(`[render-training] label distribution:`, labelStats(corpus));

  const { split: evalFraction, seed } = parseArgs();

  if (evalFraction > 0) {
    const { train, evalSet } = stratifiedSplit(corpus, evalFraction, seed);
    console.log(
      `[render-training] stratified split (eval=${(evalFraction * 100).toFixed(0)}%, seed=${seed}): ` +
        `train=${train.length}, eval=${evalSet.length}`,
    );
    writeJsonl(TRAIN_OUT, train.map(renderExample));
    writeJsonl(EVAL_OUT, evalSet.map(renderExample));
    console.log(`[render-training] train → ${TRAIN_OUT} (${train.length} examples)`);
    console.log(`[render-training] eval  → ${EVAL_OUT} (${evalSet.length} examples)`);
    console.log(`[render-training] train labels:`, labelStats(train));
    console.log(`[render-training] eval labels:`, labelStats(evalSet));
  } else {
    writeJsonl(TRAIN_OUT, corpus.map(renderExample));
    console.log(`[render-training] → ${TRAIN_OUT} (${corpus.length} examples, no split)`);
  }

  // Sanity: print one rendered example so the handoff is self-documenting.
  if (corpus.length) {
    const sample = renderExample(corpus[0]);
    console.log("\n[render-training] sample (first example, truncated):\n");
    console.log(JSON.stringify(sample, null, 2).slice(0, 1200) + "…");
  }
}

main();
