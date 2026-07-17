// Shared contracts. Every lane integrates against these types — change here, not ad hoc.

/** A single input field found on the detonated page (the "harvest" surface). */
export interface HarvestField {
  name: string;
  type: string; // "tel" | "text" | "password" | ...
  placeholder?: string;
  label?: string;
}

/** Raw output of one detonation run against the target URL. Produced inside Daytona. */
export interface DetonationResult {
  finalUrl: string;
  redirectChain: string[];
  /** Screenshot from the SG-residential pass (the real page). base64 PNG, no data: prefix. */
  screenshotBase64: string;
  /** Screenshot from the no-proxy datacenter pass (what a scanner sees). base64 PNG. */
  decoyScreenshotBase64?: string;
  /** True when the two passes rendered materially different pages (cloak detected). */
  cloakDetected: boolean;
  fields: HarvestField[];
  ajaxEndpoints: string[];
  /** Strings matching contact-list / api_id / api_hash / spread stubs found in DOM+JS. */
  spreadSignals: string[];
  /** Captured harvest POST payload from the MOCK-ONLY active pass, if run. */
  capturedHarvestPayload?: string;
  timings?: Record<string, number>;
}

/** Nosana vision classifier output. */
export interface VisionResult {
  brand: string;
  is_login_form: boolean;
  confidence: number; // 0..1
  /** Which provider actually answered — "nosana" | "aiand-fallback" | "mock". */
  source: string;
}

/** Doubleword OCR output — literal text read off the screenshot. */
export interface OcrResult {
  fullText: string;
  /** Highlighted evidence lines, e.g. "Enter the code Telegram sent you". */
  evidenceLines: string[];
  source: string; // "doubleword" | "mock"
}

/** Final consumer verdict assembled by the orchestrator. */
export interface Verdict {
  level: "scam" | "suspicious" | "unknown" | "clean";
  headline: string; // "🚨 SCAM — this steals your Telegram login code"
  explanation: string; // plain-English worm explanation
  harvestedFields: string[]; // human labels: ["Phone number", "Login code (OTP)", "2FA password"]
  wormLine: string;
  /** How the verdict copy was produced — "aiand" | "template-fallback". */
  source: string;
}

/** The full payload the bot renders into a Telegram reply. */
export interface CheckResult {
  url: string;
  detonation: DetonationResult;
  vision: VisionResult;
  ocr?: OcrResult;
  verdict: Verdict;
  /** Provisional text-only guess returned before detonation completes. */
  provisional: { level: Verdict["level"]; reason: string };
}

/** Progress event streamed back to the bot so it can edit its status message. */
export interface ProgressEvent {
  step:
    | "extracting"
    | "creating-sandbox"
    | "detonating-scanner"
    | "detonating-sg"
    | "vision"
    | "verdict"
    | "done"
    | "error";
  label: string;
}

export type ProgressFn = (e: ProgressEvent) => void | Promise<void>;
