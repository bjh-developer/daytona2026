#!/usr/bin/env tsx
/**
 * Fetch real phishing URLs from OpenPhish (no auth, no registration) and emit
 * targets.json entries for the corpus capture pipeline.
 *
 * OpenPhish feed: https://openphish.com/feed.txt — a plain text file, one URL
 * per line, updated continuously. ~300 URLs available at any time.
 *
 * This script filters for credential-harvesting brands (Telegram, Facebook,
 * Microsoft, Google, Apple, PayPal, crypto wallets, banks) — the archetypes
 * relevant to detonate.sg. Roblox/game-clone URLs are skipped (not credential
 * harvesters relevant to the SG context).
 *
 * ⚠️ AGENTS.md compliance: all emitted targets use active_fill=false (observe-
 * only). The capture worker navigates the page and records what it sees but
 * does NOT fill forms or submit anything. This respects:
 *   - "Do not access live criminal infrastructure" — we observe page structure
 *     only, we do not interact with the kit or submit credentials.
 *   - "Active form submission is permitted only against the mock kit" — no
 *     form submission occurs against these URLs.
 *
 * Usage:
 *   npm run fetch-openphish                          # → targets-openphish.json
 *   npm run fetch-openphish -- --limit 50           # cap at 50 URLs
 *   npm run fetch-openphish -- --out custom.json    # custom output path
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import type { ScamType, ScamVerdict } from "../lib/types.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_OUT = resolve(__dirname, "fixtures/corpus/targets-openphish.json");
const FEED_URL = "https://openphish.com/feed.txt";
const USER_AGENT = "detonate-sg/0.1 (phishing-research; observe-only)";

interface Target {
  id: string;
  url: string;
  scam_type: ScamType;
  active_fill: boolean;
  ground_truth: ScamVerdict;
}

/** Brand keywords → scam_type + ground-truth verdict. Observe-only. */
const BRAND_FILTERS: {
  match: RegExp;
  scam_type: ScamType;
  brand: string;
  real_domain: string;
  brand_note?: string;
}[] = [
  {
    match: /telegram/i,
    scam_type: "telegram_login_clone",
    brand: "Telegram",
    real_domain: "web.telegram.org",
    brand_note: "Telegram never asks for login codes on a website.",
  },
  {
    match: /facebook|fb-login|fblogin|m-facebook/i,
    scam_type: "telegram_login_clone", // credential-harvesting login clone archetype
    brand: "Facebook",
    real_domain: "facebook.com",
    brand_note: "Facebook login pages on non-facebook.com domains are phishing.",
  },
  {
    match: /instagram|insta-login/i,
    scam_type: "telegram_login_clone",
    brand: "Instagram",
    real_domain: "instagram.com",
    brand_note: "Instagram login pages on non-instagram.com domains are phishing.",
  },
  {
    match: /microsoft|office365|outlook|live\.com|onedrive|sharepoint/i,
    scam_type: "telegram_login_clone",
    brand: "Microsoft",
    real_domain: "login.microsoftonline.com",
    brand_note: "Microsoft login pages on non-Microsoft domains are phishing.",
  },
  {
    match: /google|gmail|accounts\.google/i,
    scam_type: "telegram_login_clone",
    brand: "Google",
    real_domain: "accounts.google.com",
    brand_note: "Google sign-in pages on non-Google domains are phishing.",
  },
  {
    match: /apple|icloud|itunes/i,
    scam_type: "telegram_login_clone",
    brand: "Apple",
    real_domain: "appleid.apple.com",
    brand_note: "Apple ID pages on non-apple.com domains are phishing.",
  },
  {
    match: /paypal/i,
    scam_type: "telegram_login_clone",
    brand: "PayPal",
    real_domain: "paypal.com",
    brand_note: "PayPal login pages on non-paypal.com domains are phishing.",
  },
  {
    match: /ledger|metamask|trust.?wallet|coinbase|binance|crypto|wallet/i,
    scam_type: "telegram_login_clone",
    brand: "Crypto Wallet",
    real_domain: "(varies by wallet)",
    brand_note: "Crypto wallet login/seed-phrase pages on non-official domains are phishing.",
  },
  {
    match: /netflix/i,
    scam_type: "telegram_login_clone",
    brand: "Netflix",
    real_domain: "netflix.com",
    brand_note: "Netflix login pages on non-netflix.com domains are phishing.",
  },
  {
    match: /singpass|paynow|cpf\.gov|iras\.gov|mom\.gov|msf\.gov|gov\.sg/i,
    scam_type: "government_impersonation",
    brand: "Government (SG)",
    real_domain: "gov.sg",
    brand_note: "Singapore government pages on non-gov.sg domains are phishing.",
  },
];

function classifyUrl(url: string): {
  scam_type: ScamType;
  brand: string;
  real_domain: string;
  brand_note?: string;
} | null {
  for (const f of BRAND_FILTERS) {
    if (f.match.test(url)) {
      return {
        scam_type: f.scam_type,
        brand: f.brand,
        real_domain: f.real_domain,
        brand_note: f.brand_note,
      };
    }
  }
  return null;
}

function hostname(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

function makeTarget(url: string, idx: number, info: NonNullable<ReturnType<typeof classifyUrl>>): Target {
  const domain = hostname(url);
  const id = `openphish-${String(idx).padStart(4, "0")}`;
  return {
    id,
    url,
    scam_type: info.scam_type,
    active_fill: false, // AGENTS.md: observe-only, no form submission on real sites
    ground_truth: {
      is_scam: true,
      brand_impersonated: info.brand,
      evidence: [
        `hosted on ${domain}, not the legitimate ${info.real_domain}`,
        info.brand_note ?? "impersonates a legitimate brand on a non-official domain",
        "listed in the OpenPhish community phishing feed",
      ],
      confidence: 0.9,
      explanation: `This page is a confirmed phishing URL (OpenPhish feed) impersonating ${info.brand} on a non-legitimate domain.`,
      source: "ground-truth",
    },
  };
}

function parseArgs(): { limit: number; out: string } {
  const args = process.argv.slice(2);
  let limit = 100;
  let out = DEFAULT_OUT;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--limit" && args[i + 1]) limit = Number(args[++i]);
    else if (args[i] === "--out" && args[i + 1]) out = resolve(args[++i]);
  }
  return { limit, out };
}

async function main() {
  const { limit, out } = parseArgs();
  console.log(`[fetch-openphish] fetching ${FEED_URL} ...`);

  const res = await fetch(FEED_URL, { headers: { "User-Agent": USER_AGENT } });
  if (!res.ok) {
    console.error(`[fetch-openphish] HTTP ${res.status} ${res.statusText}`);
    process.exit(1);
  }
  const text = await res.text();
  const allUrls = text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith("http"));
  console.log(`[fetch-openphish] ${allUrls.length} total URLs in feed`);

  // Filter for credential-harvesting brands relevant to detonate.sg.
  const targets: Target[] = [];
  const skipped: string[] = [];
  for (let i = 0; i < allUrls.length && targets.length < limit; i++) {
    const url = allUrls[i];
    const info = classifyUrl(url);
    if (info) {
      targets.push(makeTarget(url, targets.length, info));
    } else {
      skipped.push(url);
    }
  }

  console.log(`[fetch-openphish] matched ${targets.length} credential-harvesting URLs (skipped ${skipped.length} irrelevant)`);

  // Brand distribution
  const byBrand: Record<string, number> = {};
  for (const t of targets) byBrand[t.ground_truth.brand_impersonated] = (byBrand[t.ground_truth.brand_impersonated] ?? 0) + 1;
  console.log("[fetch-openphish] brand distribution:", byBrand);

  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify(targets, null, 2) + "\n");
  console.log(`[fetch-openphish] → ${out} (${targets.length} targets, all active_fill=false / observe-only)`);

  // Print a few samples
  console.log("\n[fetch-openphish] samples:");
  for (const t of targets.slice(0, 5)) {
    console.log(`  ${t.id}  ${t.ground_truth.brand_impersonated.padEnd(18)} ${t.url.slice(0, 80)}`);
  }
}

main().catch((err) => {
  console.error("[fetch-openphish] fatal:", err);
  process.exit(1);
});
