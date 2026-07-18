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
//   CAPTURE_TRANSCRIPT=1  record an agent behavioral transcript (§5). Default on.
//   AGENT_LLM_BASE_URL / AGENT_LLM_API_KEY / AGENT_LLM_MODEL
//                          OpenAI-compatible endpoint driving the agent loop. When
//                          absent, the worker falls back to the deterministic fill loop.
//   AGENT_MAX_STEPS        step budget for the LLM agent (default 6).
//   TRANSCRIPT_LOG_DIR     where to write transcript JSON logs (default logs/transcripts).
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
const CAPTURE_TRANSCRIPT = process.env.CAPTURE_TRANSCRIPT !== "0"; // default on
const AGENT_LLM_BASE_URL = process.env.AGENT_LLM_BASE_URL || "";
const AGENT_LLM_API_KEY = process.env.AGENT_LLM_API_KEY || "";
const AGENT_LLM_MODEL = process.env.AGENT_LLM_MODEL || "";
const AGENT_MAX_STEPS = Number(process.env.AGENT_MAX_STEPS || 6);
const AGENT_ENABLED = !!(AGENT_LLM_BASE_URL && AGENT_LLM_API_KEY && AGENT_LLM_MODEL);
const LOG_DIR = process.env.TRANSCRIPT_LOG_DIR || "logs/transcripts";

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
async function fillAndAdvance(page, fields, transcript) {
  const before = page.url();
  const postP = page.waitForRequest((r) => r.method() === "POST", { timeout: 4000 }).catch(() => null);
  for (const f of fields) {
    if (!f.name) continue;
    const val = dummyValue(f);
    await page.fill(`[name="${f.name}"]`, val).catch(() => {});
    if (CAPTURE_TRANSCRIPT && transcript) {
      transcript.push({
        kind: "action",
        label: `fill ${f.type === "password" ? "password" : "textbox"} "${f.label || f.placeholder || f.name}" with "${val}"`,
      });
    }
  }
  for (const sel of ADVANCE_SELECTORS) {
    const el = page.locator(sel).first();
    if ((await el.count().catch(() => 0)) && (await el.isVisible().catch(() => false))) {
      await el.click({ timeout: 3000 }).catch(() => {});
      if (CAPTURE_TRANSCRIPT && transcript) transcript.push({ kind: "action", label: `click ${sel}` });
      break;
    }
  }
  const post = await postP;
  // networkidle is unreliable behind a slow residential proxy — domcontentloaded
  // + a short settle is enough and never hangs the budget.
  await page.waitForLoadState("domcontentloaded", { timeout: 4000 }).catch(() => {});
  await page.waitForTimeout(500);
  return { harvest: post ? (post.postData() ?? undefined) : undefined, navigated: page.url() !== before };
}

const AGENT_SYSTEM =
  "You are a browser agent that determines if a page is a credential-harvesting scam. " +
  "You are given the page's accessibility tree, visible text, and the list of actions already taken. " +
  "Decide the SINGLE next action to take. Respond ONLY with JSON: " +
  '{"action":"fill"|"click"|"done","selector":"<css or aria-label>","value":"<dummy>","reason":"<short>"}.\n' +
  "Rules:\n" +
  "- Use dummy values only (e.g. S1234567A for NRIC, +6591234567 for phone, 000000 for codes, dummy2FA! for passwords). NEVER use real credentials.\n" +
  "- Fill every visible credential field EXACTLY ONCE, then click the submit button.\n" +
  "- DO NOT re-fill a field that is already in the 'Already done' list. Move to the next unfilled field.\n" +
  "- Return {\"action\":\"done\"} once you've submitted the form or there is nothing more to interact with.\n" +
  "- If the page is not a login/credential form, return {\"action\":\"done\"} immediately.\n" +
  "- Prefer selectors by [name=\"...\"], then by aria-label, then by visible text.";

/** Truncate the a11y snapshot to interactive elements (textbox/button/link/combobox). */
function compactA11y(node, depth = 0, out = []) {
  if (!node) return out;
  const INTERACTIVE = new Set(["textbox", "button", "link", "combobox", "checkbox", "menuitem"]);
  if (INTERACTIVE.has(node.role)) {
    const label = node.name || node.value || "";
    out.push(`${"  ".repeat(depth)}- ${node.role}${label ? ` "${label}"` : ""}`);
  }
  for (const c of node.children || []) compactA11y(c, depth + 1, out);
  return out;
}

/** Ask the agent LLM for the next action. Returns {action, selector, value, reason} or null. */
async function askAgentLlm(history) {
  const res = await fetch(`${AGENT_LLM_BASE_URL.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${AGENT_LLM_API_KEY}`,
    },
    body: JSON.stringify({
      model: AGENT_LLM_MODEL,
      max_tokens: 200,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: AGENT_SYSTEM },
        { role: "user", content: history },
      ],
    }),
  });
  if (!res.ok) throw new Error(`agent LLM ${res.status}: ${await res.text().catch(() => "")}`);
  const data = await res.json();
  const raw = data.choices?.[0]?.message?.content ?? "{}";
  const json = JSON.parse(raw.match(/\{[\s\S]*\}/)?.[0] ?? raw);
  return {
    action: String(json.action ?? "done"),
    selector: json.selector ? String(json.selector) : undefined,
    value: json.value != null ? String(json.value) : undefined,
    reason: json.reason ? String(json.reason) : undefined,
  };
}

/** Resolve an agent selector (css or aria-label string) to a Playwright locator. */
function resolveSelector(page, selector) {
  if (!selector) return null;
  // [name="..."] or other CSS — use directly
  if (/^[\[.#:a-zA-Z][\w\-="\[\]().#:>*~+ ]*$/.test(selector) && !selector.includes('" "')) {
    return page.locator(selector).first();
  }
  // Otherwise treat as aria-label / visible text
  return page.getByLabel(selector).or(page.getByRole("button", { name: selector })).first();
}

/**
 * LLM-driven agent loop (docs/nosana-finetuning.md §5). Reads the a11y tree +
 * visible text, asks the LLM for the next action, executes it, observes the
 * result. Tracks filled selectors to prevent re-filling the same field.
 * Safety: fill/click are IGNORED unless ACTIVE=1 (mock-kit-only). The agent
 * still observes and reasons on non-mock targets — it just doesn't interact.
 * Falls back to the deterministic fill loop when the LLM is not configured.
 */
async function agentLoop({ page, fields, bodyText, title, finalUrl, transcript }) {
  // Build the interactive-elements list from the fields we already extracted.
  // (Playwright 1.61 removed page.accessibility.snapshot(); fields[] is the
  // same surface — input/textarea/select elements with name/type/label.)
  const interactive = fields.map((f) => {
    const role = f.type === "password" ? "password" : "textbox";
    const label = f.label || f.placeholder || f.name;
    return `  - ${role}${label ? ` "${label}"` : ""}`;
  });
  const obs =
    `URL: ${finalUrl}\nTitle: "${title}"\n` +
    `Visible text: ${bodyText.slice(0, 500)}\n` +
    `Interactive elements:\n${interactive.length ? interactive.join("\n") : "  (none)"}`;

  if (CAPTURE_TRANSCRIPT) {
    transcript.push({ kind: "observed", label: `URL: ${finalUrl}`, detail: obs });
  }

  if (!AGENT_ENABLED) {
    return { usedLlm: false };
  }

  const filledSelectors = new Set();
  let history = `=== PAGE STATE ===\n${obs}\n\n=== TASK ===\nDecide the next action. Already done: (none).`;

  for (let step = 0; step < AGENT_MAX_STEPS; step++) {
    let action;
    try {
      action = await askAgentLlm(history);
    } catch (err) {
      if (CAPTURE_TRANSCRIPT) {
        transcript.push({ kind: "action", label: `agent LLM error: ${err.message}` });
      }
      return { usedLlm: true, error: err.message };
    }

    if (action.action === "done") {
      if (CAPTURE_TRANSCRIPT) {
        transcript.push({ kind: "action", label: `done — ${action.reason || "no further action"}` });
      }
      return { usedLlm: true };
    }

    // SAFETY GATE: never interact with a non-mock target.
    if (!ACTIVE && (action.action === "fill" || action.action === "click")) {
      if (CAPTURE_TRANSCRIPT) {
        transcript.push({
          kind: "action",
          label: `skipped ${action.action} (observe-only — not the mock kit)`,
          detail: action.reason,
        });
      }
      history += `\n\n=== STEP ${step + 1} ===\nRequested ${action.action} on "${action.selector}" but interaction is disabled (observe-only).`;
      continue;
    }

    // Skip re-filling an already-filled selector (defensive — the LLM is told not to).
    const selKey = action.selector || "";
    if (action.action === "fill" && filledSelectors.has(selKey)) {
      if (CAPTURE_TRANSCRIPT) {
        transcript.push({ kind: "action", label: `skipped re-fill "${selKey}" (already filled)`, detail: action.reason });
      }
      history += `\n\n=== STEP ${step + 1} ===\nSkipped re-fill of "${selKey}" (already in 'Already done'). Choose a different field or click submit.`;
      continue;
    }

    if (action.action === "fill" && action.selector && action.value != null) {
      const loc = resolveSelector(page, action.selector);
      if (loc) {
        await loc.fill(action.value).catch(() => {});
        filledSelectors.add(selKey);
        if (CAPTURE_TRANSCRIPT) {
          transcript.push({
            kind: "action",
            label: `fill "${action.selector}" with "${action.value}"`,
            detail: action.reason,
          });
        }
      }
    } else if (action.action === "click" && action.selector) {
      const loc = resolveSelector(page, action.selector);
      if (loc) {
        await loc.click().catch(() => {});
        if (CAPTURE_TRANSCRIPT) {
          transcript.push({ kind: "action", label: `click "${action.selector}"`, detail: action.reason });
        }
      }
    } else {
      if (CAPTURE_TRANSCRIPT) {
        transcript.push({ kind: "action", label: `unknown action: ${JSON.stringify(action)}` });
      }
    }

    // Observe after the action.
    await page.waitForTimeout(300);
    const afterText = (await page.evaluate(() => document.body?.innerText ?? "").catch(() => "")) || "";
    if (CAPTURE_TRANSCRIPT && afterText && afterText !== bodyText) {
      transcript.push({ kind: "observed_after", label: "Page text changed", detail: afterText.slice(0, 300) });
    }
    const doneList = [...filledSelectors].map((s) => `fill ${s}`).join(", ") || "(none)";
    history += `\n\n=== STEP ${step + 1} ===\nTook: ${action.action} on "${action.selector}"${action.value != null ? ` with "${action.value}"` : ""}\nReason: ${action.reason || ""}\nAlready done: ${doneList}`;
  }
  return { usedLlm: true };
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

    // Residential-proxy exits are flaky — a dead exit makes goto ERR_TIMED_OUT.
    // Retry a few times; a fresh attempt often lands on a working exit IP.
    let resp = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        resp = await page.goto(TARGET, { waitUntil: "domcontentloaded", timeout: 30000 });
        break;
      } catch (err) {
        if (attempt === 3) throw err;
        process.stderr.write(`[worker] goto attempt ${attempt} failed (${err.message}); retrying…\n`);
        await page.waitForTimeout(1500);
      }
    }
    // SPA: wait for something interactive to actually render.
    await page.waitForSelector("input, form, button, h1", { timeout: 8000 }).catch(() => {});
    await page.waitForTimeout(700);

    // HYBRID: walk the phishing funnel (gov claim → fake login), and at each
    // stage run the agent (observe + behavioral transcript for the Nosana
    // fine-tuning corpus §5; LLM-driven fills when AGENT_LLM_* is configured).
    const stages = [];
    const transcript = [];
    let capturedHarvestPayload;
    for (let i = 0; i < MAX_STEPS; i++) {
      const stage = await captureStage(page);
      stages.push(stage);
      if (!active || !stage.fields.length) break;

      const before = page.url();
      const bodyText = (await page.evaluate(() => document.body?.innerText ?? "").catch(() => "")) || "";
      // Agent observes + reasons over this stage (records transcript; LLM fills
      // when configured). Safe on non-mock targets — it only interacts when ACTIVE.
      const agentResult = await agentLoop({
        page,
        fields: stage.fields,
        bodyText,
        title: stage.title,
        finalUrl: stage.url,
        transcript,
      });

      // If the agent didn't already navigate, deterministically fill + click the
      // funnel's advance control (kits often use an <a> link, not a submit button).
      let harvest;
      let navigated = page.url() !== before;
      if (!navigated) {
        const r = await fillAndAdvance(page, stage.fields, transcript);
        harvest = r.harvest;
        navigated = r.navigated;
      }
      if (harvest && !capturedHarvestPayload) {
        capturedHarvestPayload = harvest;
        if (CAPTURE_TRANSCRIPT) {
          transcript.push({ kind: "observed_after", label: "Captured harvest POST", detail: `body: ${harvest}` });
        }
      }
      if (!navigated) break; // couldn't advance → funnel ended
      await page.waitForSelector("input, form, h1, button", { timeout: 4000 }).catch(() => {});
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
      // Show EVERY stage the funnel walked — lure, credential trap, AND the
      // post-submit outcome ("you got scammed") page. The verdict text is
      // trimmed separately (see credentialStageIndex) so it doesn't over-narrate.
      funnelScreenshots: stages.map((s) => s.screenshotBase64),
      credentialStageIndex: primaryIdx,
      primaryScreenshotBase64: stages[primaryIdx]?.screenshotBase64 ?? stages[0]?.screenshotBase64 ?? "",
      landingScreenshotBase64: stages[0]?.screenshotBase64 ?? "",
      fields,
      ajaxEndpoints: [...ajaxEndpoints],
      spreadSignals,
      capturedHarvestPayload,
      transcript,
      status: resp?.status() ?? 0,
      ms: Date.now() - t0,
    };
  } finally {
    await browser.close();
  }
}

// Pass 1: scanner view (non-SG exit, passive) → the decoy a scanner would see.
// Run BOTH passes concurrently — they're independent browsers/proxies, so the
// scanner's ~5s doesn't add to the SG funnel's ~15s (was sequential → ~23s).
// Scanner is non-fatal (null if its exit is dead); SG is load-bearing.
const [scanner, sg] = await Promise.all([
  onePass({ proxy: SCANNER_PROXY, active: false }).catch((err) => {
    process.stderr.write(`[worker] scanner pass failed (${err.message}); continuing without decoy/cloak\n`);
    return null;
  }),
  onePass({ proxy: PROXY, active: ACTIVE }),
]);

// Cloak = the two vantages rendered materially different landing pages. Only
// meaningful when the scanner pass succeeded and at least one pass used a proxy.
const cloakDetected =
  !!scanner &&
  (!!PROXY || !!SCANNER_PROXY) &&
  (scanner.title !== sg.title || Math.abs(scanner.bodyLen - sg.bodyLen) > 40);

// The VERDICT only reasons over the funnel up to the credential stage — the
// trailing "you got scammed" outcome page would make it invent extra steps.
// (The bot still SHOWS the outcome screenshot via funnelScreenshots.)
const meaningfulUrls = sg.funnelUrls.slice(0, (sg.credentialStageIndex ?? 0) + 1);
const result = {
  finalUrl: meaningfulUrls[meaningfulUrls.length - 1] ?? sg.landingUrl,
  redirectChain: meaningfulUrls,
  screenshotBase64: sg.primaryScreenshotBase64,
  decoyScreenshotBase64: scanner ? scanner.landingScreenshotBase64 : undefined,
  funnelScreenshots: sg.funnelScreenshots,
  credentialStageIndex: sg.credentialStageIndex ?? 0,
  cloakDetected,
  fields: sg.fields,
  ajaxEndpoints: sg.ajaxEndpoints,
  spreadSignals: sg.spreadSignals,
  capturedHarvestPayload: sg.capturedHarvestPayload,
  timings: { scannerMs: scanner ? scanner.ms : 0, sgMs: sg.ms },
};

// Attach the agent transcript (docs/nosana-finetuning.md §5). The transcript is
// the evasion-proof input to the scam classifier — behavioral signals a kit
// can't fake (harvest POST, field combo, non-legit domain).
if (CAPTURE_TRANSCRIPT && sg.transcript?.length) {
  let domain = "";
  try { domain = new URL(sg.finalUrl).hostname; } catch { /* leave empty */ }
  result.agentTranscript = {
    goal: "Determine if this page is a credential-harvesting scam.",
    steps: sg.transcript,
    context: {
      domain,
      // claimed_brand / real_brand_domain / brand_note are filled by the
      // classifier or capture script at ingest time — the worker only sees
      // the rendered page.
    },
  };
}

// Persist the transcript (and full result) to logs/transcripts/ for inspection.
// One timestamped JSON file per run. Set TRANSCRIPT_LOG_DIR="" to disable.
if (result.agentTranscript && LOG_DIR) {
  try {
    const { mkdirSync, writeFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const dir = resolve(LOG_DIR);
    mkdirSync(dir, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    const safeDomain = (result.agentTranscript.context.domain || "unknown").replace(/[^a-z0-9.-]/gi, "_");
    const fname = `${ts}_${safeDomain}.json`;
    writeFileSync(
      resolve(dir, fname),
      JSON.stringify(
        {
          capturedAt: new Date().toISOString(),
          targetUrl: TARGET,
          finalUrl: result.finalUrl,
          activeFill: ACTIVE,
          agentLlmEnabled: AGENT_ENABLED,
          agentLlmModel: AGENT_LLM_MODEL || null,
          result,
        },
        null,
        2,
      ),
    );
    process.stderr.write(`[worker] transcript written to ${resolve(dir, fname)}\n`);
  } catch (err) {
    process.stderr.write(`[worker] failed to write transcript log: ${err.message}\n`);
  }
}

process.stdout.write("\n__DETONATION_JSON__" + JSON.stringify(result) + "__END__\n");
