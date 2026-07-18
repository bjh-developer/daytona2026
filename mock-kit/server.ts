// Mock phishing kit — DEMO ONLY. Backend-only handler for the demo harvest endpoint.
// The React frontend now owns the UI and is served from the frontend app.
import express from "express";

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const PORT = Number(process.env.PORT || 8081);

/** Cloak decision. Vercel sets x-vercel-ip-country; locally use ?geo/?force. */
function servesReal(req: express.Request): boolean {
  const force = String(req.query.force || "");
  if (force === "real") return true;
  if (force === "decoy") return false;
  const country = String(req.header("x-vercel-ip-country") || req.query.geo || "").toUpperCase();
  if (country) return country === "SG";
  return true; // no geo signal (local UI dev) → show the real page
}

// Optional cloak passthrough: the frontend can read query params from the URL and
// decide whether to show the real or decoy experience.
app.get("/cloak-status", (req, res) => {
  res.json({ servesReal: servesReal(req) });
});

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
