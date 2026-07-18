# Scam-Detection Training Corpus

Agent-transcript corpus for fine-tuning a text LLM (e.g. Qwen2.5-1.5B LoRA) on
Nosana's GPU network to classify credential-harvesting scams from **behavioral
transcripts** — not screenshots. See `docs/nosana-finetuning.md` §5 for the
rationale: behavioral signals (harvest POST, field combo, non-legit domain)
are evasion-proof, while pixels are not (a kit copying the real Telegram logo
is pixel-identical to the real site).

> **Scope of this directory:** produce the fine-tuning **data** only. The
> training job (Dockerfile, `train.py`, Nosana job definition, `eval.py`) is
> built by someone else. The handoff artifacts are `corpus.jsonl` (raw) and
> `training.jsonl` / `eval.jsonl` (rendered chat-template format).

## Pipeline

### Real phishing data (OpenPhish — no auth, no registration)

```bash
# 1. Fetch real phishing URLs from the OpenPhish community feed.
npm run fetch-openphish
# → targets-openphish.json  (50+ real phishing URLs, observe-only)

# 2. Capture transcripts from those URLs (observe-only, no form submission).
npm run capture-corpus -- --targets scripts/fixtures/corpus/targets-openphish.json
# → corpus.jsonl  (appends real-phishing examples)
```

OpenPhish (`https://openphish.com/feed.txt`) is a free, continuously-updated plain-text
feed of community-reported phishing URLs — no API key, no registration. The fetcher
filters for credential-harvesting brands (Telegram, Facebook, Instagram, Microsoft,
Google, Apple, PayPal, Netflix, crypto wallets, SG government) relevant to detonate.sg.

⚠️ **AGENTS.md compliance:** all OpenPhish targets use `active_fill=false` (observe-
only). The capture worker navigates the page and records what it sees (page structure,
form fields, visible text, domain) but does **not** fill forms or submit anything. This
respects "Do not access live criminal infrastructure" (observe page structure only) and
"Active form submission is permitted only against the mock kit" (no submission occurs).

### Mock-kit + benign data (controlled)

```bash
# 1. Capture raw transcripts from mock-kit + benign sites.
npm run capture-corpus
# → corpus.jsonl  (TrainingExample records)

# 2. Render to the chat-template training format (doc §6.3).
npm run render-training
# → training.jsonl  (all examples, no split)
# OR with a stratified train/eval split:
npm run render-training -- --split 0.2
# → training.jsonl + eval.jsonl  (80/20, stratified by scam_type, seeded)
```

### Combined pipeline (recommended for the full corpus)

```bash
npm run fetch-openphish -- --limit 100           # real phishing positives
npm run capture-corpus                            # mock-kit + benign (targets.json)
npm run capture-corpus -- --targets scripts/fixtures/corpus/targets-openphish.json --out scripts/fixtures/corpus/corpus-openphish.jsonl
cat scripts/fixtures/corpus/corpus.jsonl scripts/fixtures/corpus/corpus-openphish.jsonl > scripts/fixtures/corpus/corpus-all.jsonl
npm run render-training -- --split 0.2           # → training.jsonl + eval.jsonl
```

## Raw schema — `corpus.jsonl`

Each line is a `TrainingExample` (see `lib/types.ts`):

```jsonc
{
  "id": "gov-001",
  "source_url": "http://localhost:5174/?force=real",
  "scam_type": "government_impersonation",   // metadata for offline analysis
  "transcript": {                            // AgentTranscript — the model input
    "goal": "Determine if this page is a credential-harvesting scam.",
    "steps": [
      { "kind": "observed", "label": "URL: ...", "detail": "Title: ...\nVisible text: ..." },
      { "kind": "action", "label": "fill textbox 'Mobile number' with '91234567'" },
      { "kind": "action", "label": "click button 'Next'" },
      { "kind": "observed_after", "label": "Captured POST: POST .../api/harvest", "detail": "body: {...}" }
    ],
    "context": { "domain": "localhost", "claimed_brand": "...", "real_brand_domain": "...", "brand_note": "..." }
  },
  "ground_truth": {                          // ScamVerdict — the model output (doc §5.1)
    "is_scam": true,
    "brand_impersonated": "Government / MSF",
    "evidence": ["asks for NRIC and mobile on a payout page", "POSTs to /api/harvest", "..."],
    "confidence": 0.95,
    "explanation": "This page mimics a government payout site to harvest NRIC and phone.",
    "source": "ground-truth"
  },
  "captured_at": "2026-07-18T12:00:00.000Z"
}
```

## Rendered schema — `training.jsonl` / `eval.jsonl`

Each line is a chat-template example (doc §6.3). The assistant response is the
**raw JSON string** of the ground-truth `ScamVerdict` (with the `source` metadata
field stripped) — no markdown fences, no explanation — exactly what the inference
parser in `lib/scam-classifier.ts` expects to receive:

```json
{
  "messages": [
    { "role": "system", "content": "You are a scam analyst. Analyze the agent transcript. Respond ONLY with JSON." },
    { "role": "user", "content": "<rendered transcript>" },
    { "role": "assistant", "content": "{\"is_scam\":true,\"brand_impersonated\":\"...\",\"evidence\":[...],\"confidence\":0.95,\"explanation\":\"...\"}" }
  ]
}
```

## Labels

| `scam_type` | Meaning | Source |
|---|---|---|
| `government_impersonation` | GST voucher / MSF / payout lure harvesting NRIC + phone | mock-kit `/` |
| `telegram_login_clone` | Fake Telegram sign-in harvesting phone + OTP + 2FA | mock-kit `/verify` |
| `meme_scam` | Bait-and-switch "you got scammed" aftermath page | mock-kit `/meme` |
| `legitimate` | Real benign login / info pages | telegram.org, gov.sg, etc. |

## Capture

`npm run capture-corpus` reads `targets.json`, spawns `detonation/worker.mjs` with
`CAPTURE_TRANSCRIPT=1` per target, and writes one JSONL line per example. Mock-kit
targets also set `ACTIVE_FILL=1` (dummy values only — never against real sites).

## Phase 0 gate (optional, for the fine-tuner's reference)

`npm run few-shot-baseline` measures zero-shot / few-shot accuracy on a held-out
micro-set. If few-shot hits the doc §7 targets (>95% accuracy, <5% FN, <5% FP),
fine-tuning may not be needed. See `training/FEW-SHOT-BASELINE.md` (generated by
the script).
