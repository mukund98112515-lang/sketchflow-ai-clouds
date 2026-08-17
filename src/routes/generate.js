"use strict";

const express = require("express");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const multer = require("multer");
const config = require("../config");
const { createJob } = require("../jobs/manager");
const { validateUploadMeta } = require("../ai/validate");
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

/** Write an uploaded buffer to an ephemeral scratch file (deleted after use). */
function saveTemp(originalName, buffer) {
  const ext = path.extname(originalName || "upload.bin") || ".bin";
  const name = `gen_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}${ext}`;
  const full = path.join(config.tmpDir, name);
  fs.writeFileSync(full, buffer);
  return full;
}

/**
 * POST /api/generate-guide
 * multipart/form-data: image, mode (easy|detailed|realistic),
 * stepCount (6|8|10|12), shading (true|false), optional requestId, thickness.
 * Returns 202 { jobId, status, duplicate }. Poll GET /api/jobs/:id for the
 * complete guide (steps with base64 images) once status === "completed".
 */
router.post(
  "/generate-guide",
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
        return res.status(400).json({ error: { code: "UNSUPPORTED_IMAGE", message: "Unsupported file type. Please upload a JPEG, PNG, WebP, BMP or GIF photo." } });
      }

      const mode = String(req.body.mode || "detailed").toLowerCase();
      const stepCount = Number(req.body.stepCount || 8);
      const shading = req.body.shading === "true" || req.body.shading === "1" || req.body.shading === true;
      const thickness = Number(req.body.thickness) || 1.3;
      const requestId = String(req.body.requestId || req.headers["x-request-id"] || "").slice(0, 64);

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

      // Move the uploaded bytes to an ephemeral scratch file for the worker.
      tempPath = saveTemp(file.originalname || "upload.bin", file.buffer);

      const { jobId, status, duplicate } = await createJob({
        requestId,
        upload: { path: tempPath, paths: [tempPath] },
        params: { mode, stepCount, shading, thickness },
      });

      if (duplicate) {
        // The existing job already owns its own scratch file; release ours.
        try {
          fs.rmSync(tempPath, { force: true });
        } catch {
          /* ignore */
        }
      }

      res.status(202).json({ jobId, status, duplicate: !!duplicate });
    } catch (err) {
      if (tempPath) {
        try {
          fs.rmSync(tempPath, { force: true });
        } catch {
          /* ignore */
        }
      }
      next(err);
    }
  }
);

module.exports = router;
