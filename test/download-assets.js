"use strict";

/**
 * Downloads a small, legal, real-image test set from Wikimedia Commons
 * (public-domain / CC-licensed). Uses a curated list of verified, well-known
 * files per category, falling back to a Commons search when a title is not
 * available. Files land in test/assets/<category>.<ext>.
 *
 * Usage: node test/download-assets.js
 */

const fs = require("fs");
const path = require("path");

const OUT = path.join(__dirname, "assets");

const UA = "SketchFlowAI-test/1.0 (quality verification)";

const CATEGORIES = [
  ["portrait-front", ["File:Grace_Hopper.jpg"], "front facing human portrait face"],
  ["portrait-profile", ["File:Zitkala-Sa (side face).jpg"], "human face in profile side view photograph"],
  ["animal", ["File:Cat_close-up_2004_b.jpg"], "cat face close up"],
  ["object", ["File:Glass_bottle.jpg"], "glass bottle on table"],
  ["car", ["File:1965_Ford_Mustang.jpg"], "vintage car side view street"],
  ["landscape", ["File:Matterhorn_from_Domhütte_-_2.jpg"], "mountain lake landscape photograph"],
  ["complex", ["File:Spice_market.jpg"], "colorful street market"],
];

const EXTRA = [["large", ["File:Mount_Everest_from_Kala_Patthar.jpg"], "large mountain panorama"]];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchJson(url) {
  const res = await fetch(url, { headers: { "User-Agent": UA } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function downloadWithRetry(url, retries = 6) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, { headers: { "User-Agent": UA } });
      if (res.status === 429) {
        await sleep(3000 + attempt * 3000);
        continue;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length < 5000) throw new Error(`file too small (${buf.length})`);
      return buf;
    } catch (e) {
      if (attempt === retries) throw e;
      await sleep(attempt * 2500);
    }
  }
  throw new Error("download failed");
}

async function infoForTitles(titles) {
  const url =
    "https://commons.wikimedia.org/w/api.php?action=query&titles=" +
    encodeURIComponent(titles.join("|")) +
    "&prop=imageinfo&iiprop=url|size|mime&iiurlwidth=720&format=json";
  const data = await fetchJson(url);
  const out = {};
  for (const p of Object.values((data.query && data.query.pages) || {})) {
    if (p.imageinfo && p.imageinfo[0]) out[p.title] = p.imageinfo[0];
  }
  return out;
}

async function searchCommons(query, limit = 6) {
  const url =
    "https://commons.wikimedia.org/w/api.php?action=query&generator=search&gsrnamespace=6&gsrlimit=" + limit +
    "&gsrsearch=" + encodeURIComponent(query + " filetype:bitmap") +
    "&prop=imageinfo&iiprop=url|size|mime&iiurlwidth=720&format=json";
  const data = await fetchJson(url);
  return Object.values((data.query && data.query.pages) || {})
    .map((p) => (p.imageinfo ? p.imageinfo[0] : null))
    .filter((ii) => ii && ii.mime === "image/jpeg" && ii.width >= 240 && ii.height >= 180);
}

async function resolveImage(titles, searchQuery) {
  const info = await infoForTitles(titles);
  for (const t of titles) {
    const ii = info[t];
    if (ii) return ii;
  }
  const found = await searchCommons(searchQuery);
  if (found.length) return found[0];
  return null;
}

async function main() {
  const only = process.argv.includes("--only") ? process.argv[process.argv.indexOf("--only") + 1] : null;
  const filtered = only ? CATEGORIES.concat(EXTRA).filter(([cat]) => cat === only) : CATEGORIES.concat(EXTRA);
  fs.mkdirSync(OUT, { recursive: true });
  const Jimp = require("jimp");
  const results = [];
  for (const [cat, titles, query] of filtered) {
    try {
      const ii = await resolveImage(titles, query);
      if (!ii) throw new Error("no image found");
      const buf = await downloadWithRetry(ii.thumburl || ii.url);
      const img = await Jimp.read(buf);
      if (img.getWidth() < 240 || img.getHeight() < 180) throw new Error("decoded too small");
      const file = path.join(OUT, `${cat}.jpg`);
      await img.getBufferAsync(Jimp.MIME_JPEG).then((b) => fs.writeFileSync(file, b));
      results.push(`OK  ${cat.padEnd(18)} ${img.getWidth()}x${img.getHeight()}`);
    } catch (e) {
      results.push(`ERR ${cat.padEnd(18)} ${e.message}`);
    }
    await sleep(3000);
  }
  console.log(results.join("\n"));
  const failed = results.filter((r) => r.startsWith("ERR"));
  if (failed.length) {
    console.error(`${failed.length} downloads failed`);
    process.exitCode = 1;
  } else {
    console.log("All assets saved to", OUT);
  }
}

main();
