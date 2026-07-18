// Detonation worker. Runs inside the Daytona sandbox (Chromium baked in) OR
// locally as the egress-blocked fallback. Plain ESM so `node worker.mjs` works
// anywhere. Reads config from env, prints a DetonationResult JSON to stdout.
//
// Env:
//   TARGET_URL      (required) the link to detonate
//   PROXY_SERVER    e.g. http://pr.oxylabs.io:7777  (SG pass; omit to skip proxied pass)
//   PROXY_USER, PROXY_PASS
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

    // Agent behavioral transcript (docs/nosana-finetuning.md §5).
    const transcript = [];

    // Capture the harvest POST if the agent (or deterministic fallback) submits.
    let capturedHarvestPayload;
    let pendingPostPromise;
    if (active && fields.length) {
      pendingPostPromise = page.waitForRequest((r) => r.method() === "POST", { timeout: 8000 }).catch(() => null);
    }

    // Run the agent loop (LLM-driven when configured, deterministic fallback otherwise).
    const agentResult = await agentLoop({ page, fields, bodyText, title, finalUrl, transcript });

    // Deterministic fallback fill — only when the LLM agent didn't run AND active
    // is on. Preserves the original mock-kit harvest behavior when no LLM key is set.
    if (!agentResult.usedLlm && active && fields.length) {
      for (const f of fields) {
        if (!f.name) continue;
        const sel = `[name="${f.name}"]`;
        const val = f.type === "tel" ? "91234567" : f.type === "password" ? "test" : "00000";
        await page.fill(sel, val).catch(() => {});
        if (CAPTURE_TRANSCRIPT) {
          transcript.push({
            kind: "action",
            label: `fill ${f.type === "password" ? "password" : "textbox"} "${f.label || f.placeholder || f.name}" with "${val}"`,
          });
        }
      }
      await page.click('button[type="submit"], input[type="submit"], button', { timeout: 3000 }).catch(() => {});
      if (CAPTURE_TRANSCRIPT) {
        transcript.push({ kind: "action", label: "click button 'Next'" });
      }
    }

    // Collect the harvest POST if one fired.
    if (pendingPostPromise) {
      const req = await pendingPostPromise;
      if (req) {
        capturedHarvestPayload = req.postData() ?? undefined;
        if (CAPTURE_TRANSCRIPT) {
          transcript.push({
            kind: "observed_after",
            label: `Captured POST: POST ${req.url()}`,
            detail: `body: ${capturedHarvestPayload ?? "(empty)"}`,
          });
        }
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
      transcript,
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
