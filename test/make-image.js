"use strict";

const fs = require("fs");
const path = require("path");
const Jimp = require("jimp");

const rgb = (r, g, b) => ({ r, g, b });

/** Draw a simple test "portrait" image so we can exercise the pipeline. */
async function makePortrait() {
  const W = 720;
  const H = 900;
  const img = await Jimp.create(W, H, 0xf4f1eaFF); // paper-ish bg
  const { data } = img.bitmap;

  const fill = (x0, y0, x1, y1, c) => {
    for (let y = Math.round(y0); y < Math.round(y1); y++) {
      for (let x = Math.round(x0); x < Math.round(x1); x++) {
        const i = (y * W + x) * 4;
        data[i] = c.r;
        data[i + 1] = c.g;
        data[i + 2] = c.b;
      }
    }
  };
  const fillEllipse = (cx, cy, rx, ry, c) => {
    for (let y = Math.max(0, Math.round(cy - ry)); y < Math.min(H, Math.round(cy + ry)); y++) {
      for (let x = Math.max(0, Math.round(cx - rx)); x < Math.min(W, Math.round(cx + rx)); x++) {
        const dx = (x - cx) / rx;
        const dy = (y - cy) / ry;
        if (dx * dx + dy * dy <= 1) {
          const i = (y * W + x) * 4;
          data[i] = c.r;
          data[i + 1] = c.g;
          data[i + 2] = c.b;
        }
      }
    }
  };

  // Soft backdrop so the subject is central and high-contrast.
  fill(0, 0, W, H, rgb(230, 226, 217));

  // Neck + shoulders
  fillEllipse(W * 0.5, H * 0.86, W * 0.34, H * 0.22, rgb(226, 188, 148));
  // Head
  fillEllipse(W * 0.5, H * 0.36, W * 0.19, H * 0.25, rgb(240, 200, 152));
  // Hair
  fillEllipse(W * 0.5, H * 0.26, W * 0.21, H * 0.16, rgb(74, 53, 39));
  // Eyes
  fillEllipse(W * 0.43, H * 0.36, W * 0.022, H * 0.012, rgb(34, 32, 29));
  fillEllipse(W * 0.57, H * 0.36, W * 0.022, H * 0.012, rgb(34, 32, 29));
  // Nose (subtle)
  fillEllipse(W * 0.5, H * 0.44, W * 0.03, H * 0.05, rgb(206, 154, 110));
  // Mouth
  fillEllipse(W * 0.5, H * 0.5, W * 0.08, H * 0.028, rgb(176, 106, 82));

  const buf = await img.getBufferAsync(Jimp.MIME_JPEG);
  const out = path.join(__dirname, "..", "data", "test_portrait.jpg");
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, buf);
  return out;
}

/** Large synthetic landscape-ish image (4000x3000) for performance/memory tests. */
async function makeLarge() {
  const W = 4000;
  const H = 3000;
  const img = await Jimp.create(W, H, 0xf2efe8FF);
  const { data } = img.bitmap;

  const grad = (x0, y0, x1, y1, from, to) => {
    const dx = x1 - x0;
    const dy = y1 - y0;
    const len = Math.max(1, Math.sqrt(dx * dx + dy * dy));
    for (let y = Math.round(Math.min(y0, y1)); y <= Math.round(Math.max(y0, y1)); y++) {
      for (let x = Math.round(Math.min(x0, x1)); x <= Math.round(Math.max(x0, x1)); x++) {
        if (x < 0 || y < 0 || x >= W || y >= H) continue;
        const nx = (x - x0) / len;
        const ny = (y - y0) / len;
        const c = Math.max(0, Math.min(1, nx * (dx / len) + ny * (dy / len)));
        const i = (y * W + x) * 4;
        data[i] = Math.round(from[0] + (to[0] - from[0]) * c);
        data[i + 1] = Math.round(from[1] + (to[1] - from[1]) * c);
        data[i + 2] = Math.round(from[2] + (to[2] - from[2]) * c);
      }
    }
  };
  // Sky -> ground
  grad(0, 0, 0, H, [150, 175, 200], [225, 220, 205]);
  // Dark mountain band
  grad(0, H * 0.55, 0, H * 0.62, [90, 105, 110], [140, 150, 150]);
  // Ridge line (a few bright peaks)
  for (let y = Math.round(H * 0.5); y < Math.round(H * 0.56); y += 2) {
    for (let x = 0; x < W; x += 3) {
      const peak = Math.abs(Math.sin(x / 140)) * H * 0.05;
      const yy = Math.round(H * 0.5 + peak - (y - H * 0.5) * 2);
      if (yy < H * 0.62 && yy > 0) {
        const i = (yy * W + x) * 4;
        data[i] = 70;
        data[i + 1] = 80;
        data[i + 2] = 85;
      }
    }
  }
  // Foreground texture speckles (noise for edge density)
  let seed = 1234567;
  const rnd = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  for (let n = 0; n < 400000; n++) {
    const x = Math.floor(rnd() * W);
    const y = Math.floor(rnd() * H);
    const i = (y * W + x) * 4;
    data[i] = Math.max(0, data[i] - Math.floor(rnd() * 18));
    data[i + 1] = Math.max(0, data[i + 1] - Math.floor(rnd() * 18));
    data[i + 2] = Math.max(0, data[i + 2] - Math.floor(rnd() * 18));
  }

  const buf = await img.getBufferAsync(Jimp.MIME_JPEG);
  const out = path.join(__dirname, "..", "data", "test_large.jpg");
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, buf);
  return out;
}

module.exports = { makePortrait, makeLarge, rgb };
