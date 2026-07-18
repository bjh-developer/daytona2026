// First-30-min GATE smoke tests. Run each once keys are in .env: npm run smoke
// Exits non-zero if a configured sponsor fails, so it doubles as a checklist.
import OpenAI from "openai";
import { config } from "../lib/config.ts";
import { smokeCurl } from "../lib/oxylabs.ts";

const ok = (m: string) => console.log(`  ✅ ${m}`);
const bad = (m: string) => console.log(`  ❌ ${m}`);
const skip = (m: string) => console.log(`  ⏭️  ${m}`);

let failures = 0;

// 1. Daytona egress — create sandbox, curl a NON-whitelisted host.
console.log("\n[1] Daytona egress (top risk)");
if (!config.daytona.apiKey) skip("DAYTONA_API_KEY unset");
else {
  try {
    const { Daytona } = await import("@daytona/sdk");
    const daytona = new Daytona({ apiKey: config.daytona.apiKey });
    const s = await daytona.create({ snapshot: config.daytona.snapshot }).catch(() => daytona.create());
    const r = await s.process.executeCommand(
      'curl -s -o /dev/null -w "%{http_code}" --max-time 8 https://api.ipify.org || echo BLOCKED',
    );
    const code = (r.result || "").trim();
    code === "200" ? ok(`egress OK (Tier 3/4), got ${code}`) : bad(`egress restricted (Tier 1/2?), got "${code}" → FALLBACK`);
    if (code !== "200") failures++;
    await s.delete().catch(() => {});
  } catch (e) {
    bad(`Daytona error: ${(e as Error).message}`);
    failures++;
  }
}

// 2. Oxylabs SG — printed as a curl (network/proxy from this host may differ from sandbox).
console.log("\n[2] Oxylabs SG exit — run this and expect country_code SG:");
console.log("   " + (config.oxylabs.user ? smokeCurl() : "(set OXYLABS_USER/PASS)"));

// 3/4/5. OpenAI-compatible endpoints — one tiny call each.
async function pingChat(name: string, baseURL: string, apiKey: string, model: string, vision = false) {
  console.log(`\n[${name}]`);
  if (!apiKey || !baseURL) return skip(`${name} not configured`);
  try {
    const client = new OpenAI({ baseURL, apiKey });
    const content = vision
      ? [
          { type: "text" as const, text: "Reply OK" },
          { type: "image_url" as const, image_url: { url: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==" } },
        ]
      : "Reply with the word OK";
    const res = await client.chat.completions.create({ model, max_tokens: 10, messages: [{ role: "user", content }] });
    ok(`${name} responded: ${JSON.stringify(res.choices[0].message.content).slice(0, 40)}`);
  } catch (e) {
    bad(`${name} error: ${(e as Error).message}`);
    failures++;
  }
}

await pingChat("ai& chat", config.aiand.baseUrl, config.aiand.apiKey, config.aiand.model);
await pingChat("Nosana vision", config.nosana.baseUrl, config.nosana.apiKey, config.nosana.model, true);
await pingChat("Doubleword OCR", config.doubleword.baseUrl, config.doubleword.apiKey, config.doubleword.model, true);

console.log(`\n${failures ? "❌" : "✅"} Gate: ${failures} failure(s).`);
process.exit(failures ? 1 : 0);
