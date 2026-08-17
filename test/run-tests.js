"use strict";

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const tests = ["e2e.test.js", "quality.test.js", "server.test.js", "startup.test.js"];

let failed = false;
for (const t of tests) {
  const file = path.join(__dirname, t);
  if (!fs.existsSync(file)) continue;
  console.log(`\n=== ${t} ===`);
  const r = spawnSync(process.execPath, [file], { stdio: "inherit", env: process.env });
  if (r.status !== 0) failed = true;
}

if (failed) {
  console.error("\nSOME TESTS FAILED");
  process.exit(1);
}
console.log("\nALL TESTS PASSED");
