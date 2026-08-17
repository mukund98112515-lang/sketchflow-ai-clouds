"use strict";

/**
 * Real, deterministic image-processing pipeline for SketchFlow AI.
 *
 * Every tutorial step image is derived from a single master edge/ink analysis
 * of the reference photo. Construction shapes (fitted ellipse + guides) are
 * computed once, and later stages only ADD ink — they never regenerate the
 * subject — so composition, proportions, pose and placement stay identical
 * across all steps.
 */

const Jimp = require("jimp");
const config = require("../config");

const SKIP = Symbol("skip");

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function hexToRgb(hex) {
  const h = hex.replace("#", "");
  const n = parseInt(h, 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

const PAPER = hexToRgb(config.sketchPaper || "#fbf9f5");
const INK = hexToRgb("#2b2b2b");

function parseColor(color) {
  if (typeof color === "string") return hexToRgb(color);
  if (color.r !== undefined) return color;
  return PAPER;
}

/** Extract luminance (0..1) array from a Jimp image. */
function luminanceArray(img) {
  const { data, width, height } = img.bitmap;
  const n = width * height;
  const out = new Float32Array(n);
  for (let i = 0, p = 0; i < n; i++, p += 4) {
    out[i] = (0.299 * data[p] + 0.587 * data[p + 1] + 0.114 * data[p + 2]) / 255;
  }
  return out;
}

function sobel(lum, width, height) {
  const n = width * height;
  const mag = new Float32Array(n);
  let max = 0;
  for (let y = 1; y < height - 1; y++) {
    const row = y * width;
    const up = row - width;
    const dn = row + width;
    for (let x = 1; x < width - 1; x++) {
      const i = row + x;
      const tl = lum[up + x - 1];
      const tc = lum[up + x];
      const tr = lum[up + x + 1];
      const ml = lum[row + x - 1];
      const mr = lum[row + x + 1];
      const bl = lum[dn + x - 1];
      const bc = lum[dn + x];
      const br = lum[dn + x + 1];
      const gx = -tl - 2 * ml - bl + tr + 2 * mr + br;
      const gy = -tl - 2 * tc - tr + bl + 2 * bc + br;
      const m = Math.sqrt(gx * gx + gy * gy);
      mag[i] = m;
      if (m > max) max = m;
    }
  }
  if (max > 0) {
    for (let i = 0; i < n; i++) mag[i] /= max;
  }
  return mag;
}

/* ------------------------------------------------------------------ */
/* Preprocessing & edge analysis                                       */
/* ------------------------------------------------------------------ */

/** Light box blur on luminance to kill sensor/compression speckle. */
function smoothLum(lum, width, height, radius = 1.2) {
  return boxBlur(new Float32Array(lum), width, height, radius);
}

/** Ratio of horizontal-edge energy to vertical-edge energy (1 = balanced). */
function gradientDirectionalBias(lum, width, height) {
  let h = 0;
  let v = 0;
  for (let y = 1; y < height - 1; y++) {
    const row = y * width;
    const up = row - width;
    const dn = row + width;
    for (let x = 1; x < width - 1; x++) {
      const i = row + x;
      const tl = lum[up + x - 1];
      const tc = lum[up + x];
      const tr = lum[up + x + 1];
      const ml = lum[row + x - 1];
      const mr = lum[row + x + 1];
      const bl = lum[dn + x - 1];
      const bc = lum[dn + x];
      const br = lum[dn + x + 1];
      const gx = -tl - 2 * ml - bl + tr + 2 * mr + br;
      const gy = -tl - 2 * tc - tr + bl + 2 * bc + br;
      h += Math.abs(gy);
      v += Math.abs(gx);
    }
  }
  return v > 0 ? h / v : 1;
}

/** Fraction of a coarse edge grid concentrated in the upper band. */
function upperBandConcentration(mag, width, height) {
  const cells = 16;
  const gw = width / cells;
  const gh = height / cells;
  const grid = new Float32Array(cells * cells);
  let total = 0;
  let upper = 0;
  for (let y = 0; y < height; y++) {
    const gy = Math.min(cells - 1, Math.floor(y / gh));
    for (let x = 0; x < width; x++) {
      const v = mag[y * width + x];
      if (v < 0.08) continue;
      const gx = Math.min(cells - 1, Math.floor(x / gw));
      grid[gy * cells + gx] += v;
    }
  }
  for (let gy = 0; gy < cells; gy++) {
    for (let gx = 0; gx < cells; gx++) {
      const v = grid[gy * cells + gx];
      total += v;
      if (gy < cells * 0.45) upper += v;
    }
  }
  return total > 0 ? upper / total : 0.5;
}

/** Average luminance of the top strip (sky heuristic). */
function skyLuminance(lum, width, height) {
  const top = Math.max(8, Math.floor(height * 0.25));
  let s = 0;
  for (let y = 0; y < top; y++) {
    for (let x = 0; x < width; x++) s += lum[y * width + x];
  }
  return s / (top * width);
}

function analyzeLum(lum, width, height) {
  const n = lum.length;
  let sum = 0;
  for (let i = 0; i < n; i++) sum += lum[i];
  const mean = sum / n;
  let varSum = 0;
  for (let i = 0; i < n; i++) {
    const d = lum[i] - mean;
    varSum += d * d;
  }
  return {
    mean,
    std: Math.sqrt(varSum / n),
  };
}

function isSkinTone(r, g, b) {
  // Loose RGB skin heuristic (kept for the report; not used as a gate).
  const mx = Math.max(r, g, b);
  const mn = Math.min(r, g, b);
  if (mx === 0) return false;
  return (
    r > 30 &&
    r >= b &&
    mx - mn > 8 &&
    r > mx * 0.55 &&
    g > mn &&
    (r - b) > 12
  );
}

function detectFaceBox(img) {
  const { width, height } = img.bitmap;

  // Geometry + symmetry only — works for grayscale, any skin tone, makeup.
  const lum = luminanceArray(img);
  const mag = sobel(smoothLum(lum, width, height), width, height);
  const geo = detectFaceGeometry(mag, width, height);

  if (!geo) return null;
  if (geo.confidence < (geo.stylizedFallback ? 0.44 : 0.45)) return null;

  return {
    x: Math.max(0, geo.cx - geo.headW / 2),
    y: Math.max(0, geo.headTop),
    w: Math.min(width - 1, geo.headW),
    h: Math.min(height - 1, geo.headBottom - geo.headTop),
    confidence: geo.confidence,
    landmarks: geo,
    profile: geo.profile,
    profileDir: geo.profileDir,
  };
}

/**
 * Count distinct horizontal feature bands in the interior of a head-box
 * candidate (eyes row, mouth row, chin). Real faces show 2-3 separated bands
 * of interior edge mass; smooth objects (pepper) and lone ridges show 0-1.
 */
function interiorBandScore(mag, width, height, boxPx) {
  const x0 = Math.max(1, Math.round(boxPx.x0) + 1);
  const x1 = Math.min(width - 2, Math.round(boxPx.x1) - 1);
  const y0 = Math.max(1, Math.round(boxPx.y0) + 1);
  const y1 = Math.min(height - 2, Math.round(boxPx.y0 + boxPx.h) - 1);
  if (x1 - x0 < 6 || y1 - y0 < 6) return 0;
  const rows = new Float32Array(y1 - y0);
  let max = 0;
  for (let y = y0; y < y1; y++) {
    let s = 0;
    for (let x = x0; x <= x1; x++) s += mag[y * width + x];
    const v = s / (x1 - x0 + 1);
    rows[y - y0] = v;
    if (v > max) max = v;
  }
  if (max <= 0) return 0;
  const sm = new Float32Array(rows.length);
  for (let i = 0; i < rows.length; i++) {
    let s = 0;
    let n = 0;
    for (let j = -2; j <= 2; j++) {
      const k = i + j;
      if (k >= 0 && k < rows.length) {
        s += rows[k];
        n++;
      }
    }
    sm[i] = s / n;
  }
  const H = rows.length;
  const minSep = H * 0.18;
  let count = 0;
  let last = -Infinity;
  for (let i = 1; i < H - 1; i++) {
    if (sm[i] > sm[i - 1] && sm[i] > sm[i + 1] && sm[i] > max * 0.55) {
      if (i - last >= minSep) {
        count++;
        last = i;
      }
    }
  }
  return count;
}

/**
 * Pure-geometry head finder: scans candidate head-sized boxes in the upper
 * frame and scores each on face-like cues that survive grayscale / makeup /
 * lighting — an enclosing silhouette ring (hair/cheeks/jaw), an EMPTY-ish
 * interior (faces are smooth inside, fur/texture are not), distinct interior
 * feature bands (eyes/mouth), bilateral symmetry, and a shoulder/neck mass
 * just below the head.
 */
function detectFaceGeometry(mag, width, height) {
  const C = 32;
  const cw = width / C;
  const ch = height / C;
  const cell = new Float32Array(C * C);
  let total = 0;
  for (let y = 1; y < height - 1; y++) {
    const gy = Math.min(C - 1, Math.floor(y / ch));
    const row = y * width;
    for (let x = 1; x < width - 1; x++) {
      const v = mag[row + x];
      if (v < 0.03) continue;
      const gx = Math.min(C - 1, Math.floor(x / cw));
      cell[gy * C + gx] += v;
      total += v;
    }
  }
  if (total < width * height * 0.0004) return null;
  let cmax = 0;
  for (let i = 0; i < cell.length; i++) if (cell[i] > cmax) cmax = cell[i];
  if (cmax > 0) for (let i = 0; i < cell.length; i++) cell[i] /= cmax;

  let best = null;
  const cands = [];
  const allCands = [];

  // Head height 0.16..0.5 of frame height; width factor 0.65..1.05.
  const hcMin = Math.max(5, Math.round(height * 0.16 / ch));
  const hcMax = Math.min(C - 2, Math.round(height * 0.5 / ch));
  for (let hc = hcMin; hc <= hcMax; hc++) {
    for (let k = 0.65; k <= 1.05 + 1e-9; k += 0.1) {
      const wc = Math.round(hc * k);
      if (wc < 4) continue;
      for (let cy = Math.round(hc / 2) + 1; cy <= Math.round(C * 0.58); cy++) {
        for (let cx = Math.round(C * 0.28); cx <= Math.round(C * 0.72); cx++) {
          const left = cx - wc / 2;
          const right = cx + wc / 2;
          const top = cy - hc / 2;
          const bottom = cy + hc / 2;
          const x0 = Math.max(0, Math.round(left));
          const x1 = Math.min(C - 1, Math.round(right));
          const y0 = Math.max(0, Math.round(top));
          const y1 = Math.min(C - 1, Math.round(bottom));

          // Boundary ring vs interior mass.
          let bnd = 0;
          let bndN = 0;
          let inner = 0;
          let innerN = 0;
          let bTop = 0;
          let bBot = 0;
          let bL = 0;
          let bR = 0;
          for (let gy = y0; gy <= y1; gy++) {
            for (let gx = x0; gx <= x1; gx++) {
              const onEdge = gy === y0 || gy === y1 || gx === x0 || gx === x1;
              const v = cell[gy * C + gx];
              if (onEdge) {
                bnd += v;
                bndN++;
                if (gy === y0) bTop += v;
                if (gy === y1) bBot += v;
                if (gx === x0) bL += v;
                if (gx === x1) bR += v;
              } else {
                inner += v;
                innerN++;
              }
            }
          }
          if (bndN < 4 || innerN < 1) continue;
          const bAvg = bnd / bndN;
          const iAvg = inner / innerN;
          // Faces: strong silhouette ring, sparse but non-empty interior.
          const faceLike = bAvg / (bAvg + 2 * iAvg);
          const interiorRel = bAvg > 0 ? iAvg / bAvg : 1;

          // Bilateral symmetry around the box's own vertical axis.
          let asym = 0;
          let smass = 0;
          for (let gy = y0; gy <= y1; gy++) {
            for (let gx = x0; gx <= x1; gx++) {
              const mirror = 2 * cx - gx;
              const mv = mirror >= 0 && mirror < C ? cell[gy * C + mirror] : 0;
              asym += Math.abs(cell[gy * C + gx] - mv);
              smass += cell[gy * C + gx];
            }
          }
          const symmetry = smass > 0 ? Math.max(0, 1 - asym / (1.3 * smass)) : 0;

          // Enclosed-ness: every side of the ring must carry mass.
          const sides = [bTop, bBot, bL, bR];
          const sMax = Math.max(...sides);
          const sMin = Math.min(...sides);
          const enclosed = sMax > 0 ? sMin / sMax : 0;

          // Containment: the head box holds most of the edge mass of its strip.
          let stripMass = 0;
          let boxMass = 0;
          for (let gy = y0; gy <= y1; gy++) {
            for (let gx = x0; gx <= x1; gx++) {
              boxMass += cell[gy * C + gx];
              const s0 = Math.max(0, gx - 2);
              const s1 = Math.min(C - 1, gx + 2);
              for (let gxx = s0; gxx <= s1; gxx++) stripMass += cell[gy * C + gxx];
            }
          }
          const containment = stripMass > 0 ? boxMass / stripMass : 0;

          // Horizontal isolation: for the box's own rows, little edge mass may
          // sit far outside the box columns (a head floats on a clean
          // background; a big tilted object extends across the whole frame).
          // Off-center subjects (e.g. side profiles) get a pass here.
          let outsideMass = 0;
          const isoMargin = Math.round(wc * 1.6);
          for (let gy = y0; gy <= y1; gy++) {
            for (let gx = 0; gx < x0 - isoMargin; gx++) outsideMass += cell[gy * C + gx];
            for (let gx = x1 + isoMargin; gx < C; gx++) outsideMass += cell[gy * C + gx];
          }
          const isolation = boxMass > 0 ? 1 - Math.min(1, outsideMass / (boxMass * 0.9)) : 0;
          const centered = cx / C >= 0.35 && cx / C <= 0.65;

          // Shoulder/neck support: mass below the head, wider than the head.
          let below = 0;
          let belowN = 0;
          const sTop = Math.min(C - 1, y1 + 1);
          const sBot = Math.min(C - 1, y1 + Math.round(hc * 0.55));
          const sX0 = Math.max(0, Math.round(cx - wc * 0.9));
          const sX1 = Math.min(C - 1, Math.round(cx + wc * 0.9));
          for (let gy = sTop; gy <= sBot; gy++) {
            for (let gx = sX0; gx <= sX1; gx++) {
              below += cell[gy * C + gx];
              belowN++;
            }
          }
          const shoulder = belowN > 0 ? Math.max(0, Math.min(1, below / (belowN * 0.28))) : 0;

          // Position: head sits near horizontal center, in the upper-mid frame.
          const hPos = Math.max(0, 1 - Math.abs(cx / C - 0.5) * 2.2);
          const vPos = Math.max(0, 1 - Math.max(0, cy / C - 0.3) * 2.4);

          const conf =
            0.30 * faceLike +
            0.25 * symmetry +
            0.20 * enclosed +
            0.10 * containment +
            0.10 * shoulder +
            0.05 * hPos +
            0.00 * vPos;

          if (conf >= 0.44) {
            allCands.push({
              cx: cx * cw,
              cy: cy * ch,
              headTop: y0 * ch,
              headBottom: Math.min(height, (y1 + 1) * ch),
              headW: (x1 - x0 + 1) * cw,
              headH: (y1 - y0 + 1) * ch,
              boxPx: {
                x0: (cx - wc / 2) * cw,
                x1: (cx + wc / 2) * cw,
                y0: (cy - hc / 2) * ch,
                h: hc * ch,
              },
              faceLike,
              symmetry,
              enclosed,
              containment,
              shoulder,
              interiorRel,
              isolation,
              conf,
            });
          }

          const aspectBox = wc / hc;
          const passes =
            conf >= 0.5 &&
            faceLike >= 0.42 &&
            faceLike <= 0.82 &&
            interiorRel >= 0.12 &&
            interiorRel <= 0.5 &&
            aspectBox >= 0.5 &&
            aspectBox <= 1.05 &&
            enclosed >= 0.35 &&
            containment >= 0.1 &&
            shoulder >= 0.15 &&
            symmetry >= 0.42 &&
            cy / C <= 0.52 &&
            (!centered || isolation >= 0.35);
          if (!passes) continue;
          cands.push({
            cx: cx * cw,
            cy: cy * ch,
            headTop: y0 * ch,
            headBottom: Math.min(height, (y1 + 1) * ch),
            headW: (x1 - x0 + 1) * cw,
            headH: (y1 - y0 + 1) * ch,
            boxPx: {
              x0: (cx - wc / 2) * cw,
              x1: (cx + wc / 2) * cw,
              y0: (cy - hc / 2) * ch,
              h: hc * ch,
            },
            faceLike,
            symmetry,
            enclosed,
            containment,
            shoulder,
            interiorRel,
            isolation,
            conf,
          });
        }
      }
    }
  }
  // Sort by structural confidence, then accept the best candidate that also
  // shows face-like interior feature bands (eyes/mouth) — the cue smooth
  // objects and lone ridges cannot fake.
  cands.sort((a, b) => b.conf - a.conf);
  for (const c of cands) {
    c.interiorBands = interiorBandScore(mag, width, height, c.boxPx);
    if (c.interiorBands >= 2) {
      best = c;
      break;
    }
  }
  if (!best && total < width * height * 0.02) {
    // Stylized/flat-drawing fallback: photo gates over-reject cartoon/vector
    // heads, which have a small, centered, symmetric interior-textured box in
    // the upper frame but no clean silhouette ring. The flat-drawing ceiling
    // (global edge mass ~10x below any photo) keeps textured photos out.
    let sty = null;
    for (const c of allCands) {
      if (
        c.conf >= 0.44 &&
        c.faceLike >= 0.6 && c.faceLike <= 0.85 &&
        c.interiorRel >= 0.15 && c.interiorRel <= 0.5 &&
        c.symmetry >= 0.4 &&
        c.enclosed < 0.35 &&
        c.cy / height <= 0.42 &&
        c.cx / width >= 0.35 && c.cx / width <= 0.65
      ) {
        if (!sty || c.conf > sty.conf) sty = c;
      }
    }
    if (sty) {
      sty.stylizedFallback = true;
      best = sty;
    }
  }
  if (!best) return null;

  const { cx, cy, headTop, headBottom, headW, headH } = best;
  // Loomis-style landmarks relative to the head box.
  const profile = best.symmetry < 0.42;
  const confidence = Math.min(1, best.conf);
  return {
    cx,
    cy,
    headTop,
    headBottom,
    headW,
    headH,
    eyeY: headTop + headH * 0.5,
    noseY: headTop + headH * 0.66,
    mouthY: headTop + headH * 0.78,
    chinY: headTop + headH * 0.9,
    profile,
    profileDir: 1,
    confidence,
    faceLike: best.faceLike,
    symmetry: best.symmetry,
    enclosed: best.enclosed,
    containment: best.containment,
    shoulder: best.shoulder,
    interiorRel: best.interiorRel,
    stylizedFallback: !!best.stylizedFallback,
  };
}

/** Estimate head width from the horizontal edge spread at eye level. */
function headWishWidth(mag, width, height, cx, headTop, headH) {
  const eyeY = Math.round(headTop + headH * 0.5);
  const y0 = Math.max(1, eyeY - Math.round(headH * 0.18));
  const y1 = Math.min(height - 1, eyeY + Math.round(headH * 0.18));
  const half = Math.round(Math.max(width, height) * 0.3);
  let left = cx;
  let right = cx;
  for (let y = y0; y <= y1; y++) {
    for (let x = Math.round(cx); x >= Math.max(0, cx - half); x--) {
      if (mag[y * width + x] > 0.12) {
        left = Math.min(left, x);
        break;
      }
    }
    for (let x = Math.round(cx); x <= Math.min(width - 1, cx + half); x++) {
      if (mag[y * width + x] > 0.12) {
        right = Math.max(right, x);
        break;
      }
    }
  }
  let span = right - left;
  // Fallback when the eye band finds no strong edges (e.g. soft grayscale
  // photos): scale the head from the box height with a head-like aspect.
  if (span < headH * 0.45) span = headH * 0.82;
  return Math.min(span * 1.05, width * 0.85);
}

function classifySubject(stats, faceBox, lum, mag, width, height) {
  const n = lum.length;
  // Edge density
  let edgeSum = 0;
  for (let i = 0; i < n; i++) edgeSum += mag[i];
  const edgeDensity = edgeSum / n;

  // Central-subject bias: strong edges concentrated near center vs spread out.
  let cx = width / 2;
  let cy = height / 2;
  let wSum = 0;
  let wx = 0;
  let wy = 0;
  for (let y = 2; y < height - 2; y += 2) {
    for (let x = 2; x < width - 2; x += 2) {
      const v = mag[y * width + x];
      wx += v * x;
      wy += v * y;
      wSum += v;
    }
  }
  if (wSum > 0) {
    cx = wx / wSum;
    cy = wy / wSum;
  }
  // Radial concentration: fraction of edge mass within 45% radius of centroid.
  let rMax = Math.max(width, height) * 0.45;
  let inRadius = 0;
  let outRadius = 0;
  for (let y = 2; y < height - 2; y += 2) {
    for (let x = 2; x < width - 2; x += 2) {
      const v = mag[y * width + x];
      const dx = x - cx;
      const dy = y - cy;
      if (Math.sqrt(dx * dx + dy * dy) < rMax) inRadius += v;
      else outRadius += v;
    }
  }
  const concentration = (inRadius + 1) / (inRadius + outRadius + 1);

  const hbias = gradientDirectionalBias(lum, width, height);
  const upper = upperBandConcentration(mag, width, height);
  const sky = skyLuminance(lum, width, height);

  const faceConf = faceBox ? faceBox.confidence : 0;
  const aspect = width / height;
  // Portrait: the face detector is selective; single heads appear in
  // near-square or portrait crops, not wide frames. Stylized/flat drawings
  // (cartoon heads) come through the fallback path at a lower confidence.
  const stylized = !!(faceBox && faceBox.landmarks && faceBox.landmarks.stylizedFallback);
  const portraitScore =
    faceConf >= (stylized ? 0.44 : 0.5) && aspect < 1.2 ? 0.55 + 0.45 * faceConf : 0;

  // Vehicle: horizontally elongated body, strong horizontal structure.
  let vehicleScore = 0;
  const widthLong = width > height * 1.15;
  if (widthLong && hbias > 1.2 && edgeDensity > 0.02 && concentration > 0.45) {
    vehicleScore = 0.55 + 0.3 * Math.min(1, (hbias - 1.2) / 1.3);
  }

  // Landscape: wide frame, bright top, edges spread out.
  let landscapeScore = 0;
  if (aspect > 1.6 && sky > 0.5) {
    landscapeScore = 0.55 + 0.15 * Math.min(1, (sky - 0.5) / 0.2);
  }

  // Object: compact central subject against a clean background.
  let objectScore = 0;
  if (!widthLong && !(aspect > 1.6) && concentration > 0.55 && edgeDensity > 0.01 && hbias < 1.25 && upper < 0.62) {
    objectScore = 0.45 + 0.3 * Math.min(1, (concentration - 0.55) / 0.25);
  }

  // Animal: a single, dense, textured central mass (fur/feathers).
  let animalScore = 0;
  if (faceConf < 0.4 && aspect < 1.8 && hbias < 1.2 && concentration > 0.9 && edgeDensity > 0.06) {
    animalScore =
      0.45 +
      0.25 * Math.min(1, (concentration - 0.9) / 0.1) +
      0.2 * Math.min(1, (edgeDensity - 0.06) / 0.06);
  }

  let subjectType = "general";
  let confidence = 0;
  let label = "Subject";
  const scores = [
    ["portrait", portraitScore],
    ["vehicle", vehicleScore],
    ["landscape", landscapeScore],
    ["object", objectScore],
    ["animal", animalScore],
  ];
  let best = 0.42;
  for (const [t, s] of scores) {
    if (s > best) {
      best = s;
      subjectType = t;
      confidence = s;
    }
  }
  if (subjectType === "portrait") label = "Portrait";
  else if (subjectType === "vehicle") label = "Vehicle";
  else if (subjectType === "landscape") label = "Landscape / Scene";
  else if (subjectType === "object") label = "Object";
  else if (subjectType === "animal") label = "Animal";

  const classification = {
    subjectType,
    label,
    confidence: Math.min(1, confidence),
    edgeDensity,
    contrast: stats.std,
    brightness: stats.mean,
    centroidX: cx / width,
    centroidY: cy / height,
    concentration,
    width,
    height,
    aspect: width / height,
    horizontalBias: hbias,
    upperBand: upper,
    sky: sky,
  };

  if (faceBox && subjectType === "portrait") {
    classification.landmarks = faceBox.landmarks;
    classification.profile = !!faceBox.profile;
    classification.profileDir = faceBox.profileDir || 1;
  }
  return classification;
}

function fitSubjectEllipse(mag, lum, width, height, band) {
  // Importance-weighted centroid + covariance of strong edges.
  // band = { x0, y0, x1, y1 } optionally restricts the fit to a region.
  const n = width * height;
  const bx0 = band ? Math.max(0, Math.floor(band.x0)) : 0;
  const by0 = band ? Math.max(0, Math.floor(band.y0)) : 0;
  const bx1 = band ? Math.min(width, Math.ceil(band.x1)) : width;
  const by1 = band ? Math.min(height, Math.ceil(band.y1)) : height;
  let sx = 0;
  let sy = 0;
  let sw = 0;
  let thresh = 0.22;
  for (let y = by0; y < by1; y++) {
    for (let x = bx0; x < bx1; x++) {
      const v = mag[y * width + x];
      if (v > thresh) {
        sx += x * v;
        sy += y * v;
        sw += v;
      }
    }
  }
  if (sw < 8) {
    thresh = 0.1;
    sx = sy = sw = 0;
    for (let y = by0; y < by1; y++) {
      for (let x = bx0; x < bx1; x++) {
        const v = mag[y * width + x];
        if (v > thresh) {
          sx += x * v;
          sy += y * v;
          sw += v;
        }
      }
    }
  }
  if (sw < 8) return { cx: width / 2, cy: height / 2, rx: width * 0.3, ry: height * 0.35, angle: 0, valid: false };

  const cx = sx / sw;
  const cy = sy / sw;
  let vxx = 0;
  let vyy = 0;
  let vxy = 0;
  for (let y = by0; y < by1; y++) {
    for (let x = bx0; x < bx1; x++) {
      const v = mag[y * width + x];
      if (v > thresh) {
        const dx = x - cx;
        const dy = y - cy;
        vxx += dx * dx * v;
        vyy += dy * dy * v;
        vxy += dx * dy * v;
      }
    }
  }
  vxx /= sw;
  vyy /= sw;
  vxy /= sw;
  const theta = 0.5 * Math.atan2(2 * vxy, vxx - vyy);
  const tr = vxx + vyy;
  const det = vxx * vyy - vxy * vxy;
  const disc = Math.sqrt(Math.max(0, tr * tr - 4 * det));
  let l1 = (tr + disc) / 2;
  let l2 = (tr - disc) / 2;
  if (l1 < l2) {
    const t = l1;
    l1 = l2;
    l2 = t;
  }
  l1 = Math.sqrt(Math.max(1, l1));
  l2 = Math.sqrt(Math.max(1, l2));
  const rx = Math.min(width, l1 * 1.9);
  const ry = Math.min(height, l2 * 1.9);
  return { cx, cy, rx, ry, angle: theta, valid: true };
}

/* ------------------------------------------------------------------ */
/* Master analysis object                                              */
/* ------------------------------------------------------------------ */

/** Classify each edge pixel into a strength tier (contour/structure/detail). */
function computeEdgeTiers(mag, width, height, baseThresh) {
  const n = width * height;
  const tier = new Uint8Array(n);
  const values = [];
  for (let i = 0; i < n; i++) {
    if (mag[i] >= baseThresh) values.push(mag[i]);
  }
  values.sort((a, b) => b - a); // descending
  const count = values.length;
  let contourTh = 1;
  let structureTh = 1;
  if (count > 0) {
    contourTh = values[Math.min(count - 1, Math.floor(count * 0.13))];
    structureTh = values[Math.min(count - 1, Math.floor(count * 0.45))];
  }
  for (let i = 0; i < n; i++) {
    const m = mag[i];
    if (m >= contourTh) tier[i] = 1;
    else if (m >= structureTh) tier[i] = 2;
    else if (m >= baseThresh) tier[i] = 3;
  }
  return { tier, count, contourTh, structureTh };
}

/** Bucketed importance histogram for a pixel subset. */
function makeRevealHist(importance, tier, width, height, wantTier) {
  const buckets = 1024;
  const hist = new Float64Array(buckets);
  let count = 0;
  for (let i = 0; i < importance.length; i++) {
    if (tier[i] !== wantTier) continue;
    const b = Math.min(buckets - 1, (importance[i] * (buckets - 1)) | 0);
    hist[b]++;
    count++;
  }
  return { hist, count };
}

/** Threshold that keeps the top `frac` of a tier's pixels by importance. */
function revealFromHist(hist, count, frac) {
  if (count === 0) return Infinity;
  if (frac >= 1) return 0;
  const target = Math.max(1, frac * count);
  let acc = 0;
  for (let b = 1023; b >= 0; b--) {
    acc += hist[b];
    if (acc >= target) return b / 1023;
  }
  return 0;
}

/** Ellipse-relative soft subject mask (1 = subject, low = background). */
function subjectMaskFor(width, height, ellipse, minMask) {
  const mask = new Float32Array(width * height);
  const ex = ellipse.cx;
  const ey = ellipse.cy;
  const rx = Math.max(1, ellipse.rx);
  const ry = Math.max(1, ellipse.ry);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const dx = (x - ex) / rx;
      const dy = (y - ey) / ry;
      const d = Math.sqrt(dx * dx + dy * dy);
      let m = 1;
      if (d > 1.25) m = 1 - (1 - minMask) * Math.min(1, (d - 1.25) / 0.75);
      mask[y * width + x] = Math.max(minMask, Math.min(1, m));
    }
  }
  return mask;
}

function buildAnalysis(img) {
  const width = img.bitmap.width;
  const height = img.bitmap.height;
  const lum = luminanceArray(img);
  const lumS = smoothLum(lum, width, height, 1.2); // noise reduction
  const stats = analyzeLum(lum, width, height);
  const mag = sobel(lumS, width, height);
  const faceBox = detectFaceBox(img);
  const classification = classifySubject(stats, faceBox, lum, mag, width, height);
  let ellipse = fitSubjectEllipse(mag, lum, width, height);

  // For portraits, re-fit the construction ellipse to the head region so the
  // "head shape" guide actually frames the head rather than the whole figure.
  if (classification.subjectType === "portrait") {
    const lm = faceBox && faceBox.landmarks;
    if (lm) {
      const hw = Math.max(8, lm.headW * 0.5);
      const hh = Math.max(8, lm.headH * 0.55);
      ellipse = { cx: lm.cx, cy: (lm.headTop + lm.headBottom) / 2, rx: hw, ry: hh, angle: 0, valid: true };
    } else {
      const headBand = {
        x0: width * 0.15,
        y0: height * 0.05,
        x1: width * 0.85,
        y1: height * 0.62,
      };
      const head = fitSubjectEllipse(mag, lum, width, height, headBand);
      if (head.valid && head.rx > 0 && head.ry > 0) {
        head.angle = 0; // heads are roughly axis-aligned
        ellipse = head;
      }
    }
  }

  const profile = renderProfile(classification.subjectType, classification, "detailed");
  const baseThresh = profile.baseThresh;
  const { tier, count: edgeCount } = computeEdgeTiers(mag, width, height, baseThresh);
  const mask = subjectMaskFor(width, height, ellipse, profile.minMask);

  // Importance: gradient strength shaped by subject mask and face emphasis.
  const importance = new Float32Array(width * height);
  const faceW = faceBox ? faceBox.w : 0;
  const faceH = faceBox ? faceBox.h : 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      let faceF = 1;
      if (faceBox && classification.subjectType === "portrait") {
        faceF = x > faceBox.x && x < faceBox.x + faceW && y > faceBox.y && y < faceBox.y + faceH ? 1.6 : 0.9;
      }
      importance[i] = mag[i] * (0.35 + 0.65 * mask[i]) * faceF;
    }
  }

  const histContour = makeRevealHist(importance, tier, width, height, 1);
  const histStructure = makeRevealHist(importance, tier, width, height, 2);
  const histDetail = makeRevealHist(importance, tier, width, height, 3);

  return {
    width,
    height,
    lum,
    mag,
    importance,
    mask,
    tier,
    edgeCount,
    histContour,
    histStructure,
    histDetail,
    stats,
    faceBox,
    classification,
    ellipse,
    profile,
  };
}

/* ------------------------------------------------------------------ */
/* Render profile (subject-specific drawing parameters)                */
/* ------------------------------------------------------------------ */

function renderProfile(subjectType, classification, mode) {
  const p = {
    subjectType,
    baseThresh: 0.045,
    shadingStartT: 0.48,
    shadingMax: mode === "easy" ? 0.55 : mode === "detailed" ? 0.72 : 1,
    revealStart: 0.12,
    revealPow: 0.85,
    minMask: 0.4,
    contourRampEnd: 0.4,
    structureRampStart: 0.3,
    structureRampEnd: 0.78,
    detailRampStart: 0.6,
    lineBase: 0.7,
  };
  switch (subjectType) {
    case "portrait":
      return {
        ...p,
        baseThresh: 0.038,
        minMask: 0.22,
        revealStart: 0.09,
        revealPow: 0.92,
        shadingStartT: 0.55,
      };
    case "animal":
      return { ...p, baseThresh: 0.04, minMask: 0.3, revealStart: 0.12, shadingStartT: 0.5 };
    case "vehicle":
      return { ...p, baseThresh: 0.05, minMask: 0.32, revealStart: 0.12, shadingStartT: 0.5 };
    case "object":
      return { ...p, baseThresh: 0.05, minMask: 0.35, revealStart: 0.1, shadingStartT: 0.5 };
    case "landscape":
      return { ...p, baseThresh: 0.05, minMask: 0.88, revealStart: 0.16, revealPow: 0.78, shadingStartT: 0.62 };
    default:
      return p;
  }
}

/* ------------------------------------------------------------------ */
/* Ink rendering                                                       */
/* ------------------------------------------------------------------ */

function drawEllipse(ink, width, height, e, alpha) {
  if (!e || !e.valid) return;
  const { cx, cy, rx, ry, angle } = e;
  const cos = Math.cos(-angle);
  const sin = Math.sin(-angle);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const dx = x - cx;
      const dy = y - cy;
      const rxr = dx * cos - dy * sin;
      const ryr = dx * sin + dy * cos;
      const a = rxr / rx;
      const b = ryr / ry;
      const v = a * a + b * b;
      if (Math.abs(v - 1) < 0.035) {
        const i = y * width + x;
        ink[i] = Math.min(1, ink[i] + alpha * (1 - Math.abs(v - 1) / 0.035));
      }
    }
  }
}

function drawLine(ink, width, height, x0, y0, x1, y1, alpha) {
  const steps = Math.ceil(Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0)) * 2);
  for (let s = 0; s <= steps; s++) {
    const t = s / steps;
    const x = Math.round(x0 + (x1 - x0) * t);
    const y = Math.round(y0 + (y1 - y0) * t);
    if (x >= 0 && x < width && y >= 0 && y < height) {
      ink[y * width + x] = Math.min(1, ink[y * width + x] + alpha);
    }
  }
}

function drawRectOutline(ink, width, height, x, y, w, h, alpha) {
  drawLine(ink, width, height, x, y, x + w, y, alpha);
  drawLine(ink, width, height, x + w, y, x + w, y + h, alpha);
  drawLine(ink, width, height, x + w, y + h, x, y + h, alpha);
  drawLine(ink, width, height, x, y + h, x, y, alpha);
}

/**
 * Draw the construction guide stage (pure guides, no edges): subject oval,
 * centerlines, and — for portraits — eye/nose/mouth guide lines aligned to
 * the detected landmarks. Used for Step 1-3 so the first stage never looks
 * like a finished edge filter.
 */
function renderConstruction(ink, width, height, analysis, alpha, mode) {
  const { ellipse, classification } = analysis;
  const cls = classification || {};
  const lm = cls.landmarks;
  if (!ellipse) return;
  const a = Math.min(1, alpha);

  // Subject oval.
  drawEllipse(ink, width, height, ellipse, a * 0.9);

  if (cls.subjectType === "portrait" && lm) {
    // Vertical centerline through the detected head axis.
    drawLine(ink, width, height, lm.cx, lm.headTop - lm.headH * 0.15, lm.cx, lm.headBottom + lm.headH * 0.2, a * 0.6);
    if (lm.profile) {
      // For profiles draw a facial-direction guide instead of symmetry lines:
      // a slanted line from forehead toward the nose/chin on the facing side.
      const dir = lm.profileDir || 1;
      const noseTip = lm.cx + (lm.headW * 0.3) * dir;
      const chinX = lm.cx + (lm.headW * 0.42) * dir;
      drawLine(ink, width, height, lm.cx, lm.headTop + lm.headH * 0.12, noseTip, lm.noseY, a * 0.6);
      drawLine(ink, width, height, noseTip, lm.noseY, chinX, lm.chinY, a * 0.6);
      drawLine(ink, width, height, lm.cx, lm.headBottom - lm.headH * 0.05, chinX, lm.chinY, a * 0.5);
    } else {
      // Horizontal guide lines: eye line, nose line, mouth line.
      drawLine(ink, width, height, lm.cx - lm.headW * 0.55, lm.eyeY, lm.cx + lm.headW * 0.55, lm.eyeY, a * 0.65);
      drawLine(ink, width, height, lm.cx - lm.headW * 0.5, lm.noseY, lm.cx + lm.headW * 0.5, lm.noseY, a * 0.55);
      drawLine(ink, width, height, lm.cx - lm.headW * 0.5, lm.mouthY, lm.cx + lm.headW * 0.5, lm.mouthY, a * 0.55);
    }
    return;
  }

  // Generic construction for other subjects: centerlines + ground anchor.
  const gAlpha = a * 0.6;
  drawLine(ink, width, height, ellipse.cx, Math.max(0, ellipse.cy - ellipse.ry * 1.2), ellipse.cx, Math.min(height, ellipse.cy + ellipse.ry * 1.2), gAlpha);
  drawLine(ink, width, height, Math.max(0, ellipse.cx - ellipse.rx * 1.2), ellipse.cy, Math.min(width, ellipse.cx + ellipse.rx * 1.2), ellipse.cy, gAlpha);
  if (cls.subjectType !== "landscape") {
    // Ground line so object/animal/car drawings read as anchored early.
    const gy = ellipse.cy + ellipse.ry * 1.05;
    if (gy < height) drawLine(ink, width, height, Math.max(0, ellipse.cx - ellipse.rx * 1.1), gy, Math.min(width, ellipse.cx + ellipse.rx * 1.1), gy, a * 0.4);
  }

  // Construction guides are thin by nature and would vanish under the box
  // blur; give the early steps (high alpha) visibly heavier strokes so the
  // "basic big shapes" actually read as a step.
  if (a >= 0.45) dilateInk(ink, width, height, a >= 0.8 ? 2 : 1);
}

/** Widen existing ink strokes (thicker pencil lines / guide lines). */
function dilateInk(ink, width, height, radius) {
  const src = new Float32Array(ink);
  const r = Math.max(1, radius);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const v = src[y * width + x];
      if (v <= 0.001) continue;
      for (let oy = -r; oy <= r; oy++) {
        for (let ox = -r; ox <= r; ox++) {
          const nx = x + ox;
          const ny = y + oy;
          if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;
          const d = Math.sqrt(ox * ox + oy * oy) / (r + 1);
          ink[ny * width + nx] = Math.min(1, ink[ny * width + nx] + v * 0.6 * (1 - d));
        }
      }
    }
  }
}

/**
 * Build the ink (darkness) map for one stage.
 * opts: {
 *   analysis, reveal (0..1), constructionOpacity (0..1), lineOpacity (0..1),
 *   shadingAmount (0..1), thickness (1..3), shadowMap (Float32|null),
 *   profile (render profile)
 * }
 */
function renderInk(opts) {
  const { analysis, reveal, constructionOpacity, lineOpacity, shadingAmount, thickness, shadowMap } = opts;
  const { width, height, mag, importance, ellipse, tier, histContour, histStructure, histDetail, profile } = analysis;
  const n = width * height;
  const ink = new Float32Array(n);

  // 1) Construction guides (pure shapes for the early steps).
  if (constructionOpacity > 0.02) {
    renderConstruction(ink, width, height, analysis, constructionOpacity, profile.subjectType);
  }

  // 2) Revealed edges by tier: contours first, structure next, details last.
  //    This guarantees early steps are simple shapes and the final step is
  //    the richest — not just an opacity-faded copy of the same edge map.
  const r = Math.min(1, Math.max(0, reveal));
  const fc = Math.max(0, Math.min(1, r / (profile.contourRampEnd || 0.4)));
  const fs = Math.max(0, Math.min(1, (r - profile.structureRampStart) / (profile.structureRampEnd - profile.structureRampStart)));
  const fd = Math.max(0, Math.min(1, (r - profile.detailRampStart) / (1 - profile.detailRampStart)));
  const tC = revealFromHist(histContour.hist, histContour.count, fc);
  const tS = revealFromHist(histStructure.hist, histStructure.count, fs);
  const tD = revealFromHist(histDetail.hist, histDetail.count, fd);

  const centerX = ellipse.cx;
  const centerY = ellipse.cy;
  const cMax = Math.max(0.1, Math.max(width, height) * 0.5);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      const t = tier[i];
      let pass = false;
      if (t === 1) pass = importance[i] >= tC;
      else if (t === 2) pass = importance[i] >= tS;
      else if (t === 3) pass = importance[i] >= tD;
      if (!pass) continue;

      // Squash the gradient so weaker edges still read as a pencil line.
      const strength = 0.38 + 0.62 * mag[i];
      let a = strength * lineOpacity;
      // Edges closer to the subject center render slightly stronger (lead lines).
      const dx = x - centerX;
      const dy = y - centerY;
      const d = Math.sqrt(dx * dx + dy * dy) / cMax;
      a *= 0.85 + 0.35 * (1 - Math.min(1, d));
      ink[i] = Math.min(1, ink[i] + a);
      if (thickness > 1.05) {
        const rr = Math.round(thickness - 0.5);
        for (let oy = -rr; oy <= rr; oy++) {
          for (let ox = -rr; ox <= rr; ox++) {
            if (ox === 0 && oy === 0) continue;
            const nx = x + ox;
            const ny = y + oy;
            if (nx >= 0 && nx < width && ny >= 0 && ny < height) {
              ink[ny * width + nx] = Math.min(1, ink[ny * width + nx] + a * 0.35);
            }
          }
        }
      }
    }
  }

  // 3) Shading (hatching) guided by the shadow map.
  if (shadingAmount > 0 && shadowMap) {
    const spacing = Math.max(3, 7 - Math.round(shadingAmount * 3));
    const stroke = 1.6;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const tone = shadowMap[y * width + x];
        if (tone <= 0.03) continue;
        const phase = ((x + y) % spacing) / spacing;
        if (phase < stroke / spacing) {
          ink[y * width + x] = Math.min(1, ink[y * width + x] + tone * 0.9 * shadingAmount);
        }
        // Soft cross-hatch wash for mass.
        ink[y * width + x] = Math.min(1, ink[y * width + x] + tone * 0.05 * shadingAmount);
      }
    }
  }

  return ink;
}

async function composeToJimp(ink, width, height, paperColor, soft) {
  const img = await Jimp.create(width, height, 0xff000000);
  const { data } = img.bitmap;
  const p = paperColor;
  // Slight deterministic grain so the paper feels tactile.
  let seed = 12345;
  const rnd = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  for (let i = 0; i < ink.length; i++) {
    const g = ink[i];
    const g2 = g * g;
    const grain = (rnd() - 0.5) * 2.5;
    const r = Math.max(0, Math.min(255, p.r * (1 - g2) + INK.r * g2 + grain));
    const gg = Math.max(0, Math.min(255, p.g * (1 - g2) + INK.g * g2 + grain));
    const b = Math.max(0, Math.min(255, p.b * (1 - g2) + INK.b * g2 + grain));
    const j = i * 4;
    data[j] = r;
    data[j + 1] = gg;
    data[j + 2] = b;
    data[j + 3] = 255;
  }
  return img;
}

/** Soften ink map with a quick box blur (radius) - graphite feel. */
function boxBlur(map, width, height, radius) {
  const r = Math.max(1, Math.round(radius));
  const src = new Float32Array(map);
  const n = width * height;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let sum = 0;
      let cnt = 0;
      for (let oy = -r; oy <= r; oy++) {
        const ny = y + oy;
        if (ny < 0 || ny >= height) continue;
        for (let ox = -r; ox <= r; ox++) {
          const nx = x + ox;
          if (nx < 0 || nx >= width) continue;
          sum += src[ny * width + nx];
          cnt++;
        }
      }
      map[y * width + x] = sum / cnt;
    }
  }
  return map;
}

/* ------------------------------------------------------------------ */
/* Shadow map (for shading stages)                                     */
/* ------------------------------------------------------------------ */

async function buildShadowMap(img, lum) {
  // Downscale luminance, heavily blur, upscale -> smooth tone map.
  const w = img.getWidth();
  const h = img.getHeight();
  const small = 96;
  const sw = Math.max(8, Math.round((w / h) * small));
  const sh = Math.max(8, Math.round((h / w) * small));
  const tile = await Jimp.create(sw, sh, 0xffffffff);
  const { data } = tile.bitmap;
  for (let y = 0; y < sh; y++) {
    const sy = Math.min(h - 1, Math.round((y / sh) * h));
    for (let x = 0; x < sw; x++) {
      const sx = Math.min(w - 1, Math.round((x / sw) * w));
      const v = Math.round(lum[sy * w + sx] * 255);
      const i = (y * sw + x) * 4;
      data[i] = v;
      data[i + 1] = v;
      data[i + 2] = v;
    }
  }
  tile.blur(10);
  const big = tile.resize(w, h, Jimp.RESIZE_BILINEAR);
  const bigLum = luminanceArray(big);
  const shadow = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) {
    // darkness = how far the area is from "bright paper".
    shadow[i] = Math.max(0, Math.min(1, (0.88 - bigLum[i]) / 0.75));
  }
  return shadow;
}

/* ------------------------------------------------------------------ */
/* Public API                                                          */
/* ------------------------------------------------------------------ */

/**
 * Full generation: returns an array of jimp images, one per step,
 * plus the analysis summary and the final sketch image.
 */
async function generateSteps({ buffer, mode, stepCount, shading, thickness }) {
  let src;
  try {
    src = await Jimp.read(buffer);
  } catch {
    const err = new Error("Could not read the uploaded image. The file may be corrupted or unsupported.");
    err.code = "INVALID_IMAGE";
    throw err;
  }

  // Fix EXIF orientation.
  if (typeof src.autoOrient === "function") {
    try {
      src.autoOrient();
    } catch {
      /* orientation not available in this format */
    }
  }

  // Cap dimensions (intelligent resize keeps aspect).
  const maxDim = config.maxImageDim;
  const w0 = src.getWidth();
  const h0 = src.getHeight();
  const scale = Math.min(1, maxDim / Math.max(w0, h0));
  if (scale < 1) {
    src.resize(Math.max(1, Math.round(w0 * scale)), Math.max(1, Math.round(h0 * scale)), Jimp.RESIZE_BILINEAR);
  }

  const analysis = buildAnalysis(src);
  const profile = analysis.profile;
  // Shading intensity depends on the mode, which analysis time doesn't know.
  profile.shadingMax = mode === "easy" ? 0.55 : mode === "detailed" ? 0.72 : 1;
  // Very dark reference photos would otherwise render near-black finals;
  // hold the pencil back so the result stays readable on paper.
  const darkSource = (analysis.classification.brightness || 0.5) < 0.5;
  const shadowMap = shading ? await buildShadowMap(src, analysis.lum) : null;
  const stepCountSafe = [6, 8, 10, 12].includes(Number(stepCount)) ? Number(stepCount) : 8;

  const full = buildRevealCurve(mode, stepCountSafe, profile);
  const thick = Number(thickness) || 1.3;

  const images = [];
  for (let s = 0; s < stepCountSafe; s++) {
    const t = s / (stepCountSafe - 1);
    // Step 1 is the construction skeleton only (big shapes / guides, no edge
    // lines yet) so the leap to "proportion guides" in step 2 is visible.
    const reveal = s === 0 ? 0 : full[s];
    const constructionOpacity = Math.max(0, 1 - t * 1.7);
    const lineOpacity =
      (profile.lineBase || 0.7) + (1 - (profile.lineBase || 0.7)) * t * (darkSource ? 0.8 : 1);
    let shadingAmount = 0;
    if (shading && t > profile.shadingStartT) {
      shadingAmount =
        Math.min(1, (t - profile.shadingStartT) / (1 - profile.shadingStartT)) *
        profile.shadingMax *
        (darkSource ? 0.75 : 1);
    }
    const ink = renderInk({
      analysis,
      reveal,
      constructionOpacity,
      lineOpacity,
      shadingAmount,
      thickness: t > 0.25 ? thick : Math.max(1, thick - 0.4),
      shadowMap,
      profile,
    });
    boxBlur(ink, analysis.width, analysis.height, 0.8);
    const composed = await composeToJimp(ink, analysis.width, analysis.height, PAPER, true);
    images.push(composed);
  }

  return { images, analysis };
}

function buildRevealCurve(mode, stepCount, profile) {
  const out = [];
  const total = stepCount;
  const start = profile ? profile.revealStart : 0.12;
  const pow = profile ? profile.revealPow : 0.85;
  for (let i = 0; i < total; i++) {
    const t = i / (total - 1);
    out.push(start + (1 - start) * Math.pow(t, pow));
  }
  return out;
}

/** Extract trace-mode line art (client also mirrors this in a Web Worker). */
async function extractTrace({ buffer, mode, detail, thickness }) {
  let src;
  try {
    src = await Jimp.read(buffer);
  } catch {
    const err = new Error("Could not read the uploaded image.");
    err.code = "INVALID_IMAGE";
    throw err;
  }
  if (typeof src.autoOrient === "function") {
    try {
      src.autoOrient();
    } catch {}
  }
  const maxDim = Math.min(config.maxImageDim, 1400);
  const w0 = src.getWidth();
  const h0 = src.getHeight();
  const scale = Math.min(1, maxDim / Math.max(w0, h0));
  if (scale < 1) {
    src.resize(Math.round(w0 * scale), Math.round(h0 * scale), Jimp.RESIZE_BILINEAR);
  }
  const lum = luminanceArray(src);
  const { width, height } = src.bitmap;
  const mag = sobel(smoothLum(lum, width, height), width, height);

  const detailVal = Math.max(0, Math.min(100, Number(detail) || 50));
  const thickVal = Math.max(0, Math.min(100, Number(thickness) || 40));

  let threshLow = 0.26 - (detailVal / 100) * 0.18; // lower threshold -> more edges
  let threshHigh = threshLow + 0.16;
  const lift = detailVal > 60 ? 0.1 : 0;

  const ink = new Float32Array(width * height);
  const r = thickVal > 55 ? 1 : 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      const m = mag[i];
      // Squash so lines read as pencil strokes rather than faint gray.
      const a = Math.min(1, 0.35 + 0.9 * m);
      if (mode === "outline" && m > threshHigh + 0.08) {
        ink[i] = Math.min(1, ink[i] + a);
      } else if (mode === "clean" && m > threshHigh + (0.04 - detailVal * 0.001)) {
        ink[i] = Math.min(1, ink[i] + Math.max(0, a - lift));
      } else if (mode === "detailed" && m > threshLow) {
        ink[i] = Math.min(1, ink[i] + a);
      }
      if (r && ink[i] > 0) {
        const nx = x + 1;
        if (nx < width) ink[i + 1] = Math.min(1, ink[i + 1] + a * 0.5);
      }
    }
  }
  boxBlur(ink, width, height, 0.6);
  const out = await composeToJimp(ink, width, height, { r: 255, g: 255, b: 252 }, true);
  const buf = await out.getBufferAsync(Jimp.MIME_JPEG);
  return { buffer: buf, width, height };
}

module.exports = {
  generateSteps,
  extractTrace,
  buildAnalysis,
  luminanceArray,
  sobel,
  hexToRgb,
  PAPER,
  INK,
  detectFaceGeometry,
  classifySubject,
  smoothLum,
};
