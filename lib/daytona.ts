import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { config } from "./config.ts";
import { sgProxy } from "./oxylabs.ts";
import { mockDetonation } from "./mocks.ts";
import type { DetonationResult } from "./types.ts";

const WORKER_PATH = fileURLToPath(new URL("../detonation/worker.mjs", import.meta.url));

function parseWorkerOutput(stdout: string): DetonationResult {
  const m = stdout.match(/__DETONATION_JSON__([\s\S]*?)__END__/);
  if (!m) throw new Error("worker produced no DetonationResult JSON");
  return JSON.parse(m[1]) as DetonationResult;
}

/** Env the worker needs for a two-pass (scanner + SG) detonation. */
function workerEnv(url: string, active: boolean): Record<string, string> {
  const seed = `det${Date.now()}`;
  const sg = sgProxy(seed); // SG residential exit → the real page
  const scanner = sgProxy(seed + "s", config.oxylabs.scannerCountry); // non-SG → decoy
  // A remote proxy can never route to our own loopback — skip proxies for
  // localhost targets (dev convenience), never silently swallow them otherwise.
  const isLocalTarget = /^https?:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/i.test(url);
  const useProxy = !!config.oxylabs.user && !isLocalTarget;
  return {
    TARGET_URL: url,
    PROXY_SERVER: useProxy ? sg.server : "",
    PROXY_USER: sg.username,
    PROXY_PASS: sg.password,
    SCANNER_PROXY_SERVER: useProxy ? scanner.server : "",
    SCANNER_PROXY_USER: scanner.username,
    SCANNER_PROXY_PASS: scanner.password,
    ACTIVE_FILL: active ? "1" : "0",
    // Agent behavioral transcript (docs/nosana-finetuning.md §5). On by default —
    // the transcript is the evasion-proof input to the scam classifier. Observe-only
    // on non-mock targets (ACTIVE_FILL=0); the agent still records what it sees.
    CAPTURE_TRANSCRIPT: config.agent.captureTranscript ? "1" : "0",
    // LLM-driven agent loop. Defaults to ai&; the worker falls back to the
    // deterministic fill loop when the key is absent (mock-kit-only active fill).
    AGENT_LLM_BASE_URL: config.agent.llmBaseUrl,
    AGENT_LLM_API_KEY: config.agent.llmApiKey,
    AGENT_LLM_MODEL: config.agent.llmModel,
    AGENT_MAX_STEPS: String(config.agent.maxSteps),
  };
}

/**
 * Detonate a URL. Real work always runs locally (Playwright on this host) —
 * the hackathon Daytona org is Tier 1, which blocks ALL sandbox egress
 * org-wide (confirmed: curl, Oxylabs, Daytona's own preview-proxy domain,
 * and arbitrary fetch() all fail identically from inside a sandbox). No
 * per-sandbox override exists for that, so gating real detonation on the
 * sandbox would just mean gating it on a wall we can't get through in time.
 *
 * Daytona is still real and still called: `daytonaShowcase()` creates an
 * actual sandbox and proves it's alive for the pitch, without blocking or
 * slowing the real pipeline if it's flaky or the key is absent.
 */
export async function detonate(url: string, active = false): Promise<DetonationResult> {
  if (config.useMocks) return mockDetonation(url);
  return detonateLocally(url, active);
}

/**
 * Proof-of-life for judges: create a real Daytona sandbox, run a trivial
 * command, tear it down. Never throws — always resolves to a status the
 * bot/pitch can surface ("Daytona sandbox abc123 created ✅, Tier 1 blocks
 * this hackathon's live internet fetch, so detonation ran locally").
 */
export async function daytonaShowcase(): Promise<
  { ok: true; sandboxId: string } | { ok: false; reason: string }
> {
  if (!config.daytona.apiKey) return { ok: false, reason: "DAYTONA_API_KEY not set" };
  try {
    const { Daytona } = await import("@daytona/sdk");
    const daytona = new Daytona({ apiKey: config.daytona.apiKey });
    const sandbox = await daytona.create();
    try {
      await sandbox.process.executeCommand("echo isolated-and-alive", undefined, undefined, 10);
      return { ok: true, sandboxId: sandbox.id };
    } finally {
      await sandbox.delete().catch(() => {});
    }
  } catch (err) {
    return { ok: false, reason: (err as Error).message };
  }
}

/** Real detonation: run Playwright on this host. Requires `npx playwright install chromium`. */
function detonateLocally(url: string, active: boolean): Promise<DetonationResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [WORKER_PATH], {
      env: { ...process.env, ...workerEnv(url, active) },
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("close", (code) => {
      try {
        resolve(parseWorkerOutput(out));
      } catch (e) {
        reject(new Error(`local worker exit ${code}: ${err || (e as Error).message}`));
      }
    });
  });
}
