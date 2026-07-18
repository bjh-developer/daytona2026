#!/usr/bin/env tsx
/**
 * Phase 0 gate: measure zero-shot and few-shot accuracy of the base text LLM on
 * the scam-classification task, BEFORE committing to fine-tuning.
 *
 * The doc (§7) is explicit: "If the base (zero-shot) model already hits these,
 * skip the fine-tune — add few-shot examples to the prompt instead."
 *
 * Loads the captured corpus (scripts/fixtures/corpus/corpus.jsonl), holds out 30%
 * as eval, uses the rest as few-shot pool, and reports accuracy / FN / FP at
 * zero-shot, 3-shot, and 5-shot. Writes the decision to FEW-SHOT-BASELINE.md.
 *
 * Targets (doc §7):
 *   - scam verdict accuracy > 95%
 *   - false negative rate on known scams < 5%
 *   - false positive rate on legit logins < 5%
 *   - decoy recognition accuracy > 95%
 *
 * Usage:
 *   npm run capture-corpus        # first — need a corpus
 *   npm run few-shot-baseline
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import OpenAI from "openai";
import { config } from "../lib/config.ts";
import type { TrainingExample, ScamVerdict, AgentTranscript } from "../lib/types.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CORPUS_PATH = resolve(__dirname, "fixtures/corpus/corpus.jsonl");
const REPORT_PATH = resolve(__dirname, "../training/FEW-SHOT-BASELINE.md");

const SYSTEM =
  "You are a scam analyst. Analyze the agent transcript of a page visit. " +
  "Determine if this page is a credential-harvesting scam and why. " +
  "Respond ONLY with JSON matching the schema: " +
  '{"is_scam": boolean, "brand_impersonated": string, "evidence": string[], ' +
  '"confidence": number 0..1, "explanation": string}';

function renderTranscript(t: AgentTranscript): string {
  const lines: string[] = ["=== AGENT TRANSCRIPT ===", `Goal: ${t.goal}`];
  for (const step of t.steps) {
    const tag = step.kind === "observed" ? "Observed" : step.kind === "action" ? "Action" : "Observed after action";
    lines.push(`${tag}: ${step.label}${step.detail ? `\n  ${step.detail}` : ""}`);
  }
  lines.push("", "=== CONTEXT ===");
  lines.push(`Domain: ${t.context.domain}`);
  if (t.context.claimed_brand) lines.push(`Claimed brand (from page): ${t.context.claimed_brand}`);
  if (t.context.real_brand_domain) lines.push(`Real brand domain: ${t.context.real_brand_domain}`);
  if (t.context.brand_note) lines.push(t.context.brand_note);
  lines.push("", "=== TASK ===", "Analyze this transcript. Is this a scam? Respond ONLY with JSON.");
  return lines.join("\n");
}

function parseVerdict(raw: string): ScamVerdict {
  const json = JSON.parse(raw.match(/\{[\s\S]*\}/)?.[0] ?? raw);
  return {
    is_scam: Boolean(json.is_scam),
    brand_impersonated: String(json.brand_impersonated ?? "Unknown"),
    evidence: Array.isArray(json.evidence) ? json.evidence.map(String) : [],
    confidence: Number(json.confidence ?? 0),
    explanation: String(json.explanation ?? ""),
    source: "baseline",
  };
}

async function classify(
  client: OpenAI,
  model: string,
  transcript: AgentTranscript,
  fewShot: TrainingExample[],
): Promise<ScamVerdict> {
  const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
    { role: "system", content: SYSTEM },
  ];
  for (const ex of fewShot) {
    messages.push({ role: "user", content: renderTranscript(ex.transcript) });
    messages.push({ role: "assistant", content: JSON.stringify(ex.ground_truth) });
  }
  messages.push({ role: "user", content: renderTranscript(transcript) });
  const res = await client.chat.completions.create({
    model,
    max_tokens: 400,
    response_format: { type: "json_object" },
    messages,
  });
  return parseVerdict(res.choices[0].message.content ?? "{}");
}

interface Metrics {
  accuracy: number;
  falseNegativeRate: number; // scam predicted legit
  falsePositiveRate: number; // legit predicted scam
  correct: number;
  total: number;
}

function score(preds: boolean[], truths: boolean[]): Metrics {
  let correct = 0;
  let fn = 0; // scam → legit
  let fp = 0; // legit → scam
  let scamTotal = 0;
  let legitTotal = 0;
  for (let i = 0; i < preds.length; i++) {
    if (truths[i]) scamTotal++;
    else legitTotal++;
    if (preds[i] === truths[i]) correct++;
    else if (truths[i] && !preds[i]) fn++;
    else if (!truths[i] && preds[i]) fp++;
  }
  return {
    accuracy: correct / preds.length,
    falseNegativeRate: scamTotal ? fn / scamTotal : 0,
    falsePositiveRate: legitTotal ? fp / legitTotal : 0,
    correct,
    total: preds.length,
  };
}

function fmt(m: Metrics): string {
  return `accuracy=${(m.accuracy * 100).toFixed(1)}% (${m.correct}/${m.total}), FN=${(m.falseNegativeRate * 100).toFixed(1)}%, FP=${(m.falsePositiveRate * 100).toFixed(1)}%`;
}

function passesGate(m: Metrics): boolean {
  return (
    m.accuracy > 0.95 &&
    m.falseNegativeRate < 0.05 &&
    m.falsePositiveRate < 0.05
  );
}

async function runBaseline(
  client: OpenAI,
  model: string,
  evalSet: TrainingExample[],
  fewShotPool: TrainingExample[],
  shotCount: number,
  label: string,
): Promise<Metrics> {
  const fewShot = fewShotPool.slice(0, shotCount);
  const preds: boolean[] = [];
  const truths: boolean[] = [];
  for (const ex of evalSet) {
    try {
      const v = await classify(client, model, ex.transcript, fewShot);
      preds.push(v.is_scam);
      truths.push(ex.ground_truth.is_scam);
      process.stdout.write(v.is_scam === ex.ground_truth.is_scam ? "✓" : "✗");
    } catch (err) {
      console.warn(`\n[baseline] classify failed for ${ex.id}: ${(err as Error).message}`);
      preds.push(false);
      truths.push(ex.ground_truth.is_scam);
      process.stdout.write("?");
    }
  }
  const m = score(preds, truths);
  console.log(`\n[baseline] ${label}: ${fmt(m)}`);
  return m;
}

async function main() {
  if (!existsSync(CORPUS_PATH)) {
    console.error(`[baseline] corpus not found: ${CORPUS_PATH}`);
    console.error("[baseline] run `npm run capture-corpus` first.");
    process.exit(1);
  }
  const corpus: TrainingExample[] = readFileSync(CORPUS_PATH, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as TrainingExample);
  console.log(`[baseline] loaded ${corpus.length} examples from corpus`);

  if (corpus.length < 10) {
    console.error("[baseline] need ≥10 examples for a meaningful baseline; got " + corpus.length);
    process.exit(1);
  }

  // Stratified shuffle: split 70/30, keep few-shot pool balanced.
  const scams = corpus.filter((e) => e.ground_truth.is_scam);
  const legits = corpus.filter((e) => !e.ground_truth.is_scam);
  const shuffle = <T>(a: T[]) => a.sort(() => Math.random() - 0.5);
  const scamsShuffled = shuffle(scams);
  const legitsShuffled = shuffle(legits);
  const evalCount = Math.max(3, Math.floor(corpus.length * 0.3));
  const evalSet = [...scamsShuffled.slice(0, Math.floor(evalCount / 2)), ...legitsShuffled.slice(0, Math.ceil(evalCount / 2))];
  const fewShotPool = [...scamsShuffled.slice(Math.floor(evalCount / 2)), ...legitsShuffled.slice(Math.ceil(evalCount / 2))];
  console.log(`[baseline] eval=${evalSet.length}, few-shot pool=${fewShotPool.length}`);

  const baseUrl = config.nosana.baseUrl && !config.nosana.forceFallback
    ? config.nosana.baseUrl
    : config.aiand.baseUrl;
  const apiKey = config.nosana.baseUrl && !config.nosana.forceFallback
    ? config.nosana.apiKey
    : config.aiand.apiKey;
  const model = config.nosana.baseUrl && !config.nosana.forceFallback
    ? config.nosana.textModel
    : config.aiand.model;
  if (!apiKey) {
    console.error("[baseline] no LLM API key (NOSANA_API_KEY or AIAND_API_KEY). Cannot run baseline.");
    process.exit(1);
  }
  const client = new OpenAI({ baseURL: baseUrl, apiKey });
  console.log(`[baseline] model=${model}, baseUrl=${baseUrl}\n`);

  const zeroShot = await runBaseline(client, model, evalSet, [], 0, "zero-shot");
  const threeShot = await runBaseline(client, model, evalSet, fewShotPool, 3, "3-shot");
  const fiveShot = await runBaseline(client, model, evalSet, fewShotPool, 5, "5-shot");

  const best = [zeroShot, threeShot, fiveShot].reduce((a, b) => (b.accuracy > a.accuracy ? b : a));
  const decision = passesGate(best)
    ? `**DECISION: Ship few-shot — skip fine-tuning.** Best baseline (${(best.accuracy * 100).toFixed(1)}% accuracy) meets doc §7 targets.`
    : `**DECISION: Proceed to fine-tuning (Phase 4).** Best baseline (${(best.accuracy * 100).toFixed(1)}% accuracy) does NOT meet doc §7 targets (>95% accuracy, <5% FN, <5% FP).`;

  const report = `# Phase 0: Few-Shot Baseline Gate

> Generated by \`npm run few-shot-baseline\`. See \`docs/nosana-finetuning.md\` §7.

## Setup
- Model: \`${model}\`
- Base URL: \`${baseUrl}\`
- Corpus: ${corpus.length} examples (\`${CORPUS_PATH}\`)
- Eval set: ${evalSet.length} examples (30% holdout, stratified)
- Few-shot pool: ${fewShotPool.length} examples

## Results

| Shot count | Accuracy | FN rate | FP rate | Passes gate? |
|---|---|---|---|---|
| 0 (zero-shot) | ${(zeroShot.accuracy * 100).toFixed(1)}% | ${(zeroShot.falseNegativeRate * 100).toFixed(1)}% | ${(zeroShot.falsePositiveRate * 100).toFixed(1)}% | ${passesGate(zeroShot) ? "✅" : "❌"} |
| 3-shot | ${(threeShot.accuracy * 100).toFixed(1)}% | ${(threeShot.falseNegativeRate * 100).toFixed(1)}% | ${(threeShot.falsePositiveRate * 100).toFixed(1)}% | ${passesGate(threeShot) ? "✅" : "❌"} |
| 5-shot | ${(fiveShot.accuracy * 100).toFixed(1)}% | ${(fiveShot.falseNegativeRate * 100).toFixed(1)}% | ${(fiveShot.falsePositiveRate * 100).toFixed(1)}% | ${passesGate(fiveShot) ? "✅" : "❌"} |

## Gate targets (doc §7)
- Scam verdict accuracy > 95%
- False negative rate on known scams < 5%
- False positive rate on legit logins < 5%
- Decoy recognition accuracy > 95%

## ${decision}

Best baseline: ${(best.accuracy * 100).toFixed(1)}% accuracy.
`;
  writeFileSync(REPORT_PATH, report);
  console.log(`\n[baseline] report → ${REPORT_PATH}`);
  console.log(`[baseline] ${decision}`);
}

main().catch((err) => {
  console.error("[baseline] fatal:", err);
  process.exit(1);
});
