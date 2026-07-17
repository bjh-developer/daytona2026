# detonate.sg Agent Guide

## Read First

Before changing code, read:

1. `docs/plan.md` — current product, architecture, ownership, and build order
2. `lib/types.ts` — shared integration contracts
3. `.env.example` — supported configuration and service fallbacks

`docs/plan.md` is the authoritative plan. `docs/mvp-architecture.md` is an older draft and must not override it.

## Product Scope

detonate.sg is a TypeScript Telegram bot that receives a forwarded suspicious message, detonates its URL in an isolated environment, and replies in Telegram with evidence.

- The Telegram bot is the product interface; do not introduce a separate web-app frontend.
- The on-stage target is the team-controlled mock phishing kit.
- Do not access live criminal infrastructure.
- Never enter or submit real credentials.
- Active form submission is permitted only against the mock kit and only with dummy values.

## Shared Contracts

Use the types in `lib/types.ts` for integration between lanes. Do not create competing local versions of:

- `DetonationResult`
- `VisionResult`
- `OcrResult`
- `Verdict`
- `CheckResult`
- `ProgressEvent`

Coordinate changes to shared types with the team before editing them.

## Ownership

- **Person A — detonation:** `lib/daytona.ts`, `lib/oxylabs.ts`, `detonation/`
- **Person B — mock kit and bot:** `mock-kit/`, `bot/`, `lib/orchestrator.ts`, `lib/extract.ts`, `lib/verdict.ts`
- **Person C — AI services:** `lib/nosana.ts`, `lib/aiand.ts`, `lib/doubleword.ts`
- **Shared:** `lib/types.ts`, configuration, smoke tests, and integration points

Stay within your assigned lane where possible. Coordinate before changing another person's files or shared contracts.

## Repo Layout

```
bot/                 # grammy Telegram bot (long-polling) + message/media rendering
lib/                 # extract, orchestrator, daytona, oxylabs, nosana, aiand, doubleword, verdict, types
detonation/          # worker + Dockerfile baked into the Daytona snapshot
mock-kit/            # Telegram-login clone + cloaking, deployed publicly
docs/                # plan, research, architecture
scripts/             # smoke / check helpers
```

## Service Responsibilities

- **Daytona:** isolated execution of the submitted mock-kit URL
- **Oxylabs:** Singapore residential proxy used to reveal geo-cloaked content
- **Nosana:** screenshot brand and login-form classification
- **ai&:** plain-English consumer verdict
- **Doubleword:** OCR evidence from the screenshot; polish-tier work after core services

Preserve the configured fallbacks:

- Nosana vision can fall back to the configured ai& vision model.
- ai& verdict generation can fall back to `templateVerdict()`.
- Doubleword failure must not break the core result.

## Development Rules

- Keep secrets in `.env`; never commit API keys, bot tokens, proxy credentials, or captured credentials.
- Start with `USE_MOCKS=true` when sponsor services are not configured.
- Use `MOCK_KIT_URL` as the detonation target.
- Keep sponsor integrations behind the existing modules and environment variables.
- Prefer the smallest change that advances the five-hour demo build.
- Do not expand scope beyond `docs/plan.md` without team agreement.
- Do not commit or push unless explicitly asked.

## Common Commands

```bash
npm install
cp .env.example .env   # USE_MOCKS=true by default
npm run typecheck
npm run check          # end-to-end with mocks when available
npm run smoke          # sponsor gate checks when keys are set
npm run bot            # long-polling Telegram bot
npm run mock-kit       # local mock phishing kit
```

## Verification

Before handing off a change:

1. Run `npm run typecheck`.
2. Run the relevant smoke or end-to-end command when its required credentials are available.
3. Confirm mock and fallback behavior still works without sponsor credentials.
4. Report changed files, verification performed, and any unresolved blocker.

The demo must remain usable when a nonessential sponsor call is unavailable.
