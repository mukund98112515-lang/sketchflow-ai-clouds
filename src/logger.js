"use strict";

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const level = LEVELS[process.env.LOG_LEVEL || (process.env.NODE_ENV === "production" ? "info" : "debug")] ?? LEVELS.info;

function ts() {
  return new Date().toISOString();
}

function out(minLevel, args) {
  if (LEVELS[minLevel] < level) return;
  const prefix = `[${ts()}] [${minLevel}] [sketchflow]`;
  if (minLevel === "error") console.error(prefix, ...args);
  else if (minLevel === "warn") console.warn(prefix, ...args);
  else console.log(prefix, ...args);
}

function debug(...a) {
  out("debug", a);
}
function info(...a) {
  out("info", a);
}
function warn(...a) {
  out("warn", a);
}
function error(...a) {
  out("error", a);
}

module.exports = { debug, info, warn, error };
