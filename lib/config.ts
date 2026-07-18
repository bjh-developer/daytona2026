import "dotenv/config";

const bool = (v: string | undefined, def = false) =>
  v == null ? def : /^(1|true|yes)$/i.test(v.trim());

export const config = {
  useMocks: bool(process.env.USE_MOCKS, true),
  mockKitUrl: process.env.MOCK_KIT_URL || "http://localhost:8080",

  telegram: {
    token: process.env.TELEGRAM_BOT_TOKEN || "",
  },
  daytona: {
    apiKey: process.env.DAYTONA_API_KEY || "",
    snapshot: process.env.DAYTONA_SNAPSHOT || "det-playwright",
  },
  oxylabs: {
    user: process.env.OXYLABS_USER || "",
    pass: process.env.OXYLABS_PASS || "",
    host: process.env.OXYLABS_HOST || "pr.oxylabs.io",
    port: Number(process.env.OXYLABS_PORT || 7777),
    country: process.env.OXYLABS_COUNTRY || "SG",
    // Non-SG exit for the scanner pass, so the "datacenter view" is foreign
    // even when the detonation runs from within Singapore.
    scannerCountry: process.env.OXYLABS_SCANNER_COUNTRY || "US",
  },
  aiand: {
    apiKey: process.env.AIAND_API_KEY || "",
    baseUrl: process.env.AIAND_BASE_URL || "https://api.aiand.com/v1",
    model: process.env.AIAND_MODEL || "deepseek-ai/deepseek-v4-flash",
    visionModel: process.env.AIAND_VISION_MODEL || "moonshotai/kimi-k2.6",
  },
  nosana: {
    baseUrl: process.env.NOSANA_BASE_URL || "",
    apiKey: process.env.NOSANA_API_KEY || "placeholder",
    model: process.env.NOSANA_MODEL || "qwen2.5-vl",
    // Text model Nosana serves for transcript-based scam analysis
    // (docs/nosana-finetuning.md §5.3). Distinct from the VL `qwen2.5-vl`.
    textModel: process.env.NOSANA_TEXT_MODEL || "qwen2.5-7b-instruct",
    forceFallback: bool(process.env.NOSANA_FALLBACK, false),
  },
  // LLM-driven browser agent (docs/nosana-finetuning.md §5). Decides fill/click/done
  // from the page's a11y tree + visible text. Defaults to ai& so it works with the
  // existing key; override via AGENT_LLM_* to point at a different OpenAI-compatible endpoint.
  agent: {
    llmBaseUrl: process.env.AGENT_LLM_BASE_URL || process.env.AIAND_BASE_URL || "https://api.aiand.com/v1",
    llmApiKey: process.env.AGENT_LLM_API_KEY || process.env.AIAND_API_KEY || "",
    llmModel: process.env.AGENT_LLM_MODEL || process.env.AIAND_MODEL || "deepseek-ai/deepseek-v4-flash",
    maxSteps: Number(process.env.AGENT_MAX_STEPS || 6),
    // Record a behavioral transcript even when active fill is off (observe-only).
    captureTranscript: bool(process.env.CAPTURE_TRANSCRIPT, true),
  },
  doubleword: {
    apiKey: process.env.DOUBLEWORD_API_KEY || "",
    baseUrl: process.env.DOUBLEWORD_BASE_URL || "https://api.doubleword.ai/v1",
    model: process.env.DOUBLEWORD_MODEL || "DeepSeek-OCR-2",
  },
};

export type Config = typeof config;
