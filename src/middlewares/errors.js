"use strict";

const config = require("../config");

/** Optional bearer-token auth. Enabled only when AUTH_TOKEN is configured. */
function authRequired(req, res, next) {
  if (!config.authToken) return next();
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (token !== config.authToken) {
    return res.status(401).json({ error: { code: "UNAUTHORIZED", message: "Invalid or missing auth token." } });
  }
  next();
}

function notFound(req, res) {
  res.status(404).json({ error: { code: "NOT_FOUND", message: "Endpoint not found." } });
}

function errorHandler(err, req, res, _next) {
  const code = err.code || "SERVER_ERROR";
  const status =
    err.status ||
    (code === "SERVER_BUSY"
      ? 503
      : code === "VALIDATION_FAILED" || code === "INVALID_IMAGE" || code === "UNSUPPORTED_IMAGE"
        ? 400
        : 500);
  if (status >= 500) {
    // eslint-disable-next-line no-console
    console.error("[server]", err);
  }
  if (res.headersSent) return;
  res.status(status).json({
    error: {
      code,
      message: err.expose ? err.message : err.message || "Something went wrong. Please try again.",
    },
  });
}

/** Attach a device key for rate limiting / dedupe from header or param. */
function deviceKey(req, _res, next) {
  req.deviceKey =
    req.headers["x-device-id"] ||
    req.query.deviceId ||
    req.get("x-forwarded-for") ||
    req.ip;
  next();
}

module.exports = { authRequired, notFound, errorHandler, deviceKey };
