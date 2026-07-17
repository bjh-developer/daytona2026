import { readFile } from "node:fs/promises";
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
  const p = sgProxy(`det${Date.now()}`);
  return {
    TARGET_URL: url,
    PROXY_SERVER: config.oxylabs.user ? p.server : "",
    PROXY_USER: p.username,
    PROXY_PASS: p.password,
    ACTIVE_FILL: active ? "1" : "0",
  };
}

/**
 * Detonate a URL: two passes (datacenter decoy + SG-residential real), isolated.
 * Priority: mock → Daytona sandbox → local child process (egress-blocked fallback).
 * `active` fills dummy values + captures the harvest POST — MOCK KIT ONLY.
 */
export async function detonate(url: string, active = false): Promise<DetonationResult> {
  if (config.useMocks) return mockDetonation(url);
  if (config.daytona.apiKey) return detonateInSandbox(url, active);
  return detonateLocally(url, active);
}

async function detonateInSandbox(url: string, active: boolean): Promise<DetonationResult> {
  const { Daytona } = await import("@daytonaio/sdk");
  const daytona = new Daytona({ apiKey: config.daytona.apiKey });
  // DAYTONA_SNAPSHOT is the pre-built image name (Playwright+Chromium baked in).
  const sandbox = await daytona.create({ image: config.daytona.snapshot });
  try {
    const worker = await readFile(WORKER_PATH);
    await sandbox.fs.uploadFile(worker, "/tmp/worker.mjs");
    const res = await sandbox.process.executeCommand(
      "node /tmp/worker.mjs",
      undefined,
      workerEnv(url, active),
      90,
    );
    return parseWorkerOutput(res.result ?? "");
  } finally {
    await sandbox.delete().catch(() => {});
  }
}

/** Fallback: run Playwright on this host. Requires `npx playwright install chromium`. */
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
