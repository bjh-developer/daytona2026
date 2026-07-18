// Detonation worker. Runs inside the Daytona sandbox (Chromium baked in) OR
// locally as the egress-blocked fallback. Plain ESM so `node worker.mjs` works
// anywhere. Reads config from env, prints a DetonationResult JSON to stdout.
//
// It walks the phishing FUNNEL: many kits are multi-step (a gov-payout claim
// page that only *then* redirects to the fake login). So each pass follows the
// flow — screenshot a stage, fill it with dummy data, submit, follow the
// navigation, repeat — until there's nowhere left to go.
//
// Env:
//   TARGET_URL      (required) the link to detonate
//   PROXY_SERVER    e.g. http://pr.oxylabs.io:7777  (SG pass; omit to skip proxied pass)
//   PROXY_USER, PROXY_PASS
//   SCANNER_PROXY_* non-SG exit for the scanner (decoy) pass
//   ACTIVE_FILL=1   MOCK KIT ONLY — type dummy values + capture the harvest POST
//
// Never set ACTIVE_FILL against a real link.

import { chromium } from "playwright";

const TARGET = process.env.TARGET_URL;
if (!TARGET) {
  console.error("TARGET_URL required");
  process.exit(2);
}
const PROXY = process.env.PROXY_SERVER
  ? { server: process.env.PROXY_SERVER, username: process.env.PROXY_USER, password: process.env.PROXY_PASS }
  : null;
const SCANNER_PROXY = process.env.SCANNER_PROXY_SERVER
  ? { server: process.env.SCANNER_PROXY_SERVER, username: process.env.SCANNER_PROXY_USER, password: process.env.SCANNER_PROXY_PASS }
  : null;
const ACTIVE = process.env.ACTIVE_FILL === "1";

const SPREAD_TERMS = ["contacts", "api_id", "api_hash", "forwardtocontacts", "contact_list"];
const MAX_STEPS = 3;

const dummyValue = (f) =>
  f.type === "tel" ? "91234567" : f.type === "password" ? "test" : /nric|fin/i.test(f.name) ? "S1234567A" : "00000";

/** Does this stage look like a credential/login step (has a password or OTP field)? */
const isLoginStage = (fields) =>
  fields.some((f) => f.type === "password" || /otp|code|2fa|twofa|password/i.test(f.name));

async function captureStage(page) {
  const url = page.url();
  const title = await page.title().catch(() => "");
  const bodyText = (await page.evaluate(() => document.body?.innerText ?? "").catch(() => "")) || "";
  const fields = await page.$$eval("input, textarea, select", (els) =>
    els
      .filter((e) => e.type !== "hidden")
      .map((e) => ({
        name: e.getAttribute("name") || e.id || "",
        type: e.getAttribute("type") || e.tagName.toLowerCase(),
        placeholder: e.getAttribute("placeholder") || undefined,
        label: e.getAttribute("aria-label") || undefined,
      })),
  );
  const html = await page.content();
  const hay = (html + " " + bodyText).toLowerCase();
  const spreadSignals = SPREAD_TERMS.filter((t) => hay.includes(t));
  const screenshotBase64 = (await page.screenshot({ fullPage: true })).toString("base64");
  return { url, title, bodyLen: bodyText.length, fields, spreadSignals, screenshotBase64 };
}

// Controls that advance the funnel — a submit button, OR a button-styled link /
// a "verify/claim/next/continue" link (kits often use an <a>, not a <button>).
const ADVANCE_SELECTORS = [
  'button[type="submit"]',
  'input[type="submit"]',
  "a.sgds-button",
  'a[class*="button"]',
  "button",
  '[role="button"]',
  'a:has-text("Verify")',
  'a:has-text("Claim")',
  'a:has-text("Continue")',
  'a:has-text("Next")',
  'a:has-text("Proceed")',
];

/** Fill dummy values, submit, capture any harvest POST, follow the navigation. */
async function fillAndAdvance(page, fields) {
  const before = page.url();
  const postP = page.waitForRequest((r) => r.method() === "POST", { timeout: 4000 }).catch(() => null);
  for (const f of fields) {
    if (!f.name) continue;
    await page.fill(`[name="${f.name}"]`, dummyValue(f)).catch(() => {});
  }
  for (const sel of ADVANCE_SELECTORS) {
    const el = page.locator(sel).first();
    if ((await el.count().catch(() => 0)) && (await el.isVisible().catch(() => false))) {
      await el.click({ timeout: 3000 }).catch(() => {});
      break;
    }
  }
  const post = await postP;
  // Let either a full navigation or an SPA route change (pushState) settle.
  await page.waitForLoadState("networkidle", { timeout: 6000 }).catch(() => {});
  await page.waitForTimeout(800);
  return { harvest: post ? (post.postData() ?? undefined) : undefined, navigated: page.url() !== before };
}

async function onePass({ proxy, active }) {
  const browser = await chromium.launch({ headless: true, proxy: proxy ?? undefined });
  const t0 = Date.now();
  try {
    const context = await browser.newContext({
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
    });
    const page = await context.newPage();

    const ajaxEndpoints = new Set();
    page.on("request", (r) => {
      if (["xhr", "fetch"].includes(r.resourceType())) {
        try {
          ajaxEndpoints.add(new URL(r.url()).pathname);
        } catch {}
      }
    });

    const resp = await page.goto(TARGET, { waitUntil: "networkidle", timeout: 30000 });

    const stages = [];
    let capturedHarvestPayload;
    for (let i = 0; i < MAX_STEPS; i++) {
      const stage = await captureStage(page);
      stages.push(stage);
      if (!active || !stage.fields.length) break;
      const { harvest, navigated } = await fillAndAdvance(page, stage.fields);
      if (harvest && !capturedHarvestPayload) capturedHarvestPayload = harvest;
      if (!navigated) break;
    }

    // Merge evidence across all stages.
    const seen = new Set();
    const fields = stages
      .flatMap((s) => s.fields)
      .filter((f) => f.name && !seen.has(f.name) && seen.add(f.name));
    const spreadSignals = [...new Set(stages.flatMap((s) => s.spreadSignals))];

    // The screenshot the vision model should judge = the credential/login stage
    // (last one that looks like a login), not the entry lure or a later dead-end.
    let loginIdx = -1;
    stages.forEach((s, i) => {
      if (isLoginStage(s.fields)) loginIdx = i;
    });
    const primaryIdx = loginIdx >= 0 ? loginIdx : 0;

    return {
      landingUrl: stages[0]?.url ?? TARGET,
      funnelUrls: stages.map((s) => s.url),
      title: stages[0]?.title ?? "",
      bodyLen: stages[0]?.bodyLen ?? 0,
      // Show the funnel up to and including the credential stage (skip trailing
      // dead-ends like a "you got scammed" page).
      funnelScreenshots: stages.slice(0, Math.max(primaryIdx, 0) + 1).map((s) => s.screenshotBase64),
      primaryScreenshotBase64: stages[primaryIdx]?.screenshotBase64 ?? stages[0]?.screenshotBase64 ?? "",
      landingScreenshotBase64: stages[0]?.screenshotBase64 ?? "",
      fields,
      ajaxEndpoints: [...ajaxEndpoints],
      spreadSignals,
      capturedHarvestPayload,
      status: resp?.status() ?? 0,
      ms: Date.now() - t0,
    };
  } finally {
    await browser.close();
  }
}

// Pass 1: scanner view (non-SG exit, passive) → the decoy a scanner would see.
const scanner = await onePass({ proxy: SCANNER_PROXY, active: false });
// Pass 2: the REAL funnel from the SG residential exit (active fill + harvest).
const sg = await onePass({ proxy: PROXY, active: ACTIVE });

// Cloak = the two vantages rendered materially different landing pages. Only
// meaningful when at least one pass used a proxy.
const cloakDetected =
  (!!PROXY || !!SCANNER_PROXY) &&
  (scanner.title !== sg.title || Math.abs(scanner.bodyLen - sg.bodyLen) > 40);

// Only report the funnel up to the credential stage — trailing dead-ends
// (e.g. a "you got scammed" reveal page) would make the verdict invent extra steps.
const meaningfulUrls = sg.funnelUrls.slice(0, sg.funnelScreenshots.length);
const result = {
  finalUrl: meaningfulUrls[meaningfulUrls.length - 1] ?? sg.landingUrl,
  redirectChain: meaningfulUrls,
  screenshotBase64: sg.primaryScreenshotBase64,
  decoyScreenshotBase64: scanner.landingScreenshotBase64,
  funnelScreenshots: sg.funnelScreenshots,
  cloakDetected,
  fields: sg.fields,
  ajaxEndpoints: sg.ajaxEndpoints,
  spreadSignals: sg.spreadSignals,
  capturedHarvestPayload: sg.capturedHarvestPayload,
  timings: { scannerMs: scanner.ms, sgMs: sg.ms },
};

process.stdout.write("\n__DETONATION_JSON__" + JSON.stringify(result) + "__END__\n");
