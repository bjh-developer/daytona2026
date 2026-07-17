# detonate.sg

Forward a suspected scam message to a **Telegram bot**; it *detonates* the link in an isolated
[Daytona](https://daytona.io) sandbox from a Singapore residential IP (via [Oxylabs](https://oxylabs.io)),
screenshots the real phishing page that scanners never see, and replies in-chat with proof:
what it impersonates ([Nosana](https://nosana.io) vision), the literal text it asks for
([Doubleword](https://doubleword.ai) OCR), and a plain-English verdict ([ai&](https://aiand.com)).

**It doesn't score a link — it shows you the trap.** See [docs/](docs/) for the full plan.

## Quick start (works today, no sponsor keys needed)

```bash
npm install
cp .env.example .env          # USE_MOCKS=true by default
npm run check                 # end-to-end pipeline with mock data → prints a verdict
```

To run the bot, add a token from [@BotFather](https://t.me/BotFather) to `.env` (`TELEGRAM_BOT_TOKEN=…`), then:

```bash
npm run bot                   # long-polling; forward it a message with a link
```

## Going live (swap mocks for real sponsors)

1. Fill sponsor keys in `.env`, set `USE_MOCKS=false`.
2. `npm run smoke` — runs the first-30-min GATE checks (Daytona egress, Oxylabs SG, ai&, Nosana, Doubleword).
3. Deploy the mock kit (`npm run mock-kit`, then push to Vercel) and set `MOCK_KIT_URL`.

Everything degrades gracefully: if a sponsor is down, the pipeline falls back (Nosana→ai& vision,
ai&→template verdict, Daytona→local Playwright) so the demo still works.

## Layout

| Path | What | Owner lane |
|------|------|-----------|
| `bot/index.ts` | grammy Telegram bot — progress edits, media group, verdict, CTAs | B |
| `lib/orchestrator.ts` | extract → detonate → vision+OCR → verdict | B |
| `lib/daytona.ts` + `detonation/worker.mjs` | 2-pass isolated detonation (decoy vs SG) | A |
| `lib/oxylabs.ts` | SG residential proxy builder | A |
| `lib/nosana.ts` / `lib/aiand.ts` / `lib/doubleword.ts` | vision / verdict / OCR | C |
| `lib/types.ts` | **shared contract — change here, not ad hoc** | all |
| `mock-kit/server.ts` | Telegram-login clone + geo-cloaking + harvest sink | B |
| `scripts/check.ts` / `scripts/smoke.ts` | e2e flow / sponsor gate | all |

**Demo safety:** we only ever detonate our own mock kit; no real credentials are entered; nothing is exfiltrated.
