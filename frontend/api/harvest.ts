// DEMO harvest sink — a Vercel serverless function so /api/harvest returns 200
// instead of 404. Stores nothing, logs nothing sensitive. The captured
// credentials are fake and are only ever read off the wire by our own
// detonation engine; this endpoint just closes the loop realistically.
export const config = { runtime: "nodejs" };

export default function handler(
  req: { method?: string },
  res: {
    status: (code: number) => { json: (body: unknown) => void; end: () => void };
    setHeader: (k: string, v: string) => void;
  },
) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "method not allowed" });
    return;
  }
  // Acknowledge like the real kit would, discard everything.
  res.status(200).json({ ok: true });
}
