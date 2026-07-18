// Detonation worker. Runs inside the Daytona sandbox (Chromium baked in) OR
// locally as the egress-blocked fallback. Plain ESM so `node worker.mjs` works
// anywhere. Reads config from env, prints a DetonationResult JSON to stdout.
//
// Env:
//   TARGET_URL      (required) the link to detonate
//   PROXY_SERVER    e.g. http://pr.oxylabs.io:7777  (SG pass; omit to skip proxied pass)
//   PROXY_USER, PROXY_PASS
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
// Scanner pass proxy — a NON-SG exit so the "datacenter/scanner" view is foreign
// even when the detonation runs from within Singapore. Falls back to no proxy.
const SCANNER_PROXY = process.env.SCANNER_PROXY_SERVER
  ? { server: process.env.SCANNER_PROXY_SERVER, username: process.env.SCANNER_PROXY_USER, password: process.env.SCANNER_PROXY_PASS }
  : null;
const ACTIVE = process.env.ACTIVE_FILL === "1";

const SPREAD_TERMS = ["contacts", "api_id", "api_hash", "forwardtocontacts", "contact_list"];

async function onePass({ proxy, active }) {
  const browser = await chromium.launch({ headless: true, proxy: proxy ?? undefined });
  const t0 = Date.now();
  try {
    const context = await browser.newContext({
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
    });
    const page = await context.newPage();

    const redirectChain = [];
    page.on("response", (r) => {
      if ([301, 302, 303, 307, 308].includes(r.status())) redirectChain.push(r.url());
    });
    const ajaxEndpoints = new Set();
    page.on("request", (r) => {
      if (["xhr", "fetch"].includes(r.resourceType())) ajaxEndpoints.add(new URL(r.url()).pathname);
    });

    const resp = await page.goto(TARGET, { waitUntil: "networkidle", timeout: 30000 });
    const finalUrl = page.url();
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

    // Screenshot the page NOW, before any active fill — submitting can navigate
    // the app away (e.g. an SPA route to a "you got scammed" page), and the
    // vision model must see the login/impersonation page, not what comes after.
    const screenshotBase64 = (await page.screenshot({ fullPage: true })).toString("base64");

    let capturedHarvestPayload;
    if (active && fields.length) {
      try {
        const reqP = page.waitForRequest((r) => r.method() === "POST", { timeout: 5000 });
        for (const f of fields) {
          if (!f.name) continue;
          const sel = `[name="${f.name}"]`;
          const val = f.type === "tel" ? "91234567" : f.type === "password" ? "test" : "00000";
          await page.fill(sel, val).catch(() => {});
        }
        await page.click('button[type="submit"], input[type="submit"], button', { timeout: 3000 }).catch(() => {});
        const req = await reqP;
        capturedHarvestPayload = req.postData() ?? undefined;
      } catch {
        /* harvest not captured; non-fatal */
      }
    }

    return {
      finalUrl,
      redirectChain,
      title,
      bodyLen: bodyText.length,
      screenshotBase64,
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
// Pass 2: the REAL page from the SG residential exit (or no-proxy locally),
// where active fill + harvest capture run.
const sg = await onePass({ proxy: PROXY, active: ACTIVE });

// Cloak = the two vantages rendered materially different pages. Only meaningful
// when at least one pass used a proxy (two identical local passes never count).
const cloakDetected =
  (!!PROXY || !!SCANNER_PROXY) &&
  (scanner.title !== sg.title || Math.abs(scanner.bodyLen - sg.bodyLen) > 40);

const result = {
  finalUrl: sg.finalUrl,
  redirectChain: sg.redirectChain,
  screenshotBase64: sg.screenshotBase64,
  decoyScreenshotBase64: scanner.screenshotBase64,
  cloakDetected,
  fields: sg.fields,
  ajaxEndpoints: sg.ajaxEndpoints,
  spreadSignals: sg.spreadSignals,
  capturedHarvestPayload: sg.capturedHarvestPayload,
  timings: { scannerMs: scanner.ms, sgMs: sg.ms },
};

process.stdout.write("\n__DETONATION_JSON__" + JSON.stringify(result) + "__END__\n");
