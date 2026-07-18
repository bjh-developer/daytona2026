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
  const lines = [
    `<b>${esc(v.headline)}</b>`,
    "",
    esc(v.explanation),
    "",
    `🔍 <b>This page harvests:</b>`,
    ...v.harvestedFields.map((f) => `   • ${esc(f)}`),
  ];
  if (r.vision?.is_login_form) {
    lines.push("", `👁️ Vision: <b>${esc(r.vision.brand)} login impersonation ${Math.round(r.vision.confidence * 100)}%</b>`);
  }
  if (r.ocr?.evidenceLines?.length) {
    lines.push("", `📄 <b>It literally says:</b>`, ...r.ocr.evidenceLines.map((l) => `   “${esc(l)}”`));
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
    const media = [];
    if (d.decoyScreenshotBase64) {
      media.push({
        type: "photo" as const,
        media: new InputFile(Buffer.from(d.decoyScreenshotBase64, "base64"), "scanner.png"),
        caption: "🌐 What a scanner (ScamShield) sees — a harmless decoy",
      });
    }
    media.push({
      type: "photo" as const,
      media: new InputFile(Buffer.from(d.screenshotBase64, "base64"), "trap.png"),
      caption: "🇸🇬 What you'd see from Singapore — the real trap",
    });
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
