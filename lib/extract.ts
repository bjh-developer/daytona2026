import type { Verdict } from "./types.ts";

const URL_RE = /\b((?:https?:\/\/|www\.)[^\s<>()]+)/gi;

/** Pull the first plausible URL out of a forwarded message's text. */
export function extractUrl(text: string): string | null {
  const matches = text.match(URL_RE);
  if (!matches?.length) return null;
  let u = matches[0].replace(/[.,);]+$/, ""); // trim trailing punctuation
  if (!/^https?:\/\//i.test(u)) u = "http://" + u;
  return u;
}

// Lures that shadow real SG government payouts + Telegram-takeover tells.
const SCAM_TERMS = [
  "gst voucher", "gstv", "sg60", "cdc voucher", "cost of living",
  "payout", "claim", "government", "singpass", "paynow", "nric",
  "telegram", "verify", "otp", "login code", "$850", "$1,000",
];

/** Instant text-only provisional guess, returned before detonation runs. */
export function provisionalVerdict(text: string): {
  level: Verdict["level"];
  reason: string;
} {
  const lc = text.toLowerCase();
  const hits = SCAM_TERMS.filter((t) => lc.includes(t));
  const hasUrl = !!extractUrl(text);
  if (hits.length >= 3 && hasUrl)
    return {
      level: "suspicious",
      reason: `Mentions ${hits.slice(0, 3).join(", ")} and links out — classic government-payout lure. Detonating to confirm…`,
    };
  if (hasUrl)
    return { level: "unknown", reason: "Contains a link — detonating to see where it goes…" };
  return { level: "unknown", reason: "No link found to detonate." };
}
