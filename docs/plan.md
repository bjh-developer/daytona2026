# detonate.sg — 5-Hour, 3-Person Hackathon Build Plan

## Context

Hackathon: **3 builders, ~5 hours, nothing tested yet.** Product = a **Telegram bot** you forward a suspected scam message to; it doesn't score the link — it **detonates** it and replies in-chat with proof. A Daytona sandbox drives headless Chromium through an Oxylabs Singapore residential proxy to beat the phishing kit's geo-cloak, screenshots the fake Telegram login, a Nosana-hosted vision model tags the brand impersonation, and ai& writes the plain-English verdict.

**Frontend = the Telegram bot itself (no separate website/app).** The scam arrives *in Telegram* as a forward from a hijacked friend; forcing the victim to copy the link into a website is the friction that kills adoption. Instead they **forward the message to `@detonate_bot`** and get the verdict back in the same chat. This also makes the demo stronger — you screen-share the exact surface where the scam lives.

Five sponsors, each a distinct load-bearing job: **Daytona** = safe isolated execution of an untrusted link; **Oxylabs** = SG proxy beats the cloak; **Nosana** = brand-from-pixels (must ship); **ai&** = human explanation; **Doubleword** = OCR the trap (DeepSeek-OCR-2 reads the literal phishing text off the screenshot). Three inference sponsors, three different jobs on the same screenshot: Nosana *classifies* the brand, Doubleword *reads* the text, ai& *synthesizes* the verdict.

### Why this beats ScamShield (the core differentiator — vantage point, not gimmick)
ScamShield / urlscan / VirusTotal scan from **datacenter IPs**, which cloaking kits detect and serve a decoy/403 to — so they get a structural **false "clean."** detonate.sg enters via an **Oxylabs SG residential IP** (the victim's vantage) and sees the **real** page, then returns *evidence* (screenshot + phone→OTP→2FA field fingerprint + redirect chain + OCR text) instead of a score. Even pure Level 1 (read-only) this is content ScamShield cannot reach.
**Prove it live:** the mock kit must **cloak** — serve a boring decoy to datacenter/non-SG IPs, the real fake-Telegram page only to the SG residential exit. Demo runs the URL twice: without proxy = "what ScamShield sees" (decoy, clean) vs with SG proxy = "what the victim sees" (the trap). This side-by-side is the answer to "how is this different from ScamShield," on stage.

### How "detonation" actually works (no real credentials, ever)
- **Level 1 — passive (the product behavior):** Playwright loads the link via the SG proxy and *reads* it — screenshot, DOM (fields phone→OTP→2FA + names/placeholders), JS (AJAX harvest endpoint, `api_id`/`api_hash`, contact-spread stub), redirect chain. Proves intent without typing anything. Production stays read-only here.
- **Level 2 — active, MOCK KIT ONLY:** because the mock is our own page, Playwright types **dummy** values (`+65 9123 4567`, OTP `000000`) and clicks submit; we `page.waitForRequest` to **capture the harvest POST payload** — the "watch it steal the code" moment — and the spread stub logs "would message N contacts." Never done against a real link. This is why the mock kit must actually *perform* a fake AJAX harvest + spread (Person B).

**Product flow (the bot):** user forwards the lure → bot extracts the URL from the forwarded message text/entities → instant provisional reply from text heuristics → bot **edits that message** to stream progress ("Detonating from a Singapore home connection… capturing… analyzing…") → final reply: a **media group** of the two screenshots (decoy vs real trap) + a formatted verdict (SCAM header, harvested fields, worm line) + **inline-keyboard CTAs** ("Report to ScamShield 1799", "How to enable Telegram 2FA").

Locked decisions (from user): **Telegram-bot frontend** (forward-to-bot, zero app-switching); **mock kit only** on stage (team-built Telegram-login clone; never live criminal infra or a real account); **TypeScript**, one repo; **Nosana vision is must-ship**.

The real risk with a 5h clock is not code — it's **unverified sponsor access**. Two things can sink the demo: Daytona egress being blocked (Tier 1/2), and Nosana GPU not warming in time. Both are neutralized by front-loading smoke tests + starting the Nosana download at minute 0, with pre-decided fallbacks that keep every sponsor in the narrative.

Existing assets: `docs/mvp-architecture.md` (draft), and `index.html` on `origin/feature/fake-phishing-site` (a GST **gov claim** decoy — must be reshaped into a **Telegram-login** clone for the screenshot to read as impersonation).

---

## The GATE — first 30 minutes (all 3 people, in parallel). Do NOT build features before this passes.

Each smoke test is ~5–10 min and de-risks one sponsor. If a test fails, take the fallback (below) immediately — don't wait.

1. **Daytona egress (TOP RISK — Person A).** Create a sandbox, `curl` a **non-whitelisted** host. Package registries + AI endpoints are whitelisted on *every* tier, so `npm install` succeeding proves nothing.
   ```ts
   const s = await daytona.create();
   const r = await s.process.executeCommand('curl -s -o /dev/null -w "%{http_code}" --max-time 8 https://api.ipify.org || echo BLOCKED');
   // "200" = egress OK (Tier 3/4). "BLOCKED"/"000" = Tier 1/2 → FALLBACK.
   await s.delete();
   ```
   Also confirm the org tier in the Daytona dashboard.
2. **Oxylabs SG exit (Person A).** `curl -x pr.oxylabs.io:7777 -U "customer-USER-cc-SG:PASS" https://ip.oxylabs.io/location` → expect `"country_code":"SG"`.
3. **Nosana deploy STARTED (Person C, minute 0).** deploy.nosana.com → claim $70 hackathon credits → vLLM template → image `vllm/vllm-openai:latest` (NOT the docs' stale `v0.5.4`), model `Qwen/Qwen2.5-VL-7B-Instruct` (ungated), 24GB GPU (RTX 4090), raise max-duration. Watch logs for "Application startup complete" (~15–40 min; weight download is the bottleneck — that's why it starts first).
4. **ai& chat (Person C).** `openai` SDK, `baseURL: https://api.aiand.com/v1`, key `sk-...`, one completion with free `qwen/qwen3.6-27b`. Do a **$1 top-up early** (promotes Tier 0 → Tier 1 rate limits).
   - **Doubleword (Person C, same client):** `baseURL: https://api.doubleword.ai/v1`, get key at `docs.doubleword.ai/inference-api/creating-an-api-key`, one OCR call on a test screenshot with `DeepSeek-OCR-2`. Lower priority than gate items 1–5 — it's a polish-tier add, not gate-critical.
5. **Mock kit reachable (Person B).** Telegram-login clone deployed to a public URL (Vercel) that the sandbox can reach.
6. **Telegram bot alive (Person B).** BotFather → `/newbot` → token (2 min). Minimal `grammy` bot on **long-polling** (`bot.start()` — no public webhook needed, runs from a laptop) that echoes forwarded messages. Confirm it receives `message.text` + URL entities from a forward.

**Fallbacks (pre-decided, keep sponsors load-bearing):**
- **Daytona egress blocked:** run Playwright on a permitted host (local Node / small server); keep Daytona load-bearing by running the **isolated untrusted-DOM/JS parsing** step inside the sandbox. Or add the Oxylabs gateway IP to `networkAllowList` (IPv4 CIDR, max 10) if on Tier 3/4. Escalate to sponsor reps for a tier bump.
- **Nosana cold at demo time:** flip vision `baseURL` to **ai& `moonshotai/kimi-k2.6`** (vision-capable, same OpenAI wire format) or a cached result for the demo URL. Nosana stays primary in the pitch; fallback is a 2-line env swap.
- **ai& flaky:** hardcoded verdict template keyed off the extracted fields.

---

## Ownership lanes (3 people)

### Person A — Detonation engine (owns the top risk)
- Daytona + Oxylabs smoke tests (gate items 1–2).
- Bake a **Playwright snapshot** once so runs don't reinstall Chromium:
  ```dockerfile
  FROM mcr.microsoft.com/playwright:v1.50.0-jammy
  RUN npx playwright install --with-deps chromium
  ```
  `daytona snapshot create det-playwright --dockerfile ./Dockerfile --cpu 2 --memory 4 --disk 10` (build `--platform=linux/amd64`, pin the tag — no `latest`).
- Detonation worker (runs inside sandbox): **two passes** for the cloak contrast — (a) **no proxy** (datacenter IP) → captures the decoy = "what ScamShield sees"; (b) **with** `proxy: { server:"http://pr.oxylabs.io:7777", username:"customer-USER-cc-SG-sessid-<id>", password }` → captures the real trap. Each pass: `goto(mockUrl)` → full-page screenshot + DOM extract. Emit a **fixed JSON artifact** (`/tmp/out.json`) with both, read back via `sandbox.fs.downloadFile`:
  ```json
  { "decoyScreenshotBase64":"…", "screenshotBase64":"…", "finalUrl":"…", "redirectChain":[…],
    "fields":[{"name":"phone","type":"tel","placeholder":"+65…"}, …],
    "ajaxEndpoints":["/api/harvest"],
    "spreadSignals":["contacts","api_id","api_hash"] }
  ```
- **Deliverables:** `lib/daytona.ts` (create/run/read/teardown, try/finally `delete()`), `lib/oxylabs.ts` (proxy string builder), detonation worker script, the JSON contract above.

### Person B — Mock kit + Telegram bot + orchestrator (unblocks everyone first)
- **First 45 min (critical, unblocks A):** reshape `index.html` → **Telegram-login clone**: phone → OTP → 2FA-password sequence, Telegram logo/branding, an AJAX `POST` harvest stub, a visible client-side **"propagate to contacts"** JS stub, a clear `DEMO-ONLY` banner. Deploy to Vercel → public URL. This is the sandbox's only target.
  - **Cloaking (the differentiator, ~20 min):** server-side, gate on requester geo — if `x-vercel-ip-country !== 'SG'` serve a **boring decoy** ("Page not found" / generic landing); if `SG`, serve the real fake-Telegram page. Datacenter run (no proxy, non-SG IP) → decoy; Oxylabs SG exit → real trap. Makes the "beats ScamShield" contrast honest and live.
- **Telegram bot** (`grammy`, long-polling): on forwarded/text message → `lib/extract.ts` pulls the URL → send instant provisional reply → `ctx.api.editMessageText` to stream progress → call orchestrator → reply with results.
  - Result rendering: `sendMediaGroup([decoy, real])` with captions ("What a scanner sees" / "What you'd see from Singapore"), then a formatted HTML message (SCAM header, harvested fields, worm line, vision %, OCR text), then an **inline keyboard** for the CTAs. Photos sent as Buffers from the base64 screenshots.
- Orchestrator (plain async function the bot calls; no HTTP UI): URL extract → Daytona detonation → **parallel** Nosana vision + ai& verdict (+ Doubleword OCR) → merge → return payload.
- **Deliverables:** `mock-kit/` (deployed, cloaking), `bot/index.ts` (grammy handler + message formatting), `lib/orchestrator.ts`, `lib/extract.ts`, `lib/verdict.ts` (merge + template fallback).

### Person C — AI lane (Nosana must-ship + ai&)
- **Minute 0:** kick off Nosana deploy (gate item 3) so weights download while you do everything else.
- `lib/nosana.ts` — OpenAI-compatible vision client → `{brand, is_login_form, confidence}` using vLLM `response_format:{type:"json_object"}`. Downscale screenshot ≤1280px before base64 (avoids 24GB OOM / token blowup).
- `lib/aiand.ts` — consumer verdict + explanation from (fields + vision JSON); **template fallback** hardcoded. Cheap model default (`deepseek-v4-flash` / free `qwen3.6-27b`).
- Wire the **vision fallback**: env flag flips `baseURL` from Nosana → ai& `moonshotai/kimi-k2.6`.
- `lib/doubleword.ts` — OCR the screenshot via `DeepSeek-OCR-2` (`baseURL: https://api.doubleword.ai/v1`); returns the literal on-page text (field labels, fake URL, "enter the code" line) as evidence strings for the card. Reuses the Nosana screenshot plumbing. **Build after the core 4 work** (polish tier).
- **Deliverables:** `lib/nosana.ts`, `lib/aiand.ts`, `lib/doubleword.ts`, verdict-merge helper shared with Person B, cached result for the demo URL.

---

## Repo shape
```
bot/ index.ts             # grammy Telegram bot (long-polling) + message/media rendering
lib/ extract.ts orchestrator.ts daytona.ts oxylabs.ts nosana.ts aiand.ts doubleword.ts verdict.ts
detonation/ worker.ts Dockerfile   # baked into Daytona snapshot
mock-kit/                 # Telegram-login clone + cloaking (evolve index.html), deployed to Vercel
docs/                     # existing research + architecture
```
Bot runs as a plain Node/TS process (`tsx bot/index.ts`) on a laptop via long-polling — no Next.js, no public webhook to host in 5h.

## Build order (demo still works if time runs out — stop anywhere)
1. **Gate passes** (30 min) — sponsors verified or fallbacks taken.
2. **Mock kit live + cloaking** (Person B) + **Daytona/Oxylabs detonation returns JSON** against it (Person A). — *core is now real; the SG-vs-datacenter contrast works.*
3. **Bot shell**: forward → provisional reply → progress edits → send both screenshots (decoy vs real) + field list. — *the visceral moment + the "beats ScamShield" proof exist without any AI.*
4. **ai& verdict copy** on the card.
5. **Nosana vision badge** "Telegram impersonation 98%" — pitch climax.
6. **Doubleword OCR evidence** — literal harvested text on the card (5th sponsor, polish tier).
7. **Polish**: provisional text verdict, CTAs, pre-warm/cache the demo URL, smooth the streaming.

## Bot UX direction (the "UI" is Telegram message design)
- **Native, not a web app.** Design lives in message formatting: HTML/MarkdownV2 for bold verdict + monospace evidence, a **media group** for the two screenshots, an **inline keyboard** for CTAs. Use `sendChatAction('upload_photo')` while working so it feels alive.
- **The money moment (in-chat):** one message edited live through the steps ("Detonating from a Singapore home connection… capturing… analyzing…"), then the **two screenshots arrive as a media group** — caption 1 "🌐 What a scanner (ScamShield) sees" = decoy, caption 2 "🇸🇬 What you'd see from Singapore" = the real Telegram-login trap. Then the verdict message: **🚨 SCAM**, harvested fields (phone/OTP/2FA), vision "Telegram impersonation 98%", OCR'd "enter your code" line, worm one-liner. This side-by-side in the victim's own app is the winning 20 seconds and the ScamShield differentiator in one shot.
- **Optional stretch:** a one-page branded landing (name + QR/deep-link `t.me/detonate_bot`) purely for the pitch slide — not the product surface. Skip unless time.
- Pre-warm/cache the demo URL so the whole exchange is fast and reliable on venue Wi-Fi.

## Verification (end-to-end, before the pitch)
- Gate: egress `200`, Oxylabs returns SG, ai& completion returns text, Nosana endpoint returns valid JSON on a test screenshot, mock URL loads from the sandbox, bot receives a forwarded message's URL.
- Full flow (in Telegram): **forward** the canned GST lure to the bot → provisional "suspicious" reply <~1s → detonation via Daytona+Oxylabs against mock kit → bot sends decoy vs real screenshots + harvested fields + worm line → vision % + LLM explanation (or ai&-vision fallback) + OCR text → CTAs render as buttons → **no credentials ever submitted**, framed as controlled replica.
- Run the 2-minute demo twice with the presenter's phone/Telegram Desktop screen-shared; pre-warm all calls for the demo URL; keep the long-polling bot process running on a laptop (not venue-hosted).

## Top risks → mitigations
| Risk | Mitigation |
|------|-----------|
| Daytona Tier 1/2 blocks egress | Playwright on permitted host; Daytona runs isolated DOM/JS parse (stays load-bearing). Test minute 1. |
| Nosana GPU cold at demo | Started minute 0; fallback to ai& `kimi-k2.6` vision via baseURL swap; cache demo-URL result. |
| ai& venue-WiFi flake | Hardcoded template verdict keyed to fields. |
| Mock kit reads as gov form, not Telegram | Rebuild to Telegram-login clone early (Person B, first 45 min). |
| Time runs out | Build order above degrades gracefully; screenshot+fields moment works with zero AI. |
| 5 sponsors overload 3 people | Doubleword OCR is polish-tier (step 6), added only after core 4 work; OpenAI-compatible = ~30-min add reusing screenshot plumbing. Skippable without breaking the demo. |
| Forwarded lure hides URL in a button/image | MVP handles URLs in message **text/entities** only (the common case); use a known-good canned forward for the demo. Inline-button/image-URL extraction = post-MVP. |
| Bot webhook hosting eats time | Use **long-polling** on a laptop — no public webhook/HTTPS to stand up in 5h. |
