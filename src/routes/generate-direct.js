"use strict";

const express = require("express");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const multer = require("multer");
const Jimp = require("jimp");
const config = require("../config");
const logger = require("../logger");
const { getProvider } = require("../ai/providers");
const { buildPlan } = require("../ai/plan");
const { generateSteps } = require("../ai/imageproc");
const { validateUploadMeta, validateGuideResponse } = require("../ai/validate");
const { authRequired } = require("../middlewares/errors");
const { rateLimit } = require("../middlewares/rateLimit");

const router = express.Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: config.maxUploadMb * 1024 * 1024 },
});

const MIME_WHITELIST = [
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/webp",
  "image/bmp",
  "image/gif",
];

function saveTemp(originalName, buffer) {
  const ext = path.extname(originalName || "upload.bin") || ".bin";
  const name = `gen_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}${ext}`;
  const full = path.join(config.tmpDir, name);
  fs.writeFileSync(full, buffer);
  return full;
}

function deleteTemp(p) {
  try { if (p) fs.rmSync(p, { force: true }); } catch { /* ignore */ }
}

/**
 * Generate a guide using the deterministic sketch pipeline.
 * This always works — no external API key required.
 */
async function generateDeterministicGuide({ buffer, mode, stepCount, shading }) {
  const img = await Jimp.read(buffer);
  const { buildAnalysis } = require("../ai/imageproc");
  const analysis = buildAnalysis(img);

  const { plan } = await buildPlan(analysis, { mode, stepCount, shading, buffer });

  const { images } = await generateSteps({ buffer, mode, stepCount, shading, thickness: 1.3 });

  const steps = [];
  for (let i = 0; i < images.length; i++) {
    const imgStep = images[i];
    imgStep.quality(78);
    const buf = await imgStep.getBufferAsync(Jimp.MIME_JPEG);
    steps.push({
      stepNumber: i + 1,
      title: plan.steps[i].title,
      instruction: plan.steps[i].instruction,
      artistTip: plan.steps[i].tip || "",
      imageUrl: null,
    });
    images[i] = null;
  }

  const subjectType = (analysis.classification && analysis.classification.subjectType) || "general";

  return {
    title: plan.title,
    subjectType,
    mode,
    stepCount: steps.length,
    shading: !!shading,
    steps,
    generatedBy: "deterministic",
  };
}

/**
 * POST /api/generate-direct
 * Synchronous generation with automatic fallback.
 * xAI is OPTIONAL — the deterministic pipeline always works.
 *
 * Flow:
 *   1. If xAI provider exists: try xAI → fall back on any error
 *   2. If no provider: deterministic pipeline
 *   3. Deterministic pipeline always produces a valid guide
 *
 * Returns 200 { title, subjectType, mode, stepCount, shading, steps }.
 */
router.post(
  "/generate-direct",
  authRequired,
  rateLimit({ windowMs: config.rateLimitWindowMs, max: config.rateLimitGenerate }),
  upload.single("image"),
  async (req, res, next) => {
    let tempPath = null;
    try {
      const file = req.file;
      if (!file || !file.buffer || file.buffer.length === 0) {
        return res.status(400).json({ error: { code: "NO_IMAGE", message: "No image was uploaded." } });
      }
      if (!MIME_WHITELIST.includes(file.mimetype)) {
        return res.status(400).json({ error: { code: "UNSUPPORTED_IMAGE", message: "Unsupported file type." } });
      }

      const mode = String(req.body.mode || "detailed").toLowerCase();
      const stepCount = Number(req.body.stepCount || 8);
      const shading = req.body.shading === "true" || req.body.shading === "1" || req.body.shading === true;

      const validation = validateUploadMeta({
        mode,
        stepCount,
        shading,
        fileSize: file.buffer.length,
        maxSize: config.maxUploadMb * 1024 * 1024,
      });
      if (!validation.ok) {
        return res.status(400).json({ error: { code: "VALIDATION_FAILED", message: validation.errors.join("; ") } });
      }

      tempPath = saveTemp(file.originalname || "upload.bin", file.buffer);

      // ── Step 1: Try xAI provider if available ──────────────────────
      let guide = null;
      let usedXai = false;

      let provider;
      try {
        provider = getProvider();
      } catch (err) {
        logger.warn(`xAI provider init failed (falling back to deterministic): ${err.message}`);
        provider = null;
      }

      if (provider) {
        try {
          const base64Image = file.buffer.toString("base64");
          const mimeType = file.mimetype || "image/jpeg";
          guide = await provider.generateGuide({ base64Image, mimeType, mode, stepCount, shading });
          usedXai = true;
          logger.info(`xAI enhancement succeeded for generation`);
        } catch (err) {
          // xAI failed — log safely and fall through to deterministic
          logger.warn(`xAI enhancement unavailable: ${err.code || err.message}. Using deterministic guide.`);
          guide = null;
        }
      }

      // ── Step 2: Deterministic fallback (always works) ──────────────
      if (!guide) {
        try {
          guide = await generateDeterministicGuide({ buffer: file.buffer, mode, stepCount, shading });
          logger.info("Deterministic guide generated successfully");
        } catch (err) {
          logger.error(`Deterministic generation failed: ${err.message}`);
          return res.status(500).json({
            error: { code: "GENERATION_FAILED", message: "We couldn't generate your guide. Please try again." },
          });
        }
      }

      // ── Step 3: Validate and return ────────────────────────────────
      const guideValidation = validateGuideResponse(guide, { mode, stepCount, shading });
      if (!guideValidation.ok) {
        // If xAI result is invalid, retry with deterministic
        if (usedXai) {
          logger.warn(`xAI guide failed validation (${guideValidation.errors.join("; ")}). Retrying deterministic.`);
          try {
            guide = await generateDeterministicGuide({ buffer: file.buffer, mode, stepCount, shading });
            usedXai = false;
          } catch (err) {
            logger.error(`Deterministic fallback after validation failure also failed: ${err.message}`);
          }
        }
        // Re-validate
        const recheck = validateGuideResponse(guide, { mode, stepCount, shading });
        if (!recheck.ok) {
          return res.status(500).json({
            error: { code: "GENERATION_FAILED", message: "We couldn't generate your guide. Please try again." },
          });
        }
      }

      deleteTemp(tempPath);
      tempPath = null;

      // Strip internal metadata before sending to Android
      const response = { ...guide };
      delete response.generatedBy;
      res.json(response);
    } catch (err) {
      deleteTemp(tempPath);
      // Never expose provider internals to Android
      logger.error(`generate-direct error: ${err.message}`);
      res.status(500).json({
        error: { code: "GENERATION_FAILED", message: "We couldn't generate your guide. Please try again." },
      });
    }
  }
);

module.exports = router;
