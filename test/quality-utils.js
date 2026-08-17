"use strict";

/**
 * Shared quality metrics for the tutorial step images. Pure functions on
 * decoded Jimp images / buffers — used by both the review harness and the
 * automated quality tests.
 */

const Jimp = require("jimp");

/** Luminance array (0..1) for a Jimp image. */
function lumOf(img) {
  const { data, width, height } = img.bitmap;
  const n = width * height;
  const out = new Float32Array(n);
  for (let i = 0, p = 0; i < n; i++, p += 4) {
    out[i] = (0.299 * data[p] + 0.587 * data[p + 1] + 0.114 * data[p + 2]) / 255;
  }
  return { lum: out, width, height };
}

async function lumOfBuffer(buf) {
  const img = await Jimp.read(buf);
  return { img, ...lumOf(img) };
}

/** Fraction of pixels darker than `t`. */
function darkFraction(lum, t = 0.85) {
  let c = 0;
  for (let i = 0; i < lum.length; i++) if (lum[i] < t) c++;
  return c / lum.length;
}

function meanLum(lum) {
  let s = 0;
  for (let i = 0; i < lum.length; i++) s += lum[i];
  return s / lum.length;
}

/** Mean absolute luminance difference between two aligned lum arrays. */
function meanDiff(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += Math.abs(a[i] - b[i]);
  return s / a.length;
}

/** Structural difference: correlation-based (0 = identical, 1 = unrelated). */
function structuralDiff(a, b) {
  let ma = 0;
  let mb = 0;
  for (let i = 0; i < a.length; i++) {
    ma += a[i];
    mb += b[i];
  }
  ma /= a.length;
  mb /= b.length;
  let num = 0;
  let da = 0;
  let db = 0;
  for (let i = 0; i < a.length; i++) {
    const xa = a[i] - ma;
    const xb = b[i] - mb;
    num += xa * xb;
    da += xa * xa;
    db += xb * xb;
  }
  const denom = Math.sqrt(da * db);
  if (denom === 0) return 0;
  return 1 - num / denom;
}

/** Edge density of an image: fraction of pixels with strong local gradient. */
function edgeDensity(lum, width, height, thresh = 0.12) {
  let c = 0;
  let n = 0;
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const i = y * width + x;
      const gx = lum[i + 1] - lum[i - 1];
      const gy = lum[i + width] - lum[i - width];
      if (Math.sqrt(gx * gx + gy * gy) > thresh) c++;
      n++;
    }
  }
  return n ? c / n : 0;
}

/**
 * Compute the full metric set for a set of aligned step buffers.
 * Returns: { steps: [{meanLum, inkLight, inkDark, edgeDensity}],
 *            adj: [{step, meanDiff, structuralDiff, tooSimilar}],
 *            flags: [] }
 */
async function metricsForSteps(buffers) {
  const decoded = [];
  for (const b of buffers) decoded.push(await lumOfBuffer(b));
  const dims = decoded.map((d) => `${d.width}x${d.height}`);
  const steps = decoded.map((d) => ({
    meanLum: meanLum(d.lum),
    inkLight: darkFraction(d.lum, 0.88),
    inkDark: darkFraction(d.lum, 0.6),
    edgeDensity: edgeDensity(d.lum, d.width, d.height),
  }));
  const adj = [];
  for (let i = 1; i < decoded.length; i++) {
    const md = meanDiff(decoded[i - 1].lum, decoded[i].lum);
    const sd = structuralDiff(decoded[i - 1].lum, decoded[i].lum);
    adj.push({
      step: i,
      meanDiff: md,
      structuralDiff: sd,
      // Line art on soft photos shifts few pixels per step, so a transition
      // is only "too similar" when the luminance AND the structure both
      // barely move (two near-identical screenshots).
      tooSimilar: md < 0.007 && sd < 0.12,
    });
  }
  return { dims: [...new Set(dims)], steps, adj };
}

/** Human-readable flag list for a metric set. */
function flagsFor(metrics, opts = {}) {
  const flags = [];
  const blankInk = opts.blankInk || 0.0004;
  const blackInk = opts.blackInk || 0.45;
  for (let i = 0; i < metrics.steps.length; i++) {
    const s = metrics.steps[i];
    if (s.inkDark < blankInk && s.meanLum > 0.99) flags.push(`step ${i + 1} BLANK (inkDark=${s.inkDark.toFixed(5)})`);
    if (s.inkDark > blackInk) flags.push(`step ${i + 1} OVERBLACK (inkDark=${(100 * s.inkDark).toFixed(1)}%)`);
  }
  for (const a of metrics.adj) {
    if (a.tooSimilar) flags.push(`step ${a.step}->${a.step + 1} TOO SIMILAR (meanDiff=${a.meanDiff.toFixed(4)})`);
  }
  // Monotonicity: the final step should carry at least as much dark ink as the
  // 2nd step (allow some tolerance), and step 2 should be simpler than final.
  const n = metrics.steps.length;
  if (n >= 4) {
    const s2 = metrics.steps[1];
    const sf = metrics.steps[n - 1];
    if (sf.inkDark < s2.inkDark - 0.005) {
      flags.push(`REGRESSION: final (${sf.inkDark.toFixed(4)}) has less dark ink than step 2 (${s2.inkDark.toFixed(4)})`);
    }
  }
  return flags;
}

module.exports = { lumOf, lumOfBuffer, darkFraction, meanLum, meanDiff, structuralDiff, edgeDensity, metricsForSteps, flagsFor };
