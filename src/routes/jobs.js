"use strict";

const express = require("express");
const { getJob } = require("../jobs/manager");
const { authRequired } = require("../middlewares/errors");

const router = express.Router();

/**
 * GET /api/jobs/:id — poll an in-memory generation job.
 * Returns status/progress/stage/message; once status === "completed" the
 * `result` field holds the full guide (steps with base64 images).
 */
router.get("/:id", authRequired, async (req, res, next) => {
  try {
    const job = getJob(req.params.id);
    if (!job) {
      return res.status(404).json({ error: { code: "NOT_FOUND", message: "Job not found. It may have expired — please generate again." } });
    }
    res.json(job);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
