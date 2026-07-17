import zlib from "node:zlib";
import type { DetonationResult, OcrResult, VisionResult } from "./types.ts";

// ── Minimal dependency-free PNG encoder (solid color) ───────────────
// Enough to produce real PNG bytes for Telegram sendPhoto in mock mode.
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

/** Solid RGBA PNG. Returns a Buffer of valid PNG bytes. */
export function makeSolidPng(width: number, height: number, rgb: [number, number, number]): Buffer {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type: truecolor
  const row = Buffer.alloc(1 + width * 3);
  for (let x = 0; x < width; x++) {
    row[1 + x * 3] = rgb[0];
    row[1 + x * 3 + 1] = rgb[1];
    row[1 + x * 3 + 2] = rgb[2];
  }
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  const idat = zlib.deflateSync(raw);
  return Buffer.concat([
    sig,
    chunk("IHDR", ihdr),
    chunk("IDAT", idat),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const decoyPng = makeSolidPng(160, 100, [200, 200, 200]).toString("base64");
const trapPng = makeSolidPng(160, 100, [40, 130, 210]).toString("base64");

// ── Canned evidence for USE_MOCKS + as fallbacks ────────────────────
export function mockDetonation(url: string): DetonationResult {
  return {
    finalUrl: url,
    redirectChain: [url, url + "/verify", url + "/login"],
    screenshotBase64: trapPng,
    decoyScreenshotBase64: decoyPng,
    cloakDetected: true,
    fields: [
      { name: "phone", type: "tel", placeholder: "+65 9123 4567", label: "Mobile number" },
      { name: "otp", type: "text", placeholder: "5-digit code", label: "Login code" },
      { name: "twofa", type: "password", placeholder: "Cloud password", label: "2FA password" },
    ],
    ajaxEndpoints: ["/api/harvest"],
    spreadSignals: ["contacts", "api_id", "api_hash", "forwardToContacts()"],
    capturedHarvestPayload: JSON.stringify({ phone: "+6591234567", otp: "00000", twofa: "test" }),
    timings: { scannerMs: 1200, sgMs: 2400 },
  };
}

export function mockVision(): VisionResult {
  return { brand: "Telegram", is_login_form: true, confidence: 0.98, source: "mock" };
}

export function mockOcr(): OcrResult {
  return {
    fullText: "Log in to Telegram\nEnter the code we sent to your phone\nMobile number\nLogin code\nCloud password (2FA)",
    evidenceLines: [
      "Enter the code we sent to your phone",
      "Cloud password (2FA)",
    ],
    source: "mock",
  };
}
