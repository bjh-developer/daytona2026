# Nosana Fine-Tuning Knowledge Document

> Status: **Decision record** — captures the reasoning behind what to train Nosana on,
> what *not* to train it on, and the architecture that makes the agent transcript the
> primary detection signal, with the VLM demoted to optional context. Last updated: 2026-07-18.

---

## 1. What Nosana is in this project

Nosana is the **GPU host**, not the model. It runs vLLM behind an OpenAI-compatible
endpoint. Per §5.3 and §8 (the recommended architecture), Nosana's primary job is
**transcript-based scam analysis** — a text LLM reasons over the agent's behavioral
transcript and returns a scam verdict. The VLM (screenshot brand classification) is
demoted to optional context (signal #7) and is no longer the detection path.

"Fine-tuning Nosana" really means: fine-tune the model weights, then redeploy the tuned
model on the Nosana vLLM instance.

- **Primary inference client:** `lib/scam-classifier.ts` (`classifyScam()`) — text model
  (`config.nosana.textModel`, default `qwen2.5-7b-instruct`) over the agent transcript.
  Inference contract: `ScamVerdict` in `lib/types.ts`.
- **Optional context client:** `lib/nosana.ts` (`classifyBrand()`) — VLM
  (`config.nosana.model`, default `qwen2.5-vl`) over the screenshot. Inference contract:
  `VisionResult` in `lib/types.ts`. Signal #7 only — never the sole basis for a verdict.
- **Fallback chain (transcript path):** Nosana text → ai& text (`deepseek-v4-flash`) →
  `templateScamVerdict()` (deterministic, zero-AI floor).
- **Fallback chain (vision path):** Nosana VLM → ai& vision (`kimi-k2.6`) → `mockVision()`.

---

## 2. Current prompts and what is being set

### 2.0 Nosana transcript prompt (`lib/scam-classifier.ts`) — PRIMARY detection path

This is signal #6 (§5, §8) — the evasion-proof scam verdict from the agent's behavioral
transcript. Nosana's text model reasons over the transcript and returns a decision +
reasoning. This is what Nosana is primarily for.

System:
```
You are a scam analyst. Analyze the agent transcript of a page visit.
Every piece of evidence is something a scam kit MUST do to steal credentials.
Respond ONLY with JSON: {"is_scam":boolean,"brand_impersonated":string,"evidence":string[],"confidence":number,"explanation":string}.
```

User payload: the rendered transcript (observed state → actions → captured POSTs → context),
exactly as specified in §5.1.

**Input:** the `AgentTranscript` (text — a11y tree, actions, captured POST body, domain context).
**Output:** `ScamVerdict` `{is_scam, brand_impersonated, evidence[], confidence, explanation}`
parsed by `parseVerdict()`.
**What is being set:** `response_format: { type: "json_object" }`, `max_tokens: 400`,
model `config.nosana.textModel` (default `qwen2.5-7b-instruct`). Few-shot examples are
loaded from `scripts/fixtures/corpus/few-shot.jsonl` when present (§7 in-context learning).

### 2.1 Nosana vision prompt (`lib/nosana.ts`) — OPTIONAL context (signal #7)

> **Demoted.** Per §5.3 and §8, the VLM is context/corroboration only — never the sole
> basis for a verdict. A kit using the real logo is pixel-identical to the real site
> (§3), so this path cannot detect scams. Kept only to populate the "looks like X" line
> in the victim-facing reply when the transcript's `claimed_brand` context is absent.

```
You are a phishing brand classifier. Look at this webpage screenshot.
Respond ONLY with JSON: {"brand": string, "is_login_form": boolean, "confidence": number 0..1}.
brand = the company the page is impersonating (e.g. Telegram).
is_login_form = true if it asks for login credentials/codes.
```

**Input:** a single base64 PNG screenshot (the SG-residential pass — the "real trap").
**Output:** `{brand, is_login_form, confidence}` parsed by `parseVision()`.
**What is being set:** `response_format: { type: "json_object" }`, `max_tokens: 200`,
model `config.nosana.model` (default `qwen2.5-vl`).

### 2.2 ai& verdict prompt (`lib/aiand.ts`)

System:
```
You are a consumer scam explainer for Singaporeans. Given technical evidence from a
detonated phishing page, write a plain-English verdict a worried non-technical person
understands. Be direct, calm, specific. No jargon. Respond ONLY with JSON matching the schema.
```

User payload (JSON):
```json
{
  "impersonated_brand": "<from vision>",
  "is_login_form": true,
  "vision_confidence": 0.97,
  "fields_asked_for": ["Phone number", "Login code (OTP)", "2FA password"],
  "spread_signals": ["contacts", "api_id", "api_hash"],
  "ocr_evidence": ["Enter the code we sent to your phone"],
  "redirect_chain": ["..."],
  "schema": {
    "level": "scam|suspicious|unknown|clean",
    "headline": "short, with a leading emoji",
    "explanation": "2-3 sentences, plain English",
    "wormLine": "one sentence on how it spreads to contacts"
  }
}
```

**What is being set:** `response_format: { type: "json_object" }`, `max_tokens: 400`,
model `deepseek-ai/deepseek-v4-flash` (or free `qwen3.6-27b`).

### 2.3 Doubleword OCR prompt (`lib/doubleword.ts`)

```
Read ALL visible text in this screenshot (OCR), including the address bar and form labels.
Return JSON: {"fullText": string, "evidenceLines": string[]}.
evidenceLines = the 1-3 most incriminating phrases for a phishing page
(e.g. asking for a login code, OTP, or 2FA password).
```

**What is being set:** `response_format: { type: "json_object" }`, `max_tokens: 500`,
model `DeepSeek-OCR-2`.

### 2.4 Template fallback (`lib/verdict.ts`)

Deterministic, no LLM. Fires when ai& is unavailable. Uses:
- `humanFields(det)` — maps raw field names to labels via `FIELD_LABELS` table
- `asksForCode` — regex `/code|otp|2fa/i` on field labels
- `spreads` — `det.spreadSignals.length > 0`
- `vision.is_login_form && asksForCode || spreads` → `level: "scam"`

**This is the zero-AI floor.** It works on the mock kit with no sponsor keys set.

---

## 3. The fake-logo problem (why pixel-based VLM is limited)

A phishing kit that copies the **real** Telegram logo, colors, and layout produces a
screenshot that is **pixel-identical** to the real `web.telegram.org` login page. The VLM
outputs the same `{brand: "Telegram", is_login_form: true, confidence: 0.97}` for both.

**No amount of fine-tuning fixes this** — the two pages genuinely look the same. The logo
is not the scam signal.

### 3.1 The victim tension (why kits don't fake logos)

The kit has two audiences in conflict:
1. The **victim** — must believe it's Telegram (so the kit *wants* the real logo)
2. The **detector** — must NOT recognize it as Telegram

Any change that makes the page "not look like Telegram" to the VLM also makes it "not look
like Telegram" to the victim — defeating the kit's purpose. So kits copy the brand
faithfully, which is exactly what the VLM detects. **Logo-faking is self-defeating.**

### 3.2 The real evasion vectors (not about pictures)

| Evasion | How it works | Handled by |
|---|---|---|
| Cloaking to the detector | Serve decoy to headless/datacenter IP | Two-pass detonation + SG proxy |
| Bot fingerprinting | Detect Playwright UA / `navigator.webdriver` | `addInitScript` to hide webdriver flag |
| Adversarial pixel noise | Invisible perturbations flipping VLM output | Hard to deploy at scale; attacker needs your model |
| Timing swap | Show real page briefly, swap before screenshot | `networkidle` wait (partial) |

---

## 4. The evasion-proof signals (what the kit CANNOT fake)

These are the signals that actually catch the scam. None depend on pixels.

| Signal | Source | Why the kit can't fake it |
|---|---|---|
| **Domain** | URL after redirects | Can't host on `telegram.org` |
| **Harvest POST endpoint** | `page.on("request")` | Can't steal creds without a POST |
| **Captured POST payload** | `waitForRequest().postData()` | The literal stolen data |
| **Cloak detected** | Two-pass screenshot/title/body diff | Cloaking IS the scam signal |
| **`api_id` / `api_hash` in JS** | script-tag parse | Needed for the worm to spread |
| **Field combo** (phone + OTP + 2FA) | `page.$$eval("input")` | Removing fields breaks the harvest |
| **Redirect chain** | `page.on("response")` 3xx | Needed to reach the trap |
| **Domain age / SSL issuer** | WHOIS / cert lookup | Infrastructure-level |

A kit can copy the logo perfectly. It **cannot**:
- Harvest credentials without a POST endpoint
- Spread to contacts without `api_id`/`api_hash`
- Cloak without revealing itself to the two-pass detector
- Host on the legitimate domain

---

## 5. The agent-transcript approach (recommended)

Instead of feeding the VLM a screenshot, feed the model the **agent's behavioral output**:
the transcript of what it observed, clicked, filled, and captured. Behavior can't be faked
the way pixels can.

### 5.1 What to feed the model

```
=== AGENT TRANSCRIPT ===
Goal: Determine if this page is a credential-harvesting scam.

Step 0 — Observed:
  URL: https://telegram-verify-login.com/verify
  Title: "Telegram"
  Visible text: "Sign in to Telegram. Please confirm your number and the
    code we sent you to claim your GST Voucher."
  Interactive elements (a11y tree):
    - textbox "Mobile number"
    - textbox "Login code"
    - textbox "Cloud password (2FA)" [password]
    - button "Next"

Step 1 — Action: fill textbox "Mobile number" with "+6591234567"
Step 2 — Action: fill textbox "Login code" with "000000"
Step 3 — Action: fill textbox "Cloud password (2FA)" with "dummy2FA!"
Step 4 — Action: click button "Next"

Step 4 — Observed after action:
  URL: https://telegram-verify-login.com/verify (unchanged)
  Captured POST: POST https://telegram-verify-login.com/api/harvest
    body: {"phone":"+6591234567","otp":"000000","twofa":"dummy2FA!"}
  Page text changed to: "Verifying…"

=== CONTEXT ===
Domain: telegram-verify-login.com (registered 3 days ago)
Claimed brand (from page): Telegram
Real Telegram domain: web.telegram.org
Telegram never asks for login codes on a website.

=== TASK ===
Analyze this transcript. Is this a scam? Respond ONLY with JSON:
{
  "is_scam": boolean,
  "brand_impersonated": string,
  "evidence": string[],
  "confidence": number,
  "explanation": string
}
```

### 5.2 Why this is evasion-proof

Every piece of evidence is something the kit *must do* to be a scam:
- It must ask for the login code on a webpage (real Telegram doesn't)
- It must POST the credentials somewhere (real Telegram doesn't)
- It must be on a non-legit domain (can't host on telegram.org)
- It must capture phone + OTP + 2FA together (the harvest signature)

### 5.3 Implication: the VLM becomes optional

If the input is a text transcript, a **text LLM** handles it better and cheaper than a
vision model. The screenshot is kept **only for the victim-facing Telegram reply** (the
"see the trap" moment), not for detection.

```
Agent navigates the page (scripted or LLM-driven)
    ↓
Produces: transcript + captured POSTs + a11y tree + redirect chain
    ↓
    ├─→ Text LLM (ai& or Nosana-as-text) → scam verdict + explanation
    │     (evasion-proof: based on behavior, not pixels)
    │
    ├─→ Screenshot → bot reply only (visual proof for the victim)
    │
    └─→ Structured signals (domain, harvest, cloak) → deterministic fallback
```

---

## 6. What to fine-tune on

### 6.1 The decision

**Do NOT fine-tune the VLM to detect scams.** It can't — two pages with the real logo are
pixel-identical.

**Fine-tune (if at all) on one of these two targets:**

| Target | Input | Why |
|---|---|---|
| **Brand recognition** (optional) | Screenshots | Base model doesn't know SG brands (SingPass, PayNow, CDC) |
| **Scam analysis from transcript** (recommended) | Agent transcripts | Behavioral signals are unfakeable |

### 6.2 If fine-tuning on screenshots (brand recognition only)

**Train for:** "What brand does this screenshot impersonate, and is it asking for credentials?"

**Do NOT train for:** scam verdict, field semantics, harvest detection — those belong to
the structured signals and the agent transcript.

#### Dataset categories

| Category | Examples | Target count |
|---|---|---|
| **Positive — scam pages impersonating brands** | Telegram, SingPass, PayNow, CDC/GST, DBS/OCBC/UOB, Shopee/Lazada, WhatsApp, Facebook, Google, Microsoft 365 | 50–150 per brand, ~1000 total |
| **Negative — legitimate login pages** | `web.telegram.org`, `singpass.gov.sg`, `dbs.com.sg`, `accounts.google.com`, etc. | 20–50 per brand, ~500 total |
| **Decoys / benign pages** | 404s, parked domains, blog posts, gov info pages | ~300 |
| **Edge cases** | Multi-step flows, mobile vs desktop, partial forms, pop-up overlays, branded-but-non-login | ~200 |

**Total target: 1000–2000 labeled screenshots** for QLoRA to beat zero-shot.

#### Labeling schema (must match inference JSON exactly)

```json
{
  "brand": "Telegram",
  "is_login_form": true,
  "confidence": 0.97
}
```

The assistant response in training data must be the **raw JSON string** (no markdown, no
explanation) — exactly what `parseVision()` in `lib/nosana.ts` expects.

#### Training format (must match inference chat template)

```json
{
  "messages": [
    {
      "role": "user",
      "content": [
        { "type": "text", "text": "You are a phishing brand classifier..." },
        { "type": "image_url", "image_url": { "url": "data:image/png;base64,..." } }
      ]
    },
    {
      "role": "assistant",
      "content": "{\"brand\":\"Telegram\",\"is_login_form\":true,\"confidence\":0.97}"
    }
  ]
}
```

#### Data sources

| Source | What you get | Effort |
|---|---|---|
| Your own mock kit | Controlled, labeled, unlimited variants | Low |
| PhishTank | Community-reported phishing URLs | Medium — must screenshot each |
| URLhaus | Malware/phishing URLs with timestamps | Medium |
| OpenPhish | Curated phishing feed | Medium |
| ScamShield SG public reports | SG-specific scams (SingPass, PayNow) | High — manual |
| Wayback Machine | Historical phishing pages (now offline) | Medium |
| Synthetic generation | Vary mock kit (colors, layouts, brands) | Low — script it |

**Fastest hackathon path:** generate variants of your own mock kit programmatically
(different brand colors, field orders, copy), screenshot each, label. 500 examples in an
afternoon.

### 6.3 If fine-tuning on agent transcripts (recommended)

**Train for:** "Given this behavioral transcript, is it a scam and why?"

#### Training format

```json
{
  "messages": [
    {
      "role": "system",
      "content": "You are a scam analyst. Analyze the agent transcript. Respond ONLY with JSON."
    },
    {
      "role": "user",
      "content": "<agent transcript with observed state, actions, captured POSTs, context>"
    },
    {
      "role": "assistant",
      "content": "{\"is_scam\":true,\"brand_impersonated\":\"Telegram\",\"evidence\":[\"asks for login code on a webpage\",\"POSTs credentials to /api/harvest\",\"hosted on non-telegram domain\",\"captures phone+OTP+2FA together\"],\"confidence\":0.98,\"explanation\":\"This page...\"}"
    }
  ]
}
```

#### Dataset collection

Run the agent against:
- Your mock kit (unlimited variants) — label `is_scam: true`
- PhishTank/URLhaus URLs — detonate each, save transcript, label
- Legitimate login pages — agent fills, no harvest POST — label `is_scam: false`

**This dataset is far more valuable than screenshots** because the signals are behavioral
and unfakeable.

---

## 7. Eval metrics

Hold out 10% of data as eval set. Track:

| Metric | Target |
|---|---|
| Brand accuracy (top-1) — screenshot path | >90% |
| `is_login_form` F1 — screenshot path | >0.95 |
| False positive rate on legitimate logins | <5% |
| Decoy recognition accuracy | >95% |
| Scam verdict accuracy — transcript path | >95% |
| False negative rate on known scams | <5% |

**If the base (zero-shot) model already hits these, skip the fine-tune** — add few-shot
examples to the prompt instead (minutes, no training, no GPU).

---

## 8. Recommended architecture (final)

```
1. Domain check        → "claims to be Telegram, hosted on scam-domain.com"  ← STRONGEST
2. Harvest POST         → "exfiltrates phone+OTP+2FA"                         ← STRONG
3. Cloak detection      → "serves decoy to scanners"                          ← STRONG
4. Spread signals       → "contains api_id/api_hash worm code"                ← STRONG
5. Field structure      → "asks for OTP on a webpage (Telegram never does)"   ← STRONG
6. Agent transcript → LLM → scam verdict + explanation                        ← STRONG (evasion-proof)
7. VLM brand            → "looks like Telegram"                                ← CONTEXT only
8. OCR text             → "says 'enter the code we sent you'"                 ← CORROBORATION
```

- Signals 1–5 are **deterministic and evasion-proof** — work with zero AI
- Signal 6 is the **recommended fine-tune target** (transcript, not pixels)
- Signals 7–8 are **context/corroboration only** — never the sole basis for a verdict

---

## 9. Summary (one paragraph)

Nosana is the GPU host; fine-tuning targets the model weights, not Nosana itself. Per §5.3
and §8, Nosana's **primary** job is transcript-based scam analysis: a text LLM
(`config.nosana.textModel`) reasons over the agent's behavioral transcript and returns a
`ScamVerdict` (decision + reasoning). The VLM screenshot path (`classifyBrand()`) is
demoted to optional context (signal #7) — a kit using the real logo is pixel-identical to
the real site, so no vision model separates them. Do NOT fine-tune the VLM to detect
scams. Fine-tune (if at all) on **agent transcripts** (§6.3, recommended) where the
signals are behavioral and unfakeable (harvest POST, field combo, non-legit domain,
cloak), or on **brand recognition** from screenshots (§6.2, optional, for SG brands the
base model doesn't know). The screenshot stays for the victim-facing Telegram reply only.
The scam verdict comes from the transcript LLM plus the deterministic signals (domain,
harvest, cloak, spread) — none of which depend on pixels.
