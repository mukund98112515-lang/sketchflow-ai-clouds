"use strict";

const config = require("../config");

/**
 * In-memory sliding-window rate limiter keyed by device id / user id.
 * Protects the expensive AI generation endpoint.
 */
const buckets = new Map();

function rateLimit({ windowMs, max }) {
  return (req, res, next) => {
    const key = req.deviceKey || req.headers["x-forwarded-for"] || req.ip || "unknown";
    const now = Date.now();
    const bucket = buckets.get(key) || { start: now, count: 0 };
    if (now - bucket.start > windowMs) {
      bucket.start = now;
      bucket.count = 0;
    }
    bucket.count++;
    buckets.set(key, bucket);
    res.set("X-RateLimit-Limit", String(max));
    res.set("X-RateLimit-Remaining", String(Math.max(0, max - bucket.count)));
    if (bucket.count > max) {
      res.set("Retry-After", String(Math.ceil((bucket.start + windowMs - now) / 1000)));
      return res.status(429).json({ error: { code: "RATE_LIMITED", message: "Free service capacity reached. Please try again later." } });
    }
    next();
  };
}

module.exports = { rateLimit };
