import { config } from "./config.ts";

export interface ProxyConfig {
  server: string;
  username: string;
  password: string;
}

/**
 * Build a Playwright/HTTP proxy config for an Oxylabs residential exit.
 * Username format: customer-USER-cc-SG[-sessid-<id>] pins the exit country
 * and (with sessid) holds one IP across a multi-step load.
 */
export function sgProxy(sessionId?: string): ProxyConfig {
  const { user, pass, host, port, country } = config.oxylabs;
  let username = `customer-${user}-cc-${country}`;
  if (sessionId) username += `-sessid-${sessionId}-sesstime-10`;
  return { server: `http://${host}:${port}`, username, password: pass };
}

/** curl args to smoke-test the SG exit (gate item 2). */
export function smokeCurl(): string {
  const { user, pass, host, port, country } = config.oxylabs;
  return `curl -x ${host}:${port} -U "customer-${user}-cc-${country}:${pass}" https://ip.oxylabs.io/location`;
}
