"use strict";

/* End-to-end HTTP test of the stateless server.
 * No database, no object storage — exercises /health, generate-guide,
 * in-memory job polling, the completed guide (base64 steps), trace, and
 * error paths. Run: node test/server.test.js */

const fs = require("fs");
const os = require("os");
const path = require("path");
const assert = require("assert");

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "sketchflow-test-"));

process.env.NODE_ENV = "test";
process.env.TMP_DIR = path.join(scratch, "tmp");
process.env.PORT = "0";

const { createApp } = require("../src/app");
const Jimp = require("jimp");

async function makeJpeg() {
  const img = new Jimp(96, 128, 0xeeeeeeff);
  img.color([{ apply: "mix", params: ["#333333", 60] }]);
  // draw a dark rectangle to give the classifier something to see
  img.scan(0, 0, img.bitmap.width, img.bitmap.height, function (x, y, idx) {
    if (x > 24 && x < 72 && y > 40 && y < 96) {
      this.bitmap.data[idx] = 60;
      this.bitmap.data[idx + 1] = 70;
      this.bitmap.data[idx + 2] = 80;
    }
  });
  return img.getBufferAsync(Jimp.MIME_JPEG);
}

let server;
let base;

async function pollJob(jobId, timeoutMs = 120000) {
  const start = Date.now();
  for (;;) {
    const r = await fetch(`${base}/api/jobs/${jobId}`);
    assert.equal(r.status, 200, "job status should be fetchable");
    const job = await r.json();
    if (job.status === "completed") return job;
    if (job.status === "failed") throw new Error(`job failed: ${job.errorCode} ${job.message}`);
    if (Date.now() - start > timeoutMs) throw new Error("job polling timed out");
    await new Promise((res) => setTimeout(res, 800));
  }
}

function multipart(fields) {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) {
    if (v && typeof v === "object" && v.buffer) {
      form.append(k, new Blob([v.buffer], { type: v.type || "image/jpeg" }), v.name || "image.jpg");
    } else {
      form.append(k, String(v));
    }
  }
  return form;
}

async function main() {
  const app = createApp();
  await new Promise((resolve) => {
    server = app.listen(0, "127.0.0.1", resolve);
  });
  base = `http://127.0.0.1:${server.address().port}`;

  // 1) Health
  {
    const r = await fetch(`${base}/health`);
    assert.equal(r.status, 200);
    const h = await r.json();
    assert.equal(h.ok, true);
    assert.equal(h.service, "sketchflow-api");
    console.log("PASS GET /health");
  }

  // 2) Generate a guide (6 steps, fastest path)
  const img = await makeJpeg();
  let generate;
  {
    const r = await fetch(`${base}/api/generate-guide`, {
      method: "POST",
      body: multipart({
        image: { buffer: img, name: "test.jpg", type: "image/jpeg" },
        mode: "detailed",
        stepCount: "6",
        shading: "true",
        thickness: "1.3",
        requestId: `req_test_${Date.now()}`,
      }),
    });
    assert.equal(r.status, 202, "generate should return 202");
    generate = await r.json();
    assert.ok(generate.jobId, "response should include jobId");
    console.log("PASS POST /api/generate-guide ->", generate.jobId);
  }

  // 3) Poll until complete, verify the full guide is returned inline
  const job = await pollJob(generate.jobId);
  assert.ok(job.result, "completed job should include the guide result");
  const result = job.result;
  assert.equal(result.stepCount, 6, "result should have 6 steps");
  assert.equal(result.mode, "detailed");
  assert.equal(result.shading, true);
  assert.ok(result.title, "result should have a title");
  assert.ok(result.subjectType, "result should have a subject type");
  assert.equal(result.steps.length, 6, "result should include 6 steps");
  assert.equal(result.steps[0].stepNumber, 1, "first step number should be 1");
  assert.ok(result.steps[0].title, "each step should have a title");
  assert.ok(result.steps[0].instruction, "each step should have an instruction");
  assert.ok("artistTip" in result.steps[0], "each step should have an artistTip");
  assert.ok(result.steps[0].image.startsWith("data:image/jpeg;base64,"), "step image should be a base64 data URL");
  const firstStepBytes = Buffer.from(result.steps[0].image.split(",")[1], "base64").length;
  assert.ok(firstStepBytes > 500, "step image should have real content (" + firstStepBytes + " bytes)");
  console.log("PASS job completed with inline guide (" + result.steps.length + " steps, base64 images)");

  // 4) Steps are progressive (not identical copies of the same edge image)
  {
    const hashes = result.steps.map((s) => {
      const buf = Buffer.from(s.image.split(",")[1], "base64");
      return require("crypto").createHash("sha1").update(buf).digest("hex").slice(0, 8);
    });
    assert.ok(new Set(hashes).size >= 3, "step images should differ from each other");
    console.log("PASS step images are distinct across stages");
  }

  // 5) Duplicate idempotency key is reused
  {
    const r = await fetch(`${base}/api/generate-guide`, {
      method: "POST",
      body: multipart({
        image: { buffer: img, name: "test.jpg", type: "image/jpeg" },
        mode: "detailed",
        stepCount: "6",
        shading: "true",
        requestId: generate.jobId,
      }),
    });
    assert.equal(r.status, 202);
    const body = await r.json();
    assert.equal(body.jobId, generate.jobId);
    assert.equal(body.duplicate, true, "re-submitting the same requestId should be flagged as duplicate");
    console.log("PASS duplicate requestId -> duplicate:true");
  }

  // 6) Trace endpoint (stateless line art, still served inline)
  {
    const r = await fetch(`${base}/api/trace`, {
      method: "POST",
      body: multipart({
        image: { buffer: img, name: "test.jpg", type: "image/jpeg" },
        mode: "clean",
        detail: "50",
        thickness: "40",
      }),
    });
    assert.equal(r.status, 200);
    const bytes = await r.arrayBuffer();
    assert.ok(bytes.byteLength > 1000, "trace image should have content");
    console.log("PASS POST /api/trace");
  }

  // 7) Error paths
  {
    const r = await fetch(`${base}/api/generate-guide`, {
      method: "POST",
      body: multipart({ mode: "detailed", stepCount: "8", shading: "true" }),
    });
    assert.equal(r.status, 400, "missing image should 400");
    const body = await r.json();
    assert.equal(body.error.code, "NO_IMAGE");
    console.log("PASS error: missing image -> 400 NO_IMAGE");
  }
  {
    const r = await fetch(`${base}/api/generate-guide`, {
      method: "POST",
      body: multipart({
        image: { buffer: img, name: "test.jpg", type: "image/jpeg" },
        mode: "detailed",
        stepCount: "7",
        shading: "true",
      }),
    });
    assert.equal(r.status, 400, "bad step count should 400");
    console.log("PASS error: invalid step count -> 400");
  }
  {
    const r = await fetch(`${base}/api/jobs/nope`);
    assert.equal(r.status, 404, "missing job should 404");
    console.log("PASS error: unknown job -> 404");
  }

  // 8) No scratch files left behind after the flow
  {
    const tmp = process.env.TMP_DIR;
    const remaining = fs.existsSync(tmp) ? fs.readdirSync(tmp).length : 0;
    assert.equal(remaining, 0, `ephemeral temp files should be cleaned up (found ${remaining})`);
    console.log("PASS temp files cleaned up after requests");
  }

  console.log("\nALL SERVER HTTP CHECKS PASS");
}

main()
  .then(async () => {
    if (server) server.close();
    fs.rmSync(scratch, { recursive: true, force: true });
  })
  .catch(async (e) => {
    console.error("SERVER TEST FAIL", e);
    if (server) server.close();
    fs.rmSync(scratch, { recursive: true, force: true });
    process.exit(1);
  });
