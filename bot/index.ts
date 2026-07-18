import { Bot, InlineKeyboard, InputFile } from "grammy";
import { config } from "../lib/config.ts";
import { runCheck, NoUrlError } from "../lib/orchestrator.ts";
import type { CheckResult } from "../lib/types.ts";

if (!config.telegram.token) {
  console.error("TELEGRAM_BOT_TOKEN missing. Set it in .env (from @BotFather).");
  process.exit(1);
}

const bot = new Bot(config.telegram.token);

const WELCOME =
  "🧨 <b>detonate.sg</b>\n\n" +
  "Forward me a suspicious Telegram message (or paste a link). " +
  "I open it safely in an isolated sandbox from a Singapore connection and show you exactly what it does.";

bot.command("start", (ctx) => ctx.reply(WELCOME, { parse_mode: "HTML" }));

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function verdictMessage(r: CheckResult): string {
  const v = r.verdict;
  const lines = [`<b>${esc(v.headline)}</b>`, "", esc(v.explanation)];
  if (v.harvestedFields.length) {
    lines.push("", `🔍 <b>This page harvests:</b>`, ...v.harvestedFields.map((f) => `   • ${esc(f)}`));
  }
  // Impersonation verdict comes from the behavioral scam classifier (stronger
  // than pixel-vision). Lead with the brand + confidence.
  const sc = r.scamClassification;
  if (sc?.is_scam && sc.brand_impersonated && !/^(none|unknown)$/i.test(sc.brand_impersonated)) {
    lines.push("", `🚩 <b>${esc(sc.brand_impersonated)} impersonation — ${Math.round(sc.confidence * 100)}% scam</b>`);
  }
  if (r.ocr?.evidenceLines?.length) {
    lines.push("", `📄 <b>It literally says:</b>`, ...r.ocr.evidenceLines.map((l) => `   “${esc(l)}”`));
  }
  if (sc?.evidence?.length) {
    lines.push("", `🤖 <b>Behavioral analysis:</b>`, ...sc.evidence.slice(0, 3).map((e) => `   • ${esc(e)}`));
  }
  if (r.detonation.cloakDetected) {
    lines.push("", `🕵️ <i>It showed a harmless decoy to the scanner but the real trap to a Singapore visitor — that's why link-checkers miss it.</i>`);
  }
  lines.push("", `🪱 ${esc(v.wormLine)}`);
  if (r.daytona.ok) {
    lines.push("", `🧨 <i>Isolated in Daytona sandbox ${esc(r.daytona.sandboxId.slice(0, 8))} — this hackathon's Tier 1 credits block the sandbox's live internet, so the page-fetch itself ran locally.</i>`);
  }
  return lines.join("\n");
}

const ctas = new InlineKeyboard()
  .url("🚨 Report to ScamShield", "https://www.scamshield.gov.sg/")
  .row()
  .url("🔒 How to enable Telegram 2FA", "https://telegram.org/blog/sessions-and-2-step-verification");

bot.on("message:text", async (ctx) => {
  const text = ctx.message.text;
  if (text.startsWith("/")) return;

  const status = await ctx.reply("🧨 Detonating… <i>reading the message…</i>", { parse_mode: "HTML" });
  const edit = (label: string) =>
    ctx.api
      .editMessageText(ctx.chat.id, status.message_id, `🧨 Detonating… <i>${esc(label)}</i>`, { parse_mode: "HTML" })
      .catch(() => {});

  try {
    await ctx.replyWithChatAction("upload_photo");
    const result = await runCheck(text, async (e) => {
      await edit(e.label);
    });

    const d = result.detonation;
    const photo = (b64: string, name: string, caption: string) => ({
      type: "photo" as const,
      media: new InputFile(Buffer.from(b64, "base64"), name),
      caption,
    });

    // Show every stage the funnel walked — the lure, the credential trap, and
    // the post-submit "you got scammed" outcome — each captioned with why.
    const brandRaw = result.scamClassification?.brand_impersonated || result.vision?.brand;
    const brand = brandRaw && !/^(none|unknown)$/i.test(brandRaw) ? brandRaw : "Telegram";
    const steals = result.verdict.harvestedFields.length
      ? result.verdict.harvestedFields.join(", ")
      : "your login details";
    const stages = d.funnelScreenshots?.length ? d.funnelScreenshots : [d.screenshotBase64];
    const credIdx = d.credentialStageIndex ?? stages.length - 1;
    const captionFor = (i: number, n: number): string => {
      if (n === 1) {
        return `🚩 The scam page — a fake ${brand} login. It asks for ${steals}. A real ${brand} login never asks for the code it texts you.`;
      }
      if (i < credIdx) {
        return `🎣 Step ${i + 1}: the bait — a fake claim page that funnels you to the login trap.`;
      }
      if (i === credIdx) {
        return `🚩 Step ${i + 1}: the trap — a fake ${brand} login. Our agent typed a dummy phone, OTP and 2FA password and hit submit. Real ${brand} never asks for the code it texts you.`;
      }
      return `💀 Step ${i + 1}: the result — after "submitting", this is what a victim sees. Their ${brand} account is now stolen.`;
    };
    const media = stages.map((shot, i) => photo(shot, `scam${i + 1}.png`, captionFor(i, stages.length)));
    if (media.length >= 2) await ctx.replyWithMediaGroup(media);
    else await ctx.replyWithPhoto(media[0].media, { caption: media[0].caption });

    await ctx.api.editMessageText(ctx.chat.id, status.message_id, verdictMessage(result), {
      parse_mode: "HTML",
      reply_markup: ctas,
      link_preview_options: { is_disabled: true },
    });
  } catch (err) {
    const msg = err instanceof NoUrlError ? "I couldn't find a link in that message. Forward one with a link in it." : "Something went wrong detonating that link. Try again.";
    if (!(err instanceof NoUrlError)) console.error("[bot] check failed:", err);
    await ctx.api
      .editMessageText(ctx.chat.id, status.message_id, `⚠️ ${esc(msg)}`, { parse_mode: "HTML" })
      .catch(() => ctx.reply(msg));
  }
});

bot.catch((e) => console.error("[bot] error:", e.error));

console.log(`detonate.sg bot starting (USE_MOCKS=${config.useMocks})…`);
bot.start({ onStart: (i) => console.log(`@${i.username} is live. Long-polling.`) });
