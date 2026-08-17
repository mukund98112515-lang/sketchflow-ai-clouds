"use strict";

/* ------------------------------------------------------------------ */
/* Stateless, in-memory generation job manager.                        */
/*                                                                     */
/* No database, no object storage, no durable disk state. A job lives  */
/* only in a Map for the lifetime of the request; the Android app      */
/* polls GET /api/jobs/:id until the guide is ready, then saves it     */
/* locally. If Render restarts, jobs disappear and the app simply      */
/* retries generation.                                                 */
/* ------------------------------------------------------------------ */

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const config = require("../config");
const logger = require("../logger");
const Jimp = require("jimp");
const { generateSteps } = require("../ai/imageproc");
const { buildPlan } = require("../ai/plan");
const { validateTutorial, ALLOWED_STEP_COUNTS } = require("../ai/validate");

const now = () => Date.now();

const jobs = new Map(); // id -> job record (transient)
let activeJobs = 0;
const waiters = [];

/* ------------------------------------------------------------------ */
/* Job record helpers                                                  */
/* ------------------------------------------------------------------ */

function makeJob(id, params) {
  return {
    id,
    status: "queued",
    stage: "queued",
    progress: 0,
    message: "Queued",
    errorCode: null,
    result: null,
    params,
    createdAt: now(),
    updatedAt: now(),
    finishedAt: null,
  };
}

/** Public view of a job (safe to return over the wire). */
function getJob(id) {
  const j = jobs.get(id);
  if (!j) return null;
  return {
    jobId: j.id,
    status: j.status,
    progress: j.progress,
    stage: j.stage,
    message: j.message,
    errorCode: j.errorCode,
    result: j.result, // present only when status === "completed"
    createdAt: j.createdAt,
    updatedAt: j.updatedAt,
  };
}

function updateJob(id, fields) {
  const j = jobs.get(id);
  if (!j) return;
  for (const k of ["status", "stage", "progress", "message", "errorCode", "result", "finishedAt"]) {
    if (fields[k] !== undefined) j[k] = fields[k];
  }
  j.updatedAt = now();
}

/* ------------------------------------------------------------------ */
/* Pipeline (the verified sketch engine)                               */
/* ------------------------------------------------------------------ */

async function runGeneration(jobId, upload, params) {
  const stepCount = ALLOWED_STEP_COUNTS.includes(Number(params.stepCount)) ? Number(params.stepCount) : 8;
  const thickness = Number(params.thickness) || 1.3;

  updateJob(jobId, { status: "analyzing", stage: "analyzing", progress: 10, message: "Analyzing image..." });

  // 1) Analysis.
  const rawBuf = fs.readFileSync(upload.path);
  const img = await Jimp.read(rawBuf);
  const { buildAnalysis } = require("../ai/imageproc");
  const analysis = buildAnalysis(img);

  // 2) Plan (subject-aware, deterministic; optional LLM enhancement).
  updateJob(jobId, { status: "planning", stage: "planning", progress: 35, message: "Creating drawing steps..." });
  const { plan } = await buildPlan(analysis, {
    mode: params.mode,
    stepCount,
    shading: params.shading,
    buffer: rawBuf,
  });

  // 3) Progressive sketch steps (real stages, not duplicated edges).
  updateJob(jobId, { status: "rendering", stage: "rendering", progress: 45, message: "Rendering sketch steps..." });
  const { images } = await generateSteps({
    buffer: rawBuf,
    mode: params.mode,
    stepCount,
    shading: params.shading,
    thickness,
  });

  // 4) Encode step images to base64 data URLs, one at a time, releasing each
  //    Jimp bitmap for GC so the free instance never holds every step at once.
  updateJob(jobId, { status: "finishing", stage: "finishing", progress: 80, message: "Finishing guide..." });
  const steps = [];
  const stepSizes = [];
  for (let i = 0; i < images.length; i++) {
    const imgStep = images[i];
    imgStep.quality(78);
    const buf = await imgStep.getBufferAsync(Jimp.MIME_JPEG);
    steps.push({
      stepNumber: i + 1,
      title: plan.steps[i].title,
      instruction: plan.steps[i].instruction,
      artistTip: plan.steps[i].tip || "",
      image: `data:image/jpeg;base64,${buf.toString("base64")}`,
    });
    stepSizes.push(buf.length);
    images[i] = null; // release bitmap
    updateJob(jobId, {
      progress: 80 + Math.round(((i + 1) / images.length) * 18),
      message: "Finishing guide...",
    });
  }

  const validation = validateTutorial({ plan, stepCount, images: stepSizes.map((len) => ({ length: len })) });
  if (!validation.ok) {
    throw Object.assign(new Error(`Generated tutorial failed validation: ${validation.errors.join("; ")}`), {
      code: "VALIDATION_FAILED",
    });
  }

  const subjectType = (analysis.classification && analysis.classification.subjectType) || "general";
  const result = {
    title: plan.title,
    subjectType,
    subjectLabel: plan.subjectLabel || null,
    mode: params.mode,
    stepCount,
    shading: !!params.shading,
    steps,
  };

  updateJob(jobId, {
    status: "completed",
    progress: 100,
    stage: "completed",
    message: "Guide ready",
    result,
    finishedAt: now(),
  });

  logger.info(`guide generated: job ${jobId} (${subjectType}, ${stepCount} steps)`);
  return { tutorialId: jobId };
}

/* ------------------------------------------------------------------ */
/* Execution with bounded concurrency + light retry                    */
/* ------------------------------------------------------------------ */

const MAX_ATTEMPTS = 2;
const BACKOFF_MS = 1500;

async function executeWithRetry(jobId, upload, params) {
  let attempt = 1;
  for (;;) {
    try {
      await runGeneration(jobId, upload, params);
      return;
    } catch (err) {
      const code = err.code || "GENERATION_FAILED";
      const transient = ["ECONNRESET", "ETIMEDOUT", "EAI_AGAIN"].includes(code) || /socket|timeout|network/i.test(String(err.message));
      if (transient && attempt < MAX_ATTEMPTS) {
        updateJob(jobId, { status: "queued", progress: 0, stage: "retrying", message: `Retrying (attempt ${attempt + 1})...` });
        logger.warn(`job ${jobId} transient failure, retrying: ${err.message}`);
        await new Promise((r) => setTimeout(r, BACKOFF_MS));
        attempt++;
        continue;
      }
      updateJob(jobId, {
        status: "failed",
        stage: "failed",
        progress: 0,
        message: err.expose ? err.message : err.message || "Generation failed",
        errorCode: code,
        finishedAt: now(),
      });
      logger.error(`job ${jobId} failed: ${err.message}`);
      return;
    }
  }
}

async function runJob(jobId, upload, params) {
  while (activeJobs >= config.jobConcurrency) {
    await new Promise((resolve) => waiters.push(resolve));
  }
  activeJobs++;
  try {
    await executeWithRetry(jobId, upload, params);
  } catch (err) {
    try {
      updateJob(jobId, {
        status: "failed",
        stage: "failed",
        errorCode: "GENERATION_FAILED",
        message: err.message || "Generation failed",
        finishedAt: now(),
      });
    } catch {
      /* ignore */
    }
  } finally {
    // Remove every ephemeral scratch file for this request.
    for (const p of upload.paths || []) {
      try {
        fs.rmSync(p, { force: true });
      } catch {
        /* ignore */
      }
    }
    activeJobs--;
    const next = waiters.shift();
    if (next) next();
  }
}

/**
 * Create a generation job. `upload` = { paths: [tempFile] }. Returns
 * { jobId, status, duplicate }. Throws SERVER_BUSY when the queue is full.
 */
async function createJob({ requestId, upload, params, userId }) {
  // Duplicate-request protection: the same idempotency key maps to the same
  // in-memory job (whether still running, completed, or failed), so a retry
  // never spawns a second generation and simply re-uses the existing result.
  if (requestId) {
    const existing = jobs.get(requestId);
    if (existing) {
      return { jobId: existing.id, status: existing.status, duplicate: true };
    }
  }

  if (activeJobs >= config.jobConcurrency && waiters.length >= config.maxQueue) {
    const err = new Error("Server is busy. Please try again shortly.");
    err.code = "SERVER_BUSY";
    err.expose = true;
    throw err;
  }

  const jobId = requestId || `job_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`;
  jobs.set(jobId, makeJob(jobId, params));
  logger.info(`generation job created: ${jobId} (mode=${params.mode} steps=${params.stepCount} shading=${params.shading})`);

  // Fire-and-forget processing (bounded by the concurrency semaphore).
  runJob(jobId, upload, { ...params, userId });

  return { jobId, status: "queued" };
}

/* ------------------------------------------------------------------ */
/* Housekeeping (memory + temp files)                                  */
/* ------------------------------------------------------------------ */

async function cleanupStaleJobs() {
  const cutoff = now() - config.cleanupJobAgeMs;
  for (const [id, j] of jobs) {
    if (j.finishedAt && j.finishedAt < cutoff) jobs.delete(id);
  }
  // Hard cap so the Map can never grow without bound under heavy use.
  const finished = [...jobs.values()].filter((j) => j.finishedAt).sort((a, b) => a.finishedAt - b.finishedAt);
  while (finished.length > 300) {
    jobs.delete(finished.shift().id);
  }

  // Sweep stale scratch files left by a crash mid-generation.
  try {
    for (const f of fs.readdirSync(config.tmpDir)) {
      const full = path.join(config.tmpDir, f);
      try {
        const st = fs.statSync(full);
        if (st.isFile() && now() - st.mtimeMs > config.cleanupJobAgeMs) {
          fs.rmSync(full, { force: true });
        }
      } catch {
        /* ignore */
      }
    }
  } catch {
    /* tmp dir may not exist */
  }
}

module.exports = { createJob, getJob, updateJob, cleanupStaleJobs, runGeneration };
