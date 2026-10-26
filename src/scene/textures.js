import * as THREE from 'three';
import { seededRandom as mulberry32 } from '../util.js'; // seeded, so the floor looks the same on every load

const hsl = (h, s, l, a = 1) => `hsla(${h.toFixed(1)},${s.toFixed(1)}%,${l.toFixed(1)}%,${a.toFixed(3)})`;

// ---- Oak parquet ------------------------------------------------------------
//
// Measured from the photos (floor rectified to a top view from the vanishing points,
// scaled by the 0.85 m door opening and cross-checked against the 6 cm baseboard):
//  - loose oak staves ("Stabparkett"), not 3-strip boards: no stronger joint every
//    third strip, and no end joints lined up across three strips;
//  - every stave is the same size, about 73 × 485 mm (56 across the 4.10 m room);
//  - irregular bond: each row's end joints are shifted against the neighbour's by
//    roughly 0.2–0.8 of a stave length, otherwise at random;
//  - mid honey/tan oak with fairly gentle stave-to-stave variation (σ ≈ 11 % in
//    brightness); darker staves are redder, lighter ones paler and yellower; a few
//    noticeably blonde or brown ones;
//  - mostly flat-sawn grain (wavy lines and the odd cathedral arch), some rift/quarter
//    sawn staves with straight grain and pale ray flecks, a rare small knot;
//  - joints are hairlines: mostly you see a stave by its tone, not by a dark gap.
const STAVE_W = 0.073; // m, across
const STAVE_L = 0.485; // m, along the room's length
// Albedo, calibrated against the white wall so it doesn't depend on lighting or camera.
// Four photo pairs of floor and white wall next to each other (same light, no sun, away
// from window reflections) give a linear floor/wall luminance ratio of 0.26–0.33 (median
// 0.31) and, relative to the wall, R/G ≈ 1.74 and B/G ≈ 0.40 (medians). With the model's
// wall albedo (0xf2f0eb ≈ 0.887, 0.871, 0.831 linear) that puts the floor's average at
// ≈ (0.427, 0.241, 0.092) linear, sRGB #ae8755. OAK is the median stave; the finished
// texture averages ~1.5 % darker (joints, grain), so it is set that much higher.
// The measured colour is then desaturated by about a third at the same luminance (R:B 4.6 →
// 3.1, ≈ sRGB #a7896a): phone JPEGs boost saturation, and lacquered oak is about R:B 3 in
// reflectance. Rendered with interreflections, an over-saturated floor tints the whole room.
const OAK = [0.394, 0.254, 0.127];

/**
 * Oak stave parquet matching the photos, running along the room's length
 * (canvas y = room z). The texture covers the whole floor once, so the pattern
 * never repeats.
 */
export function parquetTexture(widthM, lengthM, ppm = 400) {
  const steps = drawParquet(widthM, lengthM, ppm);
  let r;
  while (!(r = steps.next()).done);
  return r.value;
}

// The same, made a row of staves at a time with a pause in between, so it never holds up the
// first frame or input for long (on a phone the whole texture takes most of a second).
export async function parquetTextureAsync(widthM, lengthM, ppm = 400, pause = () => new Promise((r) => setTimeout(r, 0))) {
  const steps = drawParquet(widthM, lengthM, ppm);
  for (let r = steps.next(); ; r = steps.next()) {
    if (r.done) return r.value;
    await pause();
  }
}

// The parquet's average colour as an sRGB byte triple (the texture averages ~1.5 % under OAK).
export const PARQUET_AVERAGE = (() => {
  const s = (c) => Math.round(255 * (c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055));
  return OAK.map((c) => s(c * 0.985));
})();

function* drawParquet(widthM, lengthM, ppm) {
  ppm = Math.min(ppm, 4096 / widthM, 4096 / lengthM);
  const W = Math.round(widthM * ppm), H = Math.round(lengthM * ppm);
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const g = canvas.getContext('2d');
  const rnd = mulberry32(20250330);
  const img = g.createImageData(W, H);
  const lut = srgbLut();
  const sw = STAVE_W * ppm, sl = STAVE_L * ppm;

  // Rows of staves across the room, centred the way a fitter would lay them so the
  // strips cut to fit along both long walls come out equal and not too thin.
  const n = W / sw, frac = n - Math.floor(n);
  const left = ((frac < 0.5 ? 1 : 0) + frac) / 2 * sw - sw; // where the first (cut) row starts
  const cols = Math.ceil((W - left) / sw);

  // End-joint phase of each row of staves (irregular bond).
  const phase = [];
  for (let c = 0; c < cols; c++) {
    let p;
    for (let tries = 0; ; tries++) {
      p = c === 0 ? rnd() : (phase[c - 1] + (0.2 + 0.6 * rnd())) % 1;
      // Avoid two rows apart lining up exactly too, which reads as a staircase.
      if (c < 2 || tries > 8 || Math.abs(((p - phase[c - 2] + 1.5) % 1) - 0.5) > 0.07) break;
    }
    phase.push(p);
  }

  const marks = [];
  for (let c = 0; c < cols; c++) {
    const x0 = Math.round(left + c * sw), x1 = Math.round(left + (c + 1) * sw);
    for (let y = (phase[c] - 1) * sl; y < H; y += sl) {
      const y0 = Math.round(y), y1 = Math.round(y + sl);
      drawStave(img.data, W, H, x0, x1, y0, y1, ppm, rnd, lut, marks);
    }
    yield;
  }
  g.putImageData(img, 0, 0);
  drawMarks(g, marks, ppm);

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// Linear [0, 1] → sRGB byte, 4096 steps.
function srgbLut() {
  const lut = new Uint8ClampedArray(4096);
  for (let i = 0; i < 4096; i++) {
    const c = i / 4095;
    lut[i] = Math.round(255 * (c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055));
  }
  return lut;
}

// Smooth 1-D value noise sampled at n points spaced `step` apart, values in [-1, 1].
function noise1d(n, step, rnd) {
  const knots = Math.ceil(n * step) + 2;
  const k = Array.from({ length: knots + 1 }, () => rnd() * 2 - 1);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i * step, j = Math.floor(t), f = t - j, s = f * f * (3 - 2 * f);
    out[i] = k[j] + (k[j + 1] - k[j]) * s;
  }
  return out;
}

const gauss = (rnd) => (rnd() + rnd() + rnd() - 1.5) * 2; // ≈ N(0, 1)

// Shared smooth noise in [-1, 1] (knots every 8 entries), and the latewood band profile.
const NT_N = 8192, NT_M = NT_N - 1;
const NT = (() => {
  const r = mulberry32(99), k = Array.from({ length: NT_N / 8 }, () => r() * 2 - 1), t = new Float32Array(NT_N);
  for (let i = 0; i < NT_N; i++) {
    const j = i >> 3, f = (i & 7) / 8, s = f * f * (3 - 2 * f);
    t[i] = k[j] + (k[(j + 1) % k.length] - k[j]) * s;
  }
  return t;
})();
const BAND = Float32Array.from({ length: 256 }, (_, i) => Math.sin((i / 255) * Math.PI));

function drawStave(data, W, H, x0, x1, y0, y1, ppm, rnd, lut, marks) {
  // Colour: lognormal brightness, darker staves redder, plus a few outliers.
  let t = Math.exp(0.11 * gauss(rnd));
  const odd = rnd();
  if (odd < 0.05) t *= 1.25; // blonde
  else if (odd < 0.09) t *= 0.85; // brown
  const warm = 1 + 0.015 * gauss(rnd);
  const base = [
    OAK[0] * Math.pow(t, 0.73) * warm,
    OAK[1] * t,
    OAK[2] * Math.pow(t, 1.3) / warm,
  ];

  // Grain: growth rings where the sawn face cuts them. The pith sits `xc` mm across
  // from the stave's left edge and `d0` mm below its face; the log axis tilts by
  // `tilt` against the face, which is what draws arches along a flat-sawn stave.
  // Everything that varies with the ring radius r (uneven ring widths, broad light
  // and dark streaks) comes from one shared noise table, NT, indexed by r.
  const wmm = (x1 - x0) * 1000 / ppm;
  const flat = rnd() < 0.6;
  const xc = flat ? wmm * (0.15 + 0.7 * rnd()) : (rnd() < 0.5 ? -1 : 1) * (150 + 400 * rnd()) + wmm / 2;
  const d0 = flat ? 8 + 60 * rnd() : 2 + 20 * rnd();
  const tilt = (rnd() - 0.5) * (flat ? 0.06 : 0.02);
  const spacing = 2.2 + 2.8 * rnd(); // mm between latewood lines
  const ring = (flat ? 0.1 : 0.06) + 0.12 * rnd(); // how much darker the latewood is
  const wave = 0.5 + 3 * rnd(); // mm of sideways wander
  const jit = 0.8 + 1.2 * rnd(); // uneven ring widths (good and bad years), in rings
  const stripe = 0.05 + 0.06 * rnd(); // broad streaks, relative brightness
  const o1 = (rnd() * NT_N) | 0, o2 = (rnd() * NT_N) | 0, o3 = (rnd() * NT_N) | 0;
  const quarter = !flat && rnd() < 0.55;

  const mmPerPx = 1000 / ppm;
  const n = y1 - y0;
  const wander = noise1d(n, mmPerPx / (40 + 100 * rnd()), rnd);
  const drift = noise1d(n, mmPerPx / (120 + 200 * rnd()), rnd);
  const driftAmp = 0.03 + 0.05 * rnd();
  const phase0 = rnd() * 10;
  const invS = 1 / spacing;
  // Fine pore streaks, constant along the grain.
  const cw = x1 - x0;
  const streak = new Float32Array(cw);
  for (let i = 0, s = 0; i < cw; i++) streak[i] = 1 + (s = 0.5 * s + 0.12 * (rnd() - 0.5));

  const ya = Math.max(0, y0), yb = Math.min(H, y1), xa = Math.max(0, x0), xb = Math.min(W, x1);
  for (let y = ya; y < yb; y++) {
    const v = (y - y0) * mmPerPx;
    const d = d0 + tilt * v;
    const dd = d * d;
    const off = wave * wander[y - y0] - xc + 0.5 * mmPerPx;
    const along = (1 + driftAmp * drift[y - y0]) * (y === y0 ? 0.82 : y === y0 + 1 ? 0.96 : 1);
    let idx = (y * W + xa) * 4;
    for (let x = xa; x < xb; x++, idx += 4) {
      const u = (x - x0) * mmPerPx + off;
      const r = Math.sqrt(u * u + dd);
      // Latewood band: a soft line once per ring, faded where the rings crowd closer
      // than ~2 px (they'd only alias).
      const p = r * invS + phase0 + jit * NT[((r * 0.4) | 0) + o1 & NT_M];
      const f = p - Math.floor(p);
      const band = f > 0.55 ? BAND[((f - 0.55) * 566) | 0] : 0;
      const gap = spacing * r / ((u < 0 ? -u : u) + 1e-3) / mmPerPx; // px between lines
      const vis = gap > 3.5 ? 1 : gap < 1.6 ? 0 : (gap - 1.6) / 1.9;
      const broad = 1 + stripe * (NT[((r * 1.2) | 0) + o2 & NT_M] + 0.3 * NT[((r * 4) | 0) + o3 & NT_M]);
      let k = along * broad * streak[x - x0] * (1 - ring * vis * band);
      if (x === x0) k *= 0.84; // long joint
      else if (x === x1 - 1) k *= 0.96;
      data[idx] = lut[Math.min(4095, (base[0] * k * 4095) | 0)];
      data[idx + 1] = lut[Math.min(4095, (base[1] * k * 4095) | 0)];
      data[idx + 2] = lut[Math.min(4095, (base[2] * k * 4095) | 0)];
      data[idx + 3] = 255;
    }
  }

  // Ray flecks on the quarter-sawn staves, the odd pin knot; drawn afterwards.
  if (quarter) marks.push({ type: 'flecks', x0, x1, y0, y1, n: 4 + Math.floor(rnd() * 16), seed: rnd() * 1e9 });
  if (rnd() < 0.04) marks.push({ type: 'knot', x: x0 + cw * (0.25 + 0.5 * rnd()), y: y0 + (y1 - y0) * (0.1 + 0.8 * rnd()), s: 0.5 + rnd() });
}

function drawMarks(g, marks, ppm) {
  const mm = ppm / 1000;
  for (const m of marks) {
    const rnd = mulberry32(m.seed | 0);
    if (m.type === 'flecks') {
      g.fillStyle = 'rgba(232, 206, 164, 0.15)';
      for (let i = 0; i < m.n; i++) {
        const len = (5 + rnd() * 15) * mm, wid = (1 + rnd() * 1.5) * mm;
        const x = m.x0 + len * 0.5 + rnd() * Math.max(1, m.x1 - m.x0 - len);
        const y = m.y0 + 4 + rnd() * (m.y1 - m.y0 - 8);
        g.beginPath();
        g.ellipse(x, y, len / 2, wid / 2, (rnd() - 0.5) * 1.2, 0, Math.PI * 2);
        g.fill();
      }
    } else {
      g.fillStyle = 'rgba(70, 42, 20, 0.35)';
      g.beginPath();
      g.ellipse(m.x, m.y, (2.5 + 2 * m.s) * mm, (4 + 4 * m.s) * mm, 0, 0, Math.PI * 2);
      g.fill();
      g.fillStyle = 'rgba(48, 26, 12, 0.7)';
      g.beginPath();
      g.ellipse(m.x, m.y, (1 + m.s) * mm, (1.6 + 1.6 * m.s) * mm, 0, 0, Math.PI * 2);
      g.fill();
    }
  }
}

/** Terracotta brick tiles for the hallway beyond the entry door. */
export function tileTexture(widthM, depthM, ppm = 256) {
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(widthM * ppm);
  canvas.height = Math.round(depthM * ppm);
  const g = canvas.getContext('2d');
  const rnd = mulberry32(7);

  g.fillStyle = '#3d241b';
  g.fillRect(0, 0, canvas.width, canvas.height);

  const tw = 0.2 * ppm, th = 0.1 * ppm, gap = 1.5;
  for (let row = 0, y = 0; y < canvas.height; row++, y += th) {
    for (let x = row % 2 ? -tw / 2 : 0; x < canvas.width; x += tw) {
      g.fillStyle = hsl(11 + rnd() * 7, 36 + rnd() * 14, 29 + rnd() * 9);
      g.fillRect(x + gap, y + gap, tw - 2 * gap, th - 2 * gap);
    }
  }

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/** Plain cast concrete, as on the balcony floor: soft blotches and fine grit, tiling every metre. */
export function concreteTexture(ppm = 256) {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = ppm;
  const g = canvas.getContext('2d');
  const rnd = mulberry32(11);
  g.fillStyle = '#9a9893';
  g.fillRect(0, 0, ppm, ppm);
  // Blotches, drawn nine times over (shifted by the tile) so they wrap and the texture tiles.
  for (let i = 0; i < 40; i++) {
    const x = rnd() * ppm, y = rnd() * ppm, r = (0.05 + rnd() * 0.15) * ppm, l = 54 + rnd() * 10;
    for (const dx of [-ppm, 0, ppm]) for (const dy of [-ppm, 0, ppm]) {
      const grad = g.createRadialGradient(x + dx, y + dy, 0, x + dx, y + dy, r);
      grad.addColorStop(0, hsl(40, 4, l, 0.18));
      grad.addColorStop(1, hsl(40, 4, l, 0));
      g.fillStyle = grad;
      g.fillRect(x + dx - r, y + dy - r, 2 * r, 2 * r);
    }
  }
  // Grit: single pixels a little darker or lighter.
  const img = g.getImageData(0, 0, ppm, ppm);
  for (let i = 0; i < img.data.length; i += 4) {
    const d = (rnd() - 0.5) * 26;
    for (let c = 0; c < 3; c++) img.data[i + c] = Math.max(0, Math.min(255, img.data[i + c] + d));
  }
  g.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  return tex;
}
