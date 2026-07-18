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
  /**
   * Agent behavioral transcript (observed state → actions → captured POSTs → state changes).
   * Only present when the worker runs with CAPTURE_TRANSCRIPT=1. Behavioral signals are
   * evasion-proof (a kit must POST credentials to harvest them) — see docs/nosana-finetuning.md §5.
   */
  agentTranscript?: AgentTranscript;
}

/** One step in the agent's behavioral transcript. */
export interface TranscriptStep {
  /** "observed" = initial page state; "action" = fill/click; "observed_after" = post-action state. */
  kind: "observed" | "action" | "observed_after";
  /** Short label, e.g. "fill textbox 'Mobile number' with '+6591234567'". */
  label: string;
  /** Optional structured detail (captured POST URL+body, page text change, a11y tree). */
  detail?: string;
}

/** Full behavioral transcript of a detonation pass — the evasion-proof input to the scam classifier. */
export interface AgentTranscript {
  goal: string;
  steps: TranscriptStep[];
  /** Domain + brand context the model reasons over. */
  context: {
    domain: string;
    claimed_brand?: string;
    real_brand_domain?: string;
    /** e.g. "Telegram never asks for login codes on a website." */
    brand_note?: string;
  };
}

/** Taxonomy for offline corpus labeling (metadata, not the model output schema). */
export type ScamType =
  | "government_impersonation"
  | "telegram_login_clone"
  | "meme_scam"
  | "legitimate";

/**
 * Scam verdict from the transcript classifier (docs/nosana-finetuning.md §5.1).
 * This is signal #6 of 8 — augments the deterministic signals 1-5 in verdict.ts.
 */
export interface ScamVerdict {
  is_scam: boolean;
  brand_impersonated: string;
  /** Behavioral evidence strings, e.g. "POSTs credentials to /api/harvest". */
  evidence: string[];
  confidence: number; // 0..1
  explanation: string;
  /** Which provider answered — "few-shot" | "fine-tuned" | "heuristic" | "mock". */
  source: string;
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
  /** Signal #6: transcript-based scam classification (evasion-proof). Optional — only when agentTranscript present. */
  scamClassification?: ScamVerdict;
  /** Provisional text-only guess returned before detonation completes. */
  provisional: { level: Verdict["level"]; reason: string };
  /** Daytona proof-of-life for the pitch — real sandbox created, or why not. */
  daytona: { ok: true; sandboxId: string } | { ok: false; reason: string };
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

/**
 * One labeled example in the scam-detection training corpus.
 * The transcript is rendered to the doc §6.3 chat-template format at training time;
 * the assistant response is the raw JSON string of `ground_truth`.
 */
export interface TrainingExample {
  id: string;
  source_url: string;
  /** Metadata label for offline analysis (not the model output schema). */
  scam_type: ScamType;
  transcript: AgentTranscript;
  /** Ground-truth model output — serialized to a raw JSON string in training data. */
  ground_truth: ScamVerdict;
  captured_at: string; // ISO timestamp
}
