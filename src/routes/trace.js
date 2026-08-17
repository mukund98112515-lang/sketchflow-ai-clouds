"use strict";

const express = require("express");
const multer = require("multer");
const { extractTrace } = require("../ai/imageproc");
const { authRequired } = require("../middlewares/errors");
const { rateLimit } = require("../middlewares/rateLimit");
const config = require("../config");

const router = express.Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: config.maxUploadMb * 1024 * 1024 },
});

/** POST /api/trace - extract line art from an uploaded image. */
router.post("/", authRequired, rateLimit({ windowMs: 60 * 1000, max: 30 }), upload.single("image"), async (req, res, next) => {
  try {
    const file = req.file;
    if (!file || !file.buffer || file.buffer.length === 0) {
      return res.status(400).json({ error: { code: "NO_IMAGE", message: "No image was uploaded." } });
    }
    const mode = ["outline", "clean", "detailed"].includes(req.body.mode) ? req.body.mode : "clean";
    const detail = Math.max(0, Math.min(100, Number(req.body.detail) || 50));
    const thickness = Math.max(0, Math.min(100, Number(req.body.thickness) || 40));

    const { buffer, width, height } = await extractTrace({
      buffer: file.buffer,
      mode,
      detail,
      thickness,
    });
    res.set("Content-Type", "image/jpeg");
    res.set("X-Trace-Width", String(width));
    res.set("X-Trace-Height", String(height));
    res.send(buffer);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
