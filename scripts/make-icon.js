#!/usr/bin/env node
/**
 * Generates the Copilot Pulse marketplace icon as a PNG — no external deps,
 * uses only Node's built-in zlib. Produces a 256x256 icon: a dark blue→purple
 * rounded tile with a glowing cyan "pulse" (ECG-style) waveform + a spark dot.
 */
const zlib = require("zlib");
const fs = require("fs");
const path = require("path");

const S = 256;                 // canvas size
const RADIUS = 52;             // rounded-corner radius
const buf = Buffer.alloc(S * S * 4);

// ---- helpers ---------------------------------------------------------------
const lerp = (a, b, t) => a + (b - a) * t;
const clamp01 = (x) => Math.max(0, Math.min(1, x));

function setPx(x, y, r, g, b, a) {
  if (x < 0 || y < 0 || x >= S || y >= S) return;
  const i = (y * S + x) * 4;
  // alpha-over compositing onto whatever is already there
  const dstA = buf[i + 3] / 255;
  const srcA = a;
  const outA = srcA + dstA * (1 - srcA);
  if (outA <= 0) return;
  for (let k = 0; k < 3; k++) {
    const src = [r, g, b][k];
    const dst = buf[i + k];
    buf[i + k] = Math.round((src * srcA + dst * dstA * (1 - srcA)) / outA);
  }
  buf[i + 3] = Math.round(outA * 255);
}

// rounded-rect coverage (1 inside, 0 outside, soft edge)
function tileCoverage(x, y) {
  const rx = Math.min(x, S - 1 - x);
  const ry = Math.min(y, S - 1 - y);
  if (rx >= RADIUS || ry >= RADIUS) return 1;
  const dx = RADIUS - rx;
  const dy = RADIUS - ry;
  const d = Math.sqrt(dx * dx + dy * dy);
  return clamp01(RADIUS - d + 0.5);
}

// distance from point to a segment
function distToSeg(px, py, ax, ay, bx, by) {
  const vx = bx - ax, vy = by - ay;
  const wx = px - ax, wy = py - ay;
  const c1 = vx * wx + vy * wy;
  if (c1 <= 0) return Math.hypot(px - ax, py - ay);
  const c2 = vx * vx + vy * vy;
  if (c2 <= c1) return Math.hypot(px - bx, py - by);
  const t = c1 / c2;
  return Math.hypot(px - (ax + t * vx), py - (ay + t * vy));
}

// ---- 1. background gradient + rounded tile ---------------------------------
const TL = [0x14, 0x22, 0x48];  // dark blue
const BR = [0x3b, 0x10, 0x66];  // deep purple
for (let y = 0; y < S; y++) {
  for (let x = 0; x < S; x++) {
    const t = (x + y) / (2 * (S - 1));     // diagonal
    const r = Math.round(lerp(TL[0], BR[0], t));
    const g = Math.round(lerp(TL[1], BR[1], t));
    const b = Math.round(lerp(TL[2], BR[2], t));
    const cov = tileCoverage(x, y);
    const i = (y * S + x) * 4;
    buf[i] = r; buf[i + 1] = g; buf[i + 2] = b; buf[i + 3] = Math.round(cov * 255);
  }
}

// subtle inner vignette highlight (top-left glow)
for (let y = 0; y < S; y++) {
  for (let x = 0; x < S; x++) {
    const d = Math.hypot(x - 80, y - 70) / 180;
    const glow = clamp01(1 - d) * 0.10;
    if (glow > 0) setPx(x, y, 90, 160, 255, glow);
  }
}

// ---- 2. pulse (ECG) waveform ----------------------------------------------
// A flat line that spikes up, dips down, and returns — the "Pulse" brand.
const cy = 138;
const pts = [
  [34, cy], [78, cy], [96, cy - 6], [110, cy - 64],
  [126, cy + 70], [140, cy - 20], [154, cy], [222, cy]
];

const CORE = [0xe6, 0xfb, 0xff]; // near-white cyan
const NEON = [0x22, 0xd3, 0xee]; // cyan
const stroke = 5.5;

for (let y = 0; y < S; y++) {
  for (let x = 0; x < S; x++) {
    // nearest distance to the polyline
    let dmin = Infinity;
    for (let s = 0; s < pts.length - 1; s++) {
      const d = distToSeg(x + 0.5, y + 0.5, pts[s][0], pts[s][1], pts[s + 1][0], pts[s + 1][1]);
      if (d < dmin) dmin = d;
    }
    // outer glow
    const glow = clamp01((stroke + 10 - dmin) / 14) * 0.5;
    if (glow > 0) setPx(x, y, NEON[0], NEON[1], NEON[2], glow * 0.6);
    // neon body
    const body = clamp01(stroke + 1.5 - dmin);
    if (body > 0) setPx(x, y, NEON[0], NEON[1], NEON[2], body);
    // bright core
    const core = clamp01(stroke - 2 - dmin);
    if (core > 0) setPx(x, y, CORE[0], CORE[1], CORE[2], core);
  }
}

// spark dot at the peak
function disc(cxp, cyp, rad, col, aScale) {
  for (let y = Math.floor(cyp - rad - 2); y <= cyp + rad + 2; y++) {
    for (let x = Math.floor(cxp - rad - 2); x <= cxp + rad + 2; x++) {
      const d = Math.hypot(x + 0.5 - cxp, y + 0.5 - cyp);
      const a = clamp01(rad - d) * aScale;
      if (a > 0) setPx(x, y, col[0], col[1], col[2], a);
    }
  }
}
disc(110, cy - 64, 9, NEON, 0.5);
disc(110, cy - 64, 5, CORE, 1);

// ---- 3. encode PNG ---------------------------------------------------------
function png(width, height, rgba) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });

  const crcTable = (() => {
    const t = [];
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })();
  const crc32 = (b) => {
    let c = 0xffffffff;
    for (let i = 0; i < b.length; i++) c = crcTable[(c ^ b[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length, 0);
    const t = Buffer.from(type, "ascii");
    const body = Buffer.concat([t, data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body), 0);
    return Buffer.concat([len, body, crc]);
  };

  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // color type RGBA
  return Buffer.concat([sig, chunk("IHDR", ihdr), chunk("IDAT", idat), chunk("IEND", Buffer.alloc(0))]);
}

const out = path.join(__dirname, "..", "icon.png");
fs.writeFileSync(out, png(S, S, buf));
console.log("wrote", out, "(" + S + "x" + S + ")");


