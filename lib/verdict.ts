import type { AgentTranscript, DetonationResult, OcrResult, ScamVerdict, VisionResult, Verdict } from "./types.ts";

const FIELD_LABELS: Record<string, string> = {
  phone: "Phone number",
  otp: "Login code (OTP)",
  code: "Login code (OTP)",
  twofa: "2FA cloud password",
  password: "Password",
  nric: "NRIC",
};

/** Map raw field names to human labels for the card. */
export function humanFields(det: DetonationResult): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const f of det.fields) {
    const label = FIELD_LABELS[f.name.toLowerCase()] ?? f.label ?? f.name;
    if (!seen.has(label)) {
      seen.add(label);
      out.push(label);
    }
  }
  return out;
}

/** Deterministic verdict used when ai& is unavailable — always correct on the mock kit. */
export function templateVerdict(
  det: DetonationResult,
  vision: VisionResult,
  _ocr?: OcrResult,
): Verdict {
  const fields = humanFields(det);
  const asksForCode = fields.some((f) => /code|otp|2fa/i.test(f));
  const spreads = det.spreadSignals.length > 0;
  const brand = vision.brand && vision.brand !== "Unknown" ? vision.brand : "Telegram";

  const level: Verdict["level"] =
    (vision.is_login_form && asksForCode) || spreads ? "scam" : "suspicious";

  return {
    level,
    headline:
      level === "scam"
        ? `🚨 SCAM — this page steals your ${brand} login code`
        : `⚠️ SUSPICIOUS — this page impersonates ${brand}`,
    explanation:
      `This page impersonates ${brand}'s login. It asks for the code ${brand} texts you — ` +
      `if you enter it, criminals log in as you` +
      (spreads ? ` and message everyone in your contacts.` : `.`),
    harvestedFields: fields,
    wormLine: spreads
      ? `Once they're in, your account auto-sends the same trap to your contacts — that's how it spreads.`
      : `Never share a login code you didn't request.`,
    source: "template-fallback",
  };
}

/**
 * Deterministic scam verdict from the agent transcript (docs/nosana-finetuning.md §5).
 * The zero-AI floor for signal #6 — uses the behavioral signals the kit cannot fake:
 * harvest POST, credential field combo, non-legit domain, cloak. Mirrors the
 * `templateVerdict` pattern: always correct on the mock kit with no sponsor keys.
 */
export function templateScamVerdict(
  transcript: AgentTranscript,
  det?: DetonationResult,
): ScamVerdict {
  const evidence: string[] = [];
  const ctx = transcript.context;
  const steps = transcript.steps;

  // Signal: harvest POST captured.
  const postStep = steps.find((s) => s.kind === "observed_after" && /Captured POST/i.test(s.label));
  if (postStep) evidence.push(`POSTs credentials to ${postStep.label.replace(/^Captured POST:\s*/i, "")}`);

  // Signal: credential field combo (phone + OTP + 2FA).
  const fills = steps.filter((s) => s.kind === "action" && /fill/i.test(s.label));
  const fillLabels = fills.map((f) => f.label.toLowerCase());
  const hasPhone = fillLabels.some((l) => /phone|mobile|number/.test(l));
  const hasCode = fillLabels.some((l) => /code|otp/.test(l));
  const has2fa = fillLabels.some((l) => /2fa|password|cloud/.test(l));
  if (hasPhone && hasCode) evidence.push("asks for phone + login code together");
  if (has2fa) evidence.push("also asks for the 2FA password");

  // Signal: non-legit domain.
  if (ctx.real_brand_domain && ctx.domain && !ctx.domain.endsWith(ctx.real_brand_domain.replace(/^www\./, ""))) {
    evidence.push(`hosted on ${ctx.domain}, not the real ${ctx.real_brand_domain}`);
  } else if (ctx.domain) {
    evidence.push(`hosted on ${ctx.domain}`);
  }

  // Signal: cloak detected (from the detonation, if provided).
  if (det?.cloakDetected) evidence.push("serves a decoy to scanners but the real trap to SG visitors");

  // Signal: spread markers in the page.
  if (det?.spreadSignals?.length) evidence.push(`contains worm code (${det.spreadSignals.slice(0, 3).join(", ")})`);

  const isScam = evidence.length >= 2 || (!!postStep && (hasPhone || hasCode));
  const brand = ctx.claimed_brand || "Unknown";

  return {
    is_scam: isScam,
    brand_impersonated: brand,
    evidence: evidence.length ? evidence : ["no behavioral scam signals observed"],
    confidence: isScam ? 0.9 : 0.4,
    explanation: isScam
      ? `The agent's behavior on this page matches a ${brand} credential-harvesting scam: ${evidence.join("; ")}.`
      : `The agent did not observe strong scam signals on this page.`,
    source: "heuristic",
  };
}

