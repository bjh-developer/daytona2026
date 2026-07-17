import type { DetonationResult, OcrResult, VisionResult, Verdict } from "./types.ts";

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
