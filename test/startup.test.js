"use strict";

// Boot the real production server (src/index.js) in three modes:
// 1. No API keys, XAI_ENABLED=false → deterministic mode, /health shows aiConfigured:false
// 2. XAI_API_KEY set but XAI_ENABLED=false → deterministic mode (xAI disabled)
// 3. XAI_API_KEY set + XAI_ENABLED=true → xAI-enhanced mode
//
// All must start instantly, bind 0.0.0.0:PORT, serve /health, and stay alive.

const { spawn } = require("child_process");
const path = require("path");

const PORT_NO_KEY = 8798;
const PORT_XAI_DISABLED = 8799;
const PORT_XAI_ENABLED = 8800;
const BASE_NO_KEY = `http://127.0.0.1:${PORT_NO_KEY}`;
const BASE_XAI_DISABLED = `http://127.0.0.1:${PORT_XAI_DISABLED}`;
const BASE_XAI_ENABLED = `http://127.0.0.1:${PORT_XAI_ENABLED}`;

function assert(cond, msg) {
  if (!cond) {
    console.error(`FAIL ${msg}`);
    process.exit(1);
  }
  console.log(`PASS ${msg}`);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitForHealth(base, timeoutMs = 10000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const r = await fetch(`${base}/health`, { signal: AbortSignal.timeout(1500) });
      if (r.status === 200) return await r.json();
    } catch { /* not up yet */ }
    await sleep(250);
  }
  return null;
}

function kill(child) {
  return new Promise((r) => {
    child.kill("SIGTERM");
    child.once("exit", r);
    setTimeout(r, 3000);
    if (child.exitCode === null) child.kill("SIGKILL");
  });
}

/**
 * Test 1: Boot with NO API keys, XAI_ENABLED=false — deterministic mode.
 */
async function testNoKey() {
  const serverRoot = path.join(__dirname, "..");
  const child = spawn(process.execPath, ["src/index.js"], {
    cwd: serverRoot,
    env: {
      ...process.env,
      NODE_ENV: "production",
      PORT: String(PORT_NO_KEY),
      HOST: "0.0.0.0",
      PUBLIC_BASE_URL: BASE_NO_KEY,
      XAI_ENABLED: "false",
      AI_API_KEY: "",
      XAI_API_KEY: "",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let logs = "";
  child.stdout.on("data", (d) => (logs += d.toString()));
  child.stderr.on("data", (d) => (logs += d.toString()));

  try {
    const health = await waitForHealth(BASE_NO_KEY);
    assert(!!health, "no-key: GET /health returns HTTP 200");
    assert(health.ok === true, "no-key: /health reports ok:true");
    assert(health.service === "sketchflow-api", "no-key: /health reports service:sketchflow-api");
    assert(health.aiConfigured === false, "no-key: /health reports aiConfigured:false");
    assert(health.aiProvider === "local", "no-key: /health reports aiProvider:local");
    assert(health.mode === "deterministic", "no-key: /health reports mode:deterministic");
    assert(child.exitCode === null, "no-key: server process stays alive");

    const root = await fetch(`${BASE_NO_KEY}/`, { signal: AbortSignal.timeout(1500) });
    assert(root.status === 200, "no-key: GET / returns HTTP 200");

    assert(logs.includes(`listening on 0.0.0.0:${PORT_NO_KEY}`), "no-key: startup log shows listening");
    assert(logs.includes("health endpoint ready at /health"), "no-key: startup log shows health endpoint ready");
    assert(logs.includes("xAI enhancement: disabled"), "no-key: startup log shows xAI disabled");
    assert(!/(XAI_API_KEY=)|(AI_API_KEY=)|(password=)|(secret=)/i.test(logs), "no-key: no key values in logs");
  } finally {
    await kill(child);
  }
}

/**
 * Test 2: Boot with XAI_API_KEY set but XAI_ENABLED=false — deterministic mode.
 * The key exists but xAI is explicitly disabled.
 */
async function testXaiDisabled() {
  const serverRoot = path.join(__dirname, "..");
  const child = spawn(process.execPath, ["src/index.js"], {
    cwd: serverRoot,
    env: {
      ...process.env,
      NODE_ENV: "production",
      PORT: String(PORT_XAI_DISABLED),
      HOST: "0.0.0.0",
      PUBLIC_BASE_URL: BASE_XAI_DISABLED,
      XAI_ENABLED: "false",
      AI_PROVIDER: "xai",
      XAI_API_KEY: "test-secret-not-real",
      AI_MODEL: "grok-4.5",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let logs = "";
  child.stdout.on("data", (d) => (logs += d.toString()));
  child.stderr.on("data", (d) => (logs += d.toString()));

  try {
    const health = await waitForHealth(BASE_XAI_DISABLED);
    assert(!!health, "xai-disabled: GET /health returns HTTP 200");
    assert(health.ok === true, "xai-disabled: /health reports ok:true");
    assert(health.aiConfigured === false, "xai-disabled: /health reports aiConfigured:false (xAI disabled)");
    assert(health.aiProvider === "local", "xai-disabled: /health reports aiProvider:local");
    assert(health.xaiEnabled === false, "xai-disabled: /health reports xaiEnabled:false");
    assert(health.mode === "deterministic", "xai-disabled: /health reports mode:deterministic");
    assert(child.exitCode === null, "xai-disabled: server process stays alive");

    assert(logs.includes("xAI enhancement: disabled"), "xai-disabled: startup log shows xAI disabled");
    assert(!logs.includes("test-secret"), "xai-disabled: secret key is not leaked in logs");
    assert(!/(XAI_API_KEY=)|(AI_API_KEY=)|(password=)|(secret=)/i.test(logs), "xai-disabled: no key values in logs");
  } finally {
    await kill(child);
  }
}

/**
 * Test 3: Boot with XAI_API_KEY + XAI_ENABLED=true — xAI-enhanced mode.
 * The key value is fake; we only check detection, not real API calls.
 */
async function testXaiEnabled() {
  const serverRoot = path.join(__dirname, "..");
  const child = spawn(process.execPath, ["src/index.js"], {
    cwd: serverRoot,
    env: {
      ...process.env,
      NODE_ENV: "production",
      PORT: String(PORT_XAI_ENABLED),
      HOST: "0.0.0.0",
      PUBLIC_BASE_URL: BASE_XAI_ENABLED,
      XAI_ENABLED: "true",
      AI_PROVIDER: "xai",
      XAI_API_KEY: "test-secret-not-real",
      AI_MODEL: "grok-4.5",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let logs = "";
  child.stdout.on("data", (d) => (logs += d.toString()));
  child.stderr.on("data", (d) => (logs += d.toString()));

  try {
    const health = await waitForHealth(BASE_XAI_ENABLED);
    assert(!!health, "xai-enabled: GET /health returns HTTP 200");
    assert(health.ok === true, "xai-enabled: /health reports ok:true");
    assert(health.aiConfigured === true, "xai-enabled: /health reports aiConfigured:true");
    assert(health.aiProvider === "xai", "xai-enabled: /health reports aiProvider:xai");
    assert(health.xaiEnabled === true, "xai-enabled: /health reports xaiEnabled:true");
    assert(health.mode === "ai-enhanced", "xai-enabled: /health reports mode:ai-enhanced");
    assert(child.exitCode === null, "xai-enabled: server process stays alive");

    assert(logs.includes("xAI enhancement: configured"), "xai-enabled: startup log shows xAI configured");
    assert(!logs.includes("test-secret"), "xai-enabled: secret key is not leaked in logs");
    assert(!/(XAI_API_KEY=)|(AI_API_KEY=)|(password=)|(secret=)/i.test(logs), "xai-enabled: no key values in logs");
  } finally {
    await kill(child);
  }
}

async function main() {
  await testNoKey();
  await testXaiDisabled();
  await testXaiEnabled();
}

main().catch((err) => {
  console.error(`FAIL ${err.message}`);
  process.exit(1);
});
