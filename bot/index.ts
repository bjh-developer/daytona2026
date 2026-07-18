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
  if (r.vision?.is_login_form) {
    lines.push("", `👁️ Vision: <b>${esc(r.vision.brand)} login impersonation ${Math.round(r.vision.confidence * 100)}%</b>`);
  }
  if (r.ocr?.evidenceLines?.length) {
    lines.push("", `📄 <b>It literally says:</b>`, ...r.ocr.evidenceLines.map((l) => `   “${esc(l)}”`));
  }
  if (r.scamClassification) {
    const sc = r.scamClassification;
    const emoji = sc.is_scam ? "🤖" : "✅";
    const top = sc.evidence[0] ? ` — ${esc(sc.evidence[0])}` : "";
    lines.push(
      "",
      `${emoji} <b>Behavioral check (${Math.round(sc.confidence * 100)}%):</b> ${esc(sc.explanation)}${top}`,
    );
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

    // Show the ACTUAL scam pages (the real trap a Singapore visitor sees), each
    // captioned with why it's a scam. The decoy/cloak evasion point stays in the
    // verdict text below.
    const brand = result.vision?.brand && !/^(none|unknown)$/i.test(result.vision.brand) ? result.vision.brand : "Telegram";
    const steals = result.verdict.harvestedFields.length
      ? result.verdict.harvestedFields.join(", ")
      : "your login details";
    const stages = d.funnelScreenshots?.length ? d.funnelScreenshots : [d.screenshotBase64];
    const captionFor = (i: number, n: number): string => {
      const last = i === n - 1;
      if (n === 1) {
        return `🚩 The scam page — a fake ${brand} login. It asks for ${steals}. A real ${brand} login never asks for the code it texts you.`;
      }
      if (last) {
        return `🚩 Step ${i + 1}: the trap — a fake ${brand} login that steals ${steals}. Real ${brand} never asks for the code it texts you.`;
      }
      return `🎣 Step ${i + 1}: the bait — a fake claim page that funnels you to the login trap.`;
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
