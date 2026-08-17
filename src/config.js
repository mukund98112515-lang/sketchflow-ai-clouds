"use strict";

const path = require("path");
const os = require("os");
const fs = require("fs");

const ROOT = path.resolve(__dirname, "..");

// The stateless backend keeps NO durable state on the server disk. The only
// folder it uses is an EPHEMERAL scratch dir (os tmp) for in-flight image
// files, which are deleted as soon as a request finishes.
const TMP_DIR = process.env.TMP_DIR || path.join(os.tmpdir(), "sketchflow-tmp");
fs.mkdirSync(TMP_DIR, { recursive: true });

function bool(v, def) {
  if (v === undefined || v === null || v === "") return def;
  return String(v).toLowerCase() === "true" || v === "1";
}

const nodeEnv = process.env.NODE_ENV || "development";
const isProduction = nodeEnv === "production";

const config = {
  nodeEnv,
  isProduction,

  port: parseInt(process.env.PORT || "8787", 10),
  host: process.env.HOST || "0.0.0.0",
  tmpDir: TMP_DIR,

  // Public base URL (used only for logs/display now — guides are returned
  // inline to the app, so no absolute image URLs are generated).
  baseUrl: (process.env.PUBLIC_BASE_URL || process.env.BACKEND_URL || `http://localhost:${process.env.PORT || "8787"}`).replace(/\/$/, ""),

  // AI provider configuration. xAI is the optional enhancement provider.
  // XAI_ENABLED=false (default) = deterministic-only, ₹0/$0 cost.
  // XAI_ENABLED=true + valid key = optional AI enhancement with fallback.
  xaiEnabled: bool(process.env.XAI_ENABLED, false),
  aiProvider: process.env.AI_PROVIDER || "xai",
  aiProviderExplicit: !!process.env.AI_PROVIDER,
  aiApiKey: process.env.AI_API_KEY || "",
  xaiApiKey: process.env.XAI_API_KEY || "",
  aiModel: process.env.AI_MODEL || "",
  aiBaseUrl: process.env.AI_BASE_URL || "",

  // Optional bearer-token auth for the API. Empty disables it.
  authToken: process.env.AUTH_TOKEN || "",

  // Generation endpoint protection (free-tier safety).
  rateLimitGenerate: parseInt(process.env.RATE_LIMIT_GENERATE || "8", 10),
  rateLimitWindowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS || 5 * 60 * 1000, 10),

  maxUploadMb: parseInt(process.env.MAX_UPLOAD_MB || "10", 10),
  maxImageDim: parseInt(process.env.MAX_IMAGE_DIM || "1536", 10),
  allowCleartext: bool(process.env.ALLOW_CLEARTEXT, !isProduction),

  // In-memory job housekeeping. Jobs are transient and may vanish on restart —
  // that is fine, the Android app simply retries generation.
  cleanupJobAgeMs: parseInt(process.env.CLEANUP_JOB_AGE_MS || 10 * 60 * 1000, 10),
  cleanupIntervalMs: parseInt(process.env.CLEANUP_INTERVAL_MS || 2 * 60 * 1000, 10),

  // Concurrency: 1 active generation at a time keeps the free instance alive.
  jobConcurrency: Math.max(1, parseInt(process.env.JOB_CONCURRENCY || "1", 10)),
  // Waiting jobs allowed before rejecting with SERVER_BUSY.
  maxQueue: Math.max(0, parseInt(process.env.MAX_QUEUE || "5", 10)),

  // Image processing tuning (used by the verified pipeline).
  sketchThickness: parseFloat(process.env.SKETCH_THICKNESS || "1.0"),
  sketchPaper: process.env.SKETCH_PAPER || "#fbf9f5",
};

module.exports = config;
