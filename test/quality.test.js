"use strict";
const assert = require("assert");
const path = require("path");
const fs = require("fs");
const Jimp = require("jimp");
const { generateSteps, buildAnalysis } = require("../src/ai/imageproc");
const { buildPlan } = require("../src/ai/plan");
const { metricsForSteps, flagsFor } = require("./quality-utils");
const { makePortrait } = require("./make-image.js");

const ASSETS = [
  ["portrait-front.jpg", "portrait"],
  ["portrait-profile.jpg", "portrait"],
  ["animal.jpg", "animal"],
  ["car.jpg", "vehicle"],
  ["object.jpg", "object"],
  ["landscape.jpg", "landscape"],
  ["complex.jpg", "general"],
];

async function main() {
  // 1) Subject classification matrix on the 7 real photos.
  for (const [f, expect] of ASSETS) {
    const img = await Jimp.read(path.join(__dirname, "assets", f));
    const a = buildAnalysis(img);
    assert.equal(a.classification.subjectType, expect, `${f} should classify as ${expect}`);
  }
  console.log(`PASS classification matrix: ${ASSETS.length} assets`);

  // 2) Stylized/flat portrait through the fallback path.
  const syn = await Jimp.read(await makePortrait());
  const synA = buildAnalysis(syn);
  assert.equal(synA.classification.subjectType, "portrait", "synthetic portrait should classify as portrait");
  console.log("PASS stylized portrait fallback");

  // 3) Plan: allowed step count, unique titles, deterministic.
  const buf = fs.readFileSync(path.join(__dirname, "assets", "portrait-front.jpg"));
  const a1 = buildAnalysis(await Jimp.read(buf));
  const { plan } = await buildPlan(a1, { mode: "detailed", stepCount: 8, shading: true, buffer: buf });
  assert([6, 8, 10, 12].includes(plan.steps.length), "step count must be one of the allowed values");
  const titles = plan.steps.map((s) => s.title);
  assert.equal(new Set(titles).size, titles.length, "step titles must be unique");
  const { plan: plan2 } = await buildPlan(a1, { mode: "detailed", stepCount: 8, shading: true, buffer: buf });
  assert.deepStrictEqual(plan.steps, plan2.steps, "same inputs must produce the same plan");
  console.log("PASS plan: step count, unique titles, deterministic");

  // 4) Step images: count, shared dims, progressive reveal, content present.
  const { images } = await generateSteps({ buffer: buf, mode: "detailed", stepCount: 8, shading: true, thickness: 1.3 });
  assert.equal(images.length, 8, "should generate 8 step images");
  const pngs = [];
  for (const im of images) {
    const p = await im.getBufferAsync(Jimp.MIME_PNG);
    pngs.push(p);
    const d = await Jimp.read(p);
    assert.equal(d.bitmap.width, images[0].bitmap.width, "step images share width");
    assert.equal(d.bitmap.height, images[0].bitmap.height, "step images share height");
  }
  const m = await metricsForSteps(pngs);
  const darks = m.steps.map((s) => s.inkDark);
  for (let i = 1; i < darks.length; i++) {
    assert(darks[i] >= darks[i - 1] - 0.005, `dark ink should not regress at step ${i + 1}`);
  }
  assert(m.steps[0].inkLight > 0.001, "step 1 has visible construction guides (not blank)");
  const serious = flagsFor(m, { blackInk: 0.72 }).filter(
    (f) => f.includes("BLANK") || f.includes("REGRESSION")
  );
  assert.equal(serious.length, 0, "no blank or regression frames: " + serious.join("; "));
  console.log("PASS steps: 8 frames, shared dims, monotonic ink, no blank/regression");

  console.log("ALL QUALITY CHECKS PASS");
}

main().catch((e) => {
  console.error("FAIL", e);
  process.exit(1);
});
