"use strict";

const fs = require("fs");
const path = require("path");
const assert = require("assert");
const Jimp = require("jimp");
const { makePortrait } = require("./make-image");
const { generateSteps, buildAnalysis, luminanceArray } = require("../src/ai/imageproc");
const { buildPlan } = require("../src/ai/plan");

async function main() {
  const file = await makePortrait();
  const buf = fs.readFileSync(file);
  assert(buf.length > 1000, "test image should have real content");

  // 1) Analysis
  const img = await Jimp.read(buf);
  const analysis = buildAnalysis(img);
  assert(analysis.width === img.bitmap.width, "analysis.width must match image width");
  assert(analysis.height === img.bitmap.height, "analysis.height must match image height");
  assert(analysis.classification && analysis.classification.subjectType === "portrait", "test image should classify as a portrait");
  assert(analysis.ellipse && analysis.ellipse.valid, "an ellipse should be fitted");
  assert(Number.isFinite(analysis.ellipse.cx) && analysis.ellipse.cx > 0, "ellipse cx should be finite and positive");

  // 2) Plan: deterministic, distinct, well-framed steps.
  const { plan, llmUsed } = await buildPlan(analysis, { mode: "detailed", stepCount: 8, shading: true, buffer: buf });
  assert.equal(plan.steps.length, 8, "plan should have exactly 8 steps");
  const titles = plan.steps.map((s) => s.title);
  assert.equal(new Set(titles).size, 8, "every step should have a distinct stage title");
  assert.notEqual(plan.steps[0].title, plan.steps[1].title, "first two steps must differ");
  assert(/final/i.test(plan.steps[7].title), "last step should be the final sketch");
  for (const s of plan.steps) {
    assert(s.instruction && s.instruction.length > 20, "each step needs a real instruction");
    assert(s.tip && s.tip.length > 5, "each step needs a tip");
  }
  // Determinism across calls.
  const { plan: plan2 } = await buildPlan(analysis, { mode: "detailed", stepCount: 8, shading: true, buffer: buf });
  assert.deepStrictEqual(plan.steps, plan2.steps, "same inputs must produce the same plan");

  // 3) Step images: count, dimensions, progressive reveal.
  const { images } = await generateSteps({ buffer: buf, mode: "detailed", stepCount: 8, shading: true, thickness: 1.3 });
  assert.equal(images.length, 8, "should generate 8 step images");
  const dir = path.join(__dirname, "..", "data", "smoke");
  fs.mkdirSync(dir, { recursive: true });
  const written = [];
  for (let i = 0; i < images.length; i++) {
    const b = await images[i].getBufferAsync(Jimp.MIME_JPEG);
    written.push(b);
    fs.writeFileSync(path.join(dir, `step_${i + 1}.jpg`), b);
  }
  for (const b of written) assert(b.length > 5000, "each step image should have content");

  const lumSteps = [];
  for (let i = 0; i < images.length; i++) {
    const decoded = await Jimp.read(written[i]);
    assert.equal(decoded.bitmap.width, images[0].bitmap.width, "step images share dimensions");
    lumSteps.push(luminanceArray(decoded));
  }
  const meanDark = (l) => {
    let s = 0;
    for (let i = 0; i < l.length; i++) s += l[i];
    return s / l.length;
  };
  const m1 = meanDark(lumSteps[0]);
  const m8 = meanDark(lumSteps[7]);
  assert(m8 < m1, "final sketch should be darker than the first step");

  console.log("PASS analysis: portrait,", analysis.width + "x" + analysis.height);
  console.log("PASS plan:", plan.steps.map((s) => s.title).join(" | "));
  console.log("PASS steps:", images.length, "first meanLum", m1.toFixed(3), "final meanLum", m8.toFixed(3));
}

main().catch((e) => {
  console.error("FAIL", e);
  process.exit(1);
});
