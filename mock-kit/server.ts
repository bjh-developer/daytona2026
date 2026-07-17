// Mock phishing kit — DEMO ONLY. Two-step, cloaked:
//   /        gov GST-payout lure (the front door)  → CTA to /verify
//   /verify  Telegram-login trap (phone→OTP→2FA)   → harvest + worm stub; screenshot target
// Serves a harmless decoy to scanners/non-SG; the real pages only to SG visitors.
// Never real criminal infrastructure; nothing is ever exfiltrated.
import express from "express";

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const PORT = Number(process.env.PORT || 8080);

/** Cloak decision. Vercel sets x-vercel-ip-country; locally use ?geo/?force. */
function servesReal(req: express.Request): boolean {
  const force = String(req.query.force || "");
  if (force === "real") return true;
  if (force === "decoy") return false;
  const country = String(req.header("x-vercel-ip-country") || req.query.geo || "").toUpperCase();
  if (country) return country === "SG";
  return true; // no geo signal (local UI dev) → show the real page
}

const DECOY = `<!doctype html><html><head><meta charset="utf-8"><title>Page not available</title>
<style>body{font-family:system-ui;display:grid;place-items:center;height:100vh;margin:0;color:#666;background:#fafafa}</style></head>
<body><div><h1 style="font-weight:400">404</h1><p>This page is not available.</p></div></body></html>`;

// Step 1 — gov GST-payout lure (from the fake-phishing-site design; inlined, no CDN).
// Education intentionally lives in the bot verdict, NOT on the page, so the
// screenshot reads as a real trap.
const GOV_LURE = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>GST Voucher — Claim Your Benefits</title>
<style>
  *{box-sizing:border-box}
  body{font-family:'Inter',system-ui,-apple-system,Roboto,sans-serif;margin:0;color:#1a1a1a;background:#fff}
  .demo{background:#fff3cd;border-bottom:1px solid #ffc107;padding:8px 12px;font-size:12px;text-align:center}
  .masthead{background:#f0f0f0;padding:6px 0;font-size:12px;color:#5b5b5b}
  .gov{background:#1a1a1a;color:#fff;padding:10px 20px;font-size:12px}
  .gov b{letter-spacing:.3px}
  .wrap{max-width:600px;margin:32px auto;padding:0 20px}
  h1{font-size:26px;margin:0 0 6px}
  .muted{color:#707579;font-size:14px;margin:0 0 24px}
  label{display:block;font-size:13px;font-weight:600;margin:16px 0 4px}
  input{width:100%;padding:12px 14px;border:1px solid #dadce0;border-radius:8px;font-size:16px}
  input:focus{outline:none;border-color:#c00}
  .pref{display:flex}.pref span{padding:12px 12px;border:1px solid #dadce0;border-right:0;border-radius:8px 0 0 8px;background:#f7f7f7}
  .pref input{border-radius:0 8px 8px 0}
  .tgnote{margin:22px 0;padding:14px 16px;border:1px solid #d8eefb;background:#f2f9ff;border-radius:10px;font-size:14px}
  .tgnote b{color:#2AABEE}
  button{margin-top:24px;width:100%;padding:14px;background:#c00;color:#fff;border:0;border-radius:8px;font-size:16px;font-weight:700;cursor:pointer}
  a.btn{display:block;text-align:center;text-decoration:none}
</style></head>
<body>
  <div class="demo">⚠️ DEMO ONLY — controlled phishing replica for detonate.sg. Not a real government site.</div>
  <div class="gov">🦁 <b>A Singapore Government Agency Website</b></div>
  <div class="masthead">Government payouts · GST Voucher Scheme 2026</div>
  <div class="wrap">
    <h1>GST Voucher Claim</h1>
    <p class="muted">You are eligible for up to <b>$850</b> in cash. Verify your identity to receive your payout by 7 August 2026.</p>
    <form action="/verify" method="get">
      <label for="nric">NRIC / FIN</label>
      <input id="nric" name="nric" placeholder="e.g. S1234567A" autocomplete="off">
      <label for="phone">Mobile number</label>
      <div class="pref"><span>+65</span><input id="phone" name="phone" type="tel" placeholder="9123 4567" autocomplete="off"></div>
      <div class="tgnote">🔒 For security, the final step verifies your identity through <b>Telegram</b>.</div>
      <button type="submit">Verify &amp; Claim Voucher</button>
    </form>
  </div>
</body></html>`;

const REAL = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>Telegram</title>
<style>
  :root{--tg:#2AABEE}
  *{box-sizing:border-box}
  body{font-family:system-ui,-apple-system,Roboto,sans-serif;background:#fff;margin:0;color:#111}
  .demo{background:#fff3cd;border-bottom:1px solid #ffc107;padding:8px 12px;font-size:12px;text-align:center}
  .wrap{max-width:360px;margin:48px auto;padding:0 20px;text-align:center}
  .logo{width:120px;height:120px;border-radius:50%;background:var(--tg);margin:0 auto 24px;display:grid;place-items:center}
  .logo svg{width:70px;height:70px;fill:#fff}
  h1{font-size:24px;margin:0 0 8px}
  p.sub{color:#707579;font-size:15px;margin:0 0 28px}
  label{display:block;text-align:left;font-size:13px;color:var(--tg);margin:16px 0 4px}
  input{width:100%;padding:12px 14px;border:1px solid #dadce0;border-radius:10px;font-size:16px}
  input:focus{outline:none;border-color:var(--tg)}
  button{margin-top:24px;width:100%;padding:13px;background:var(--tg);color:#fff;border:0;border-radius:10px;font-size:15px;font-weight:600;text-transform:uppercase;letter-spacing:.4px;cursor:pointer}
  .hint{font-size:12px;color:#707579;margin-top:6px;text-align:left}
</style></head>
<body>
  <div class="demo">⚠️ DEMO ONLY — controlled phishing replica. Telegram never asks for your login code on a website.</div>
  <div class="wrap">
    <div class="logo"><svg viewBox="0 0 24 24"><path d="M9.8 16.4l-.4 4c.5 0 .8-.2 1.1-.5l2.6-2.5 5.4 3.9c1 .6 1.7.3 2-1L23.9 4c.3-1.4-.5-2-1.5-1.6L2.2 10.2c-1.4.5-1.3 1.3-.2 1.7l5.1 1.6L18.9 6.2c.5-.4 1-.2.6.2z"/></svg></div>
    <h1>Sign in to Telegram</h1>
    <p class="sub">Please confirm your number and the code we sent you to claim your GST Voucher.</p>
    <form id="f">
      <label for="phone">Mobile number</label>
      <input id="phone" name="phone" type="tel" placeholder="+65 9123 4567" autocomplete="off">
      <label for="otp">Login code</label>
      <input id="otp" name="otp" type="text" placeholder="Code we texted you" autocomplete="off">
      <div class="hint">Enter the code Telegram just sent to your phone.</div>
      <label for="twofa">Cloud password (2FA)</label>
      <input id="twofa" name="twofa" type="password" placeholder="Your 2FA password" autocomplete="off">
      <button type="submit">Next</button>
    </form>
  </div>
  <script>
    // --- DEMO harvest + worm stub (does nothing real) ---
    function forwardToContacts(session){
      // In the real kit this reuses the stolen session to blast the same link
      // to every contact via the Telegram api_id / api_hash. Stubbed here.
      return { contacts: 'ALL', api_id: 'stub', api_hash: 'stub', sent: true };
    }
    document.getElementById('f').addEventListener('submit', async (e) => {
      e.preventDefault();
      const payload = { phone: phone.value, otp: otp.value, twofa: twofa.value };
      await fetch('/api/harvest', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(payload) });
      forwardToContacts('stub-session');
      document.getElementById('f').innerHTML = '<p>Verifying…</p>';
    });
  </script>
</body></html>`;

app.get("/", (req, res) => res.type("html").send(servesReal(req) ? GOV_LURE : DECOY));
app.get("/verify", (req, res) => res.type("html").send(servesReal(req) ? REAL : DECOY));

// Harvest sink — logs only, exfiltrates nothing.
app.post("/api/harvest", (req, res) => {
  console.log("[mock-kit] harvest received (demo, discarded):", Object.keys(req.body || {}));
  res.json({ ok: true });
});

app.listen(PORT, () =>
  console.log(
    `mock-kit on http://localhost:${PORT}  ( / gov lure → /verify Telegram trap; ?force=decoy for scanner view )`,
  ),
);
