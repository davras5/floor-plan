// A fiddle-leaf fig (Ficus lyrata) grown as a standard: a bare stem out of a plain cylinder pot
// and a crown of big violin-shaped leaves from just above window-sill height (0.84 m) up to
// 1.5 m. Procedural (no CC0 scan of one exists), so it's sized for the window wall: the pot is
// narrow enough for the 30 cm strip behind the pouf, and the crown clears the wall below the sill.
//
// Writes a plain glTF binary (float geometry, PNG textures) with four parts:
//   pot     plain colour in baseColorFactor (no texture, no vertex colours), so it can be recoloured
//   soil    vertex colours
//   trunk   stem, branches and leaf stalks; vertex colours
//   leaves  one alpha-tested (MASK), double-sided material: a 2×2 atlas of four leaves with the
//           cut-out in the base colour's alpha channel, plus a normal map. Vertex colours tint
//           each leaf (young ones lighter) and darken the inside of the crown. KHR_materials_specular
//           lowers its specular (three.js makes it a MeshPhysicalMaterial).
// Metres, Y up, origin at the centre of the pot's base. scripts/plants/pack.mjs makes the web copy
// (WebP textures, meshopt) in assets/plants/fiddle-leaf-fig/.
//
// usage: node scripts/plants/fiddle-leaf-fig.mjs [out.glb] [--seed=N] [--pngs=<dir>]
//   out.glb   default raw/plants/fiddle-leaf-fig.glb (raw/ is gitignored)
//   --seed    another plant of the same kind (default 11)
//   --pngs    also write the leaf textures as PNG files to <dir>, to look at
import { mkdirSync, writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { dirname, join, resolve } from 'node:path';

const args = process.argv.slice(2);
const flags = Object.fromEntries(args.filter((a) => a.startsWith('--')).map((a) => {
  const [k, v = 'true'] = a.slice(2).split('=');
  return [k, v];
}));
const root = resolve(import.meta.dirname, '../..');
const out = resolve(args.find((a) => !a.startsWith('--')) ?? join(root, 'raw/plants/fiddle-leaf-fig.glb'));

// ---- Dimensions (m) -----------------------------------------------------------------------
// Ø 25 cm: fits the 30 cm between the window wall and the pouf with 2 cm to spare each side.
const POT = { rTop: 0.125, rBottom: 0.114, height: 0.25, wall: 0.01, colour: '#d6cdc1', roughness: 0.82 };
const SOIL_Y = 0.227; // soil surface, 2.3 cm below the rim
const TRUNK_TOP = 1.36; // the leader's tip; the youngest leaves reach above it
const BRANCH_FROM = 0.95; // lowest branch; the crown's lowest leaves hang just below it
const CROWN_FLOOR = 0.885; // no leaf dips below this: clear of the window sill (0.84 m)

// ---- Leaf atlas ----------------------------------------------------------------------------
const TEX = 1024, CELL = 512; // 2×2 cells, one leaf each
const LP = 455; // pixels per leaf length
const T0 = -0.035, T1 = 1.02; // leaf rows run from just below the petiole (the lobes) past the tip
const MARGIN = Math.round((CELL - (T1 - T0) * LP) / 2); // empty pixels above and below each leaf
const NU = 4, NV = 8; // leaf mesh: columns across, rows along

const rand = mulberry32(Number(flags.seed ?? 11));
const range = (a, b) => a + (b - a) * rand();

// ---- Small vector helpers ------------------------------------------------------------------
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const mul = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len = (a) => Math.hypot(a[0], a[1], a[2]);
const norm = (a) => mul(a, 1 / (len(a) || 1));
const lerp = (a, b, t) => add(a, mul(sub(b, a), t));
// Rotates v about the unit axis k by angle a (Rodrigues).
const rot = (v, k, a) => {
  const c = Math.cos(a), s = Math.sin(a);
  return add(add(mul(v, c), mul(cross(k, v), s)), mul(k, dot(k, v) * (1 - c)));
};
const clamp = (x, a = 0, b = 1) => Math.min(b, Math.max(a, x));
const smooth = (a, b, x) => {
  const t = clamp((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};
const UP = [0, 1, 0];

function mulberry32(a) {
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Value noise and fractal sum, for the textures and the soil.
function hash2(i, j, s) {
  let h = (Math.imul(i, 374761393) + Math.imul(j, 668265263) + Math.imul(s, 982451653)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
function vnoise(x, y, s) {
  const i = Math.floor(x), j = Math.floor(y), fx = x - i, fy = y - j;
  const ux = fx * fx * (3 - 2 * fx), uy = fy * fy * (3 - 2 * fy);
  const a = hash2(i, j, s), b = hash2(i + 1, j, s), c = hash2(i, j + 1, s), d = hash2(i + 1, j + 1, s);
  return a + (b - a) * ux + (c - a) * uy + (a - b - c + d) * ux * uy;
}
function fbm(x, y, s, octaves = 4) {
  let v = 0, amp = 0.5, f = 1;
  for (let o = 0; o < octaves; o++, f *= 2, amp *= 0.5) v += amp * vnoise(x * f, y * f, s + o * 17);
  return v;
}

// ---- Mesh parts ----------------------------------------------------------------------------
class Part {
  constructor(name, { uv = false, colour = false } = {}) {
    Object.assign(this, { name, hasUV: uv, hasColour: colour, p: [], n: [], t: [], c: [], i: [] });
  }
  v(p, n, t, c) {
    this.p.push(p[0], p[1], p[2]);
    const l = Math.hypot(n[0], n[1], n[2]) || 1;
    this.n.push(n[0] / l, n[1] / l, n[2] / l);
    if (this.hasUV) this.t.push(t[0], t[1]);
    if (this.hasColour) this.c.push(c[0], c[1], c[2], c[3] ?? 1);
    return this.p.length / 3 - 1;
  }
  // Winds each triangle to agree with its vertex normals, so a double-sided material lights the
  // side the normals face as the front (the other way round, leaves render dark from above).
  tri(a, b, c) {
    const P = (k) => [this.p[3 * k], this.p[3 * k + 1], this.p[3 * k + 2]];
    const N = (k) => [this.n[3 * k], this.n[3 * k + 1], this.n[3 * k + 2]];
    const g = cross(sub(P(b), P(a)), sub(P(c), P(a)));
    if (len(g) < 1e-12) return;
    if (dot(g, add(add(N(a), N(b)), N(c))) < 0) this.i.push(a, c, b);
    else this.i.push(a, b, c);
  }
  quad(a, b, c, d) {
    this.tri(a, b, c);
    this.tri(a, c, d);
  }
  get triangles() {
    return this.i.length / 3;
  }
}

// A surface of revolution. Each profile segment gets its own pair of rings, with the normal
// square to that segment: smooth around the pot, crisp at the rim and the foot.
function lathe(part, profile, segs) {
  for (let j = 0; j < profile.length - 1; j++) {
    const [r0, y0] = profile[j], [r1, y1] = profile[j + 1];
    const l = Math.hypot(r1 - r0, y1 - y0), nr = (y1 - y0) / l, ny = -(r1 - r0) / l;
    const ring = (r, y) => Array.from({ length: segs + 1 }, (_, k) => {
      const a = (k / segs) * 2 * Math.PI, c = Math.cos(a), s = Math.sin(a);
      return part.v([r * c, y, r * s], [nr * c, ny, nr * s]);
    });
    const A = ring(r0, y0), B = ring(r1, y1);
    for (let k = 0; k < segs; k++) part.quad(A[k], A[k + 1], B[k + 1], B[k]);
  }
}

// A tube along a polyline, closed with a point at the far end.
function tube(part, pts, radii, segs, colourAt) {
  let frameN = null, T = null;
  const rings = [];
  for (let i = 0; i < pts.length; i++) {
    T = norm(sub(pts[Math.min(i + 1, pts.length - 1)], pts[Math.max(i - 1, 0)]));
    if (!frameN) frameN = norm(cross(T, Math.abs(T[1]) < 0.9 ? UP : [1, 0, 0]));
    frameN = norm(sub(frameN, mul(T, dot(frameN, T)))); // carry the frame along (no twisting)
    const B = cross(T, frameN), col = colourAt(i / (pts.length - 1)), ring = [];
    for (let k = 0; k <= segs; k++) {
      const a = (k / segs) * 2 * Math.PI, d = add(mul(frameN, Math.cos(a)), mul(B, Math.sin(a)));
      ring.push(part.v(add(pts[i], mul(d, radii[i])), d, null, col));
    }
    rings.push(ring);
  }
  for (let i = 0; i < rings.length - 1; i++) {
    for (let k = 0; k < segs; k++) part.quad(rings[i][k], rings[i][k + 1], rings[i + 1][k + 1], rings[i + 1][k]);
  }
  const last = rings.at(-1), tip = part.v(add(pts.at(-1), mul(T, radii.at(-1))), T, null, colourAt(1));
  for (let k = 0; k < segs; k++) part.tri(last[k], last[k + 1], tip);
}

function bezier(p0, p1, p2, n) {
  return Array.from({ length: n + 1 }, (_, k) => {
    const t = k / n;
    return add(add(mul(p0, (1 - t) * (1 - t)), mul(p1, 2 * t * (1 - t))), mul(p2, t * t));
  });
}

// ---- Leaf shapes ---------------------------------------------------------------------------
// Right half of a lyrate leaf in leaf units (x across, t along: petiole 0 → tip 1): a heart-shaped
// base with small lobes, a waist about a third of the way up, widest near the rounded tip.
const HALF = [
  [0.000, 0.000], [0.026, -0.011], [0.062, -0.021], [0.104, -0.018], [0.146, -0.002], [0.174, 0.030],
  [0.188, 0.075], [0.190, 0.125], [0.181, 0.185], [0.176, 0.245], [0.186, 0.320], [0.214, 0.410],
  [0.255, 0.510], [0.297, 0.615], [0.327, 0.715], [0.336, 0.795], [0.318, 0.870], [0.272, 0.930],
  [0.198, 0.972], [0.112, 0.996], [0.044, 1.004], [0.000, 0.998],
];

function catmull(pts, sub) {
  const out = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[Math.max(0, i - 1)], p1 = pts[i], p2 = pts[i + 1], p3 = pts[Math.min(pts.length - 1, i + 2)];
    for (let s = 0; s < sub; s++) {
      const t = s / sub, t2 = t * t, t3 = t2 * t;
      out.push([0, 1].map((k) => 0.5 * (2 * p1[k] + (-p0[k] + p2[k]) * t + (2 * p0[k] - 5 * p1[k] + 4 * p2[k] - p3[k]) * t2
        + (-p0[k] + 3 * p1[k] - 3 * p2[k] + p3[k]) * t3)));
    }
  }
  out.push(pts.at(-1));
  return out;
}

// One side of one leaf: the base outline, made wider or narrower, a deeper or shallower waist,
// and a gently wavy margin.
function halfOutline({ width, waist, wave, phase }) {
  const pts = catmull(HALF.map(([x, t]) => [x * width * (1 - waist * Math.exp(-(((t - 0.26) / 0.12) ** 2))), t]), 6);
  let s = 0;
  return pts.map((p, i) => {
    if (i > 0) s += Math.hypot(p[0] - pts[i - 1][0], p[1] - pts[i - 1][1]);
    const a = pts[Math.max(0, i - 1)], b = pts[Math.min(pts.length - 1, i + 1)];
    const tx = b[0] - a[0], ty = b[1] - a[1], tl = Math.hypot(tx, ty) || 1;
    const fade = smooth(0.0, 0.06, p[1]) * smooth(1.0, 0.94, p[1]);
    const w = wave * fade * Math.sin((2 * Math.PI * s) / 0.11 + phase);
    return [p[0] + (ty / tl) * w, p[1] - (tx / tl) * w];
  });
}

function makeVariant(k) {
  const width = range(0.92, 1.06);
  const right = halfOutline({ width, waist: range(0.0, 0.1), wave: range(0.003, 0.006), phase: range(0, 6.3) });
  const left = halfOutline({ width: width * range(0.94, 1.0), waist: range(0.0, 0.1), wave: range(0.003, 0.006), phase: range(0, 6.3) })
    .map(([x, t]) => [-x, t]);
  const poly = [...right, ...left.slice(1, -1).reverse()];
  const flat = new Float64Array(poly.flat());
  // Half-width per mesh row: the widest the outline gets between the rows either side, plus
  // a pixel or two, so the mesh always contains the cut-out.
  const rowT = (j) => T0 + ((T1 - T0) * j) / NV;
  const env = Array.from({ length: NV + 1 }, (_, j) => {
    const lo = rowT(j - 1), hi = rowT(j + 1);
    let m = 0;
    for (const [x, t] of poly) if (t >= lo && t <= hi) m = Math.max(m, Math.abs(x));
    return m + 0.012;
  });
  // Half-width at height t (for laying out the veins).
  const hw = (t) => {
    let m = 0;
    for (const [x, tt] of right) if (Math.abs(tt - t) < 0.02) m = Math.max(m, x);
    return m;
  };
  // Lateral veins: about nine a side, leaving the midrib at 50–70° and curving toward the tip.
  const veins = [];
  for (const side of [1, -1]) {
    const offset = side > 0 ? 0 : 0.05;
    for (let t0 = 0.035 + offset + range(0, 0.02); t0 < 0.86; t0 += range(0.095, 0.115)) {
      const theta = (72 - 30 * t0) * (Math.PI / 180) + range(-0.06, 0.06);
      const xe = 0.86 * hw(Math.min(0.95, t0 + 0.12));
      const rise = (0.5 * xe) / Math.tan(theta);
      const p0 = [0, t0], p1 = [side * 0.5 * xe, t0 + rise], p2 = [side * xe, t0 + rise + 0.05 + 0.1 * xe];
      const pts = Array.from({ length: 13 }, (_, q) => {
        const s = q / 12;
        return [0, 1].map((c) => (1 - s) * (1 - s) * p0[c] + 2 * s * (1 - s) * p1[c] + s * s * p2[c]);
      });
      veins.push({ pts, bbox: bboxOf(pts, 0.012) });
    }
  }
  return { k, poly: flat, env, veins, cell: { x: (k % 2) * CELL, y: Math.floor(k / 2) * CELL } };
}

function bboxOf(pts, pad) {
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
  return [Math.min(...xs) - pad, Math.min(...ys) - pad, Math.max(...xs) + pad, Math.max(...ys) + pad];
}

// Signed distance from (x, y) to a closed polygon (flat [x0, y0, x1, y1, ...]); + inside.
function polySD(poly, x, y) {
  let d = Infinity, inside = false;
  const n = poly.length / 2;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = poly[2 * i], yi = poly[2 * i + 1], xj = poly[2 * j], yj = poly[2 * j + 1];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    const ex = xj - xi, ey = yj - yi, wx = x - xi, wy = y - yi;
    const h = clamp((wx * ex + wy * ey) / (ex * ex + ey * ey));
    const dx = wx - ex * h, dy = wy - ey * h, dd = dx * dx + dy * dy;
    if (dd < d) d = dd;
  }
  return inside ? Math.sqrt(d) : -Math.sqrt(d);
}

// Distance to a polyline, and how far along it (0–1) the closest point is.
function lineDist(pts, x, y) {
  let best = Infinity, along = 0;
  for (let i = 0; i < pts.length - 1; i++) {
    const [ax, ay] = pts[i], [bx, by] = pts[i + 1], ex = bx - ax, ey = by - ay;
    const h = clamp(((x - ax) * ex + (y - ay) * ey) / (ex * ex + ey * ey));
    const dx = x - ax - ex * h, dy = y - ay - ey * h, dd = dx * dx + dy * dy;
    if (dd < best) {
      best = dd;
      along = (i + h) / (pts.length - 1);
    }
  }
  return [Math.sqrt(best), along];
}

// Paints the atlas: base colour (sRGB) with the cut-out in alpha, and a height field that becomes
// the normal map (veins sunk into the blade, a raised midrib, margins rolling under).
function paintAtlas(variants) {
  const rgba = new Uint8Array(TEX * TEX * 4), height = new Float32Array(TEX * TEX);
  const BASE = [50, 84, 33], DEEP = [38, 66, 25], VEIN = [128, 150, 74], RIB = [170, 178, 112];
  for (let i = 0; i < TEX * TEX; i++) rgba.set([...BASE, 0], 4 * i); // outside: leaf green, so filtering never pulls in black
  for (const V of variants) {
    for (let py = V.cell.y; py < V.cell.y + CELL; py++) {
      const t = T1 - (py + 0.5 - V.cell.y - MARGIN) / LP;
      if (t < -0.06 || t > 1.05) continue;
      for (let px = V.cell.x; px < V.cell.x + CELL; px++) {
        const x = (px + 0.5 - V.cell.x - CELL / 2) / LP;
        if (Math.abs(x) > 0.4) continue;
        const sd = polySD(V.poly, x, t), sdPx = sd * LP;
        if (sdPx < -3) continue;
        // Midrib and veins.
        const ribW = 0.0095 * (1 - clamp(t)) ** 0.8 + 0.0025;
        const ribD = t < 0.975 ? Math.abs(x) - ribW : 1;
        let veinD = 1, veinS = 0;
        for (const v of V.veins) {
          const b = v.bbox;
          if (x < b[0] || x > b[2] || t < b[1] || t > b[3]) continue;
          const [d, along] = lineDist(v.pts, x, t);
          const w = 0.0052 - 0.0036 * along;
          if (d - w < veinD) {
            veinD = d - w;
            veinS = 1 - 0.65 * along;
          }
        }
        const veinMask = smooth(1.2 / LP, -0.6 / LP, veinD) * veinS;
        const ribMask = smooth(1.0 / LP, -0.6 / LP, ribD);
        // Colour.
        const n1 = fbm(x * 9 + V.k * 3.1, t * 9, 5), n2 = fbm(x * 60, t * 60, 9, 2);
        let c = BASE.map((b, q) => b + (DEEP[q] - b) * smooth(0.35, 0.75, n1));
        c = c.map((v, q) => v + (VEIN[q] - v) * 0.7 * veinMask);
        c = c.map((v, q) => v + (RIB[q] - v) * ribMask);
        const rim = smooth(0.006, 0.0, sd) * 0.18; // a thin darker margin
        c = c.map((v) => v * (1 - rim) * (0.97 + 0.06 * n2));
        if (t < 0.06) c = c.map((v, q) => v + ([120, 135, 70][q] - v) * smooth(0.06, 0.0, t) * 0.3); // paler at the stalk
        const o = 4 * (py * TEX + px);
        rgba[o] = clamp(Math.round(c[0]), 0, 255);
        rgba[o + 1] = clamp(Math.round(c[1]), 0, 255);
        rgba[o + 2] = clamp(Math.round(c[2]), 0, 255);
        rgba[o + 3] = Math.round(255 * clamp(0.5 + sdPx));
        // Height (leaf units).
        const dv = Math.max(0, Math.min(ribD, veinD));
        let h = 0.0032 * (1 - Math.exp(-dv / 0.011));
        if (ribD < 0) h += 0.0022 * Math.sqrt(clamp(-ribD / ribW));
        h -= 0.004 * Math.exp(-Math.max(0, sd) / 0.007);
        h += 0.00035 * (n2 - 0.5);
        height[py * TEX + px] = h * LP;
      }
    }
  }
  // Normal map, glTF convention (+X right, +Y up in the image, +Z out of the leaf).
  const rgb = new Uint8Array(TEX * TEX * 3);
  const H = (x, y) => height[clamp(y, 0, TEX - 1) * TEX + clamp(x, 0, TEX - 1)];
  for (let y = 0; y < TEX; y++) {
    for (let x = 0; x < TEX; x++) {
      const gx = (H(x + 1, y) - H(x - 1, y)) / 2, gy = (H(x, y + 1) - H(x, y - 1)) / 2;
      const n = norm([-gx, gy, 1]);
      rgb.set(n.map((v) => Math.round((v * 0.5 + 0.5) * 255)), 3 * (y * TEX + x));
    }
  }
  return { rgba, rgb };
}

// ---- The plant -----------------------------------------------------------------------------
const pot = new Part('pot');
const soil = new Part('soil', { colour: true });
const trunk = new Part('trunk', { colour: true });
const leaves = new Part('leaves', { uv: true, colour: true });

// Pot: a plain, slightly tapered cylinder with a rounded foot and a squared-off rim.
{
  const { rTop: rt, rBottom: rb, height: H, wall } = POT;
  const rAt = (y) => rb + ((rt - rb) * y) / H;
  lathe(pot, [
    [rb - 0.012, 0.0], [rb - 0.004, 0.0012], [rb - 0.0008, 0.0045], [rb, 0.009],
    [rt, H - 0.003], [rt - 0.0015, H], [rt - wall + 0.0015, H], [rt - wall, H - 0.003],
    [rAt(SOIL_Y - 0.02) - wall, SOIL_Y - 0.02],
  ], 56);
  // Underside, so the pot reads as solid from a low camera.
  const centre = pot.v([0, 0, 0], [0, -1, 0]);
  const ring = Array.from({ length: 57 }, (_, k) => {
    const a = (k / 56) * 2 * Math.PI;
    return pot.v([(rb - 0.012) * Math.cos(a), 0, (rb - 0.012) * Math.sin(a)], [0, -1, 0]);
  });
  for (let k = 0; k < 56; k++) pot.tri(centre, ring[k], ring[k + 1]);

  // Soil: a slightly domed, lumpy disc tucked into the pot wall.
  const rs = rAt(SOIL_Y) - wall + 0.002, segs = 40, radii = [0, 0.2, 0.4, 0.6, 0.8, 0.92, 1];
  const grid = radii.map((f, ri) => Array.from({ length: f === 0 ? 1 : segs + 1 }, (_, k) => {
    const a = (k / segs) * 2 * Math.PI, x = f * rs * Math.cos(a), z = f * rs * Math.sin(a);
    const bump = (fbm(x * 40 + 3, z * 40 + 7, 21) - 0.5) * 0.008 * (ri === radii.length - 1 ? 0 : 1);
    const y = SOIL_Y + 0.006 * (1 - f * f) + bump;
    const n = fbm(x * 70, z * 70, 31), dark = 0.035 + 0.035 * n;
    return soil.v([x, y, z], UP, null, [dark * 1.3, dark, dark * 0.75]);
  }));
  for (let ri = 0; ri < radii.length - 1; ri++) {
    for (let k = 0; k < segs; k++) {
      if (ri === 0) soil.tri(grid[0][0], grid[1][k], grid[1][k + 1]);
      else soil.quad(grid[ri][k], grid[ri][k + 1], grid[ri + 1][k + 1], grid[ri + 1][k]);
    }
  }
  smoothNormals(soil);
}

// Stem: one slightly crooked trunk out of the middle of the pot.
const trunkPath = (y) => {
  const s = (y - SOIL_Y) / (TRUNK_TOP - SOIL_Y);
  return [0.011 * Math.sin(s * 2.6 + 0.4) - 0.0043, y, 0.009 * Math.sin(s * 2.1 + 1.3) - 0.0087];
};
const trunkPts = Array.from({ length: 41 }, (_, k) => trunkPath(SOIL_Y - 0.02 + ((TRUNK_TOP - SOIL_Y + 0.02) * k) / 40));
const trunkR = (y) => 0.0125 - 0.0055 * clamp((y - SOIL_Y) / (TRUNK_TOP - SOIL_Y)) + 0.004 * smooth(SOIL_Y + 0.04, SOIL_Y, y);
const BARK = [0.16, 0.125, 0.09], YOUNG_BARK = [0.17, 0.15, 0.08], STALK = [0.1, 0.16, 0.045]; // linear
tube(trunk, trunkPts, trunkPts.map((p) => trunkR(p[1])), 10, (s) => lerp(BARK, YOUNG_BARK, smooth(0.6, 1, s)));

// Branches: five, spiralling round the stem, angled 50–60° out and curving up at their ends.
const axes = [{ pts: trunkPts.filter((p) => p[1] > BRANCH_FROM + 0.03), leader: true }];
for (let b = 0; b < 5; b++) {
  const y = BRANCH_FROM + b * 0.06 + range(-0.012, 0.012);
  const az = 0.6 + b * 2.4 + range(-0.25, 0.25);
  const tilt = (range(50, 60) * Math.PI) / 180;
  const length = range(0.18, 0.23) * (1 - 0.08 * b);
  const p0 = trunkPath(y), dir = [Math.sin(tilt) * Math.cos(az), Math.cos(tilt), Math.sin(tilt) * Math.sin(az)];
  const p1 = add(p0, mul(dir, length * 0.55)), p2 = add(p1, mul(norm(add(dir, [0, 0.9, 0])), length * 0.5));
  const pts = bezier(p0, p1, p2, 12);
  tube(trunk, pts, pts.map((_, k) => 0.0062 - 0.0028 * (k / 12)), 7, (s) => lerp(lerp(BARK, YOUNG_BARK, 0.6), YOUNG_BARK, s));
  axes.push({ pts });
}

// Leaves along each axis, from a third of the way out to the tip, a few young ones at the tip.
const variants = [0, 1, 2, 3].map(makeVariant);
const placed = [];
for (const axis of axes) {
  const pts = axis.pts, cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + len(sub(pts[i], pts[i - 1])));
  const total = cum.at(-1);
  const at = (s) => {
    const d = s * total;
    let i = 1;
    while (i < pts.length - 1 && cum[i] < d) i++;
    const f = (d - cum[i - 1]) / (cum[i] - cum[i - 1] || 1);
    return { p: lerp(pts[i - 1], pts[i], f), tan: norm(sub(pts[i], pts[i - 1])) };
  };
  let az = range(0, 6.3);
  const start = axis.leader ? 0.04 : 0.16, step = (axis.leader ? 0.036 : 0.029) / total;
  for (let s = start; s <= 1.0001; s += step * range(0.85, 1.15)) {
    az += 2.4; // the golden angle, near enough
    const young = s > 0.86;
    placed.push({ ...at(Math.min(s, 1)), az, s, young, leader: !!axis.leader });
  }
  for (let q = 0; q < 2; q++) placed.push({ ...at(1), az: (az += 2.4), s: 1, young: true, tip: true, leader: !!axis.leader });
}

const leafList = [];
for (const L of placed) {
  const A = L.tan;
  const b1 = norm(cross(A, Math.abs(A[1]) < 0.95 ? UP : [1, 0, 0])), b2 = cross(A, b1);
  const out = add(mul(b1, Math.cos(L.az)), mul(b2, Math.sin(L.az)));
  // Size: biggest low on the axis, small and pale near the tips.
  const size = L.tip ? range(0.09, 0.13) : L.young ? range(0.14, 0.19) : range(0.205, 0.265) * (1 - 0.25 * L.s);
  const spread = ((L.tip ? range(18, 30) : L.young ? range(35, 50) : range(55, 72)) * Math.PI) / 180;
  let d = norm(add(mul(A, Math.cos(spread)), mul(out, Math.sin(spread))));
  d = norm(add(d, [0, -(L.tip ? 0 : L.young ? 0.15 : range(0.35, 0.6)) * size * 4, 0])); // big leaves sag
  if (d[1] < -0.55) d = norm([d[0], -0.55, d[2]]);
  // Stalk.
  const stalk = L.tip ? 0.012 : range(0.025, 0.04);
  const sd = norm(add(d, mul(A, 0.35)));
  const base = add(L.p, mul(sd, stalk));
  tube(trunk, [L.p, lerp(L.p, base, 0.5), base], [0.0026, 0.0024, 0.0021], 4, () => STALK);
  // Blade normal: as near to facing the sky as the leaf's direction allows, with a random roll.
  let n = sub(UP, mul(d, dot(UP, d)));
  if (len(n) < 0.15) n = out;
  n = rot(norm(n), d, range(-0.4, 0.4));
  leafList.push({ base, d, n, size, L });
}

// Vertex colours: young leaves lighter and yellower; the inside and underside of the crown darker.
const centre = leafList.reduce((c, f) => add(c, f.base), [0, 0, 0]).map((v) => v / leafList.length);
let maxR = 0;
for (const f of leafList) maxR = Math.max(maxR, Math.hypot(f.base[0] - centre[0], f.base[2] - centre[2]));
for (const f of leafList) {
  const r = Math.hypot(f.base[0] - centre[0], f.base[2] - centre[2]) / maxR;
  const hgt = clamp((f.base[1] - BRANCH_FROM) / (TRUNK_TOP - BRANCH_FROM));
  const ao = 0.62 + 0.26 * smooth(0.1, 0.9, r) + 0.12 * hgt;
  const tint = f.L.tip ? [1.0, 1.0, 0.72] : f.L.young ? [0.95, 0.97, 0.8] : [range(0.78, 0.88), range(0.82, 0.9), range(0.76, 0.86)];
  addLeaf(f, tint.map((v) => v * ao), variants[Math.floor(rand() * 4)]);
}

function addLeaf({ base, d, n, size }, colour, V) {
  const fold = range(0.12, 0.22), roll = range(0.35, 0.6), rise = range(0.06, 0.12), droop = range(0.12, 0.26);
  const twist = range(-0.25, 0.25);
  let grid, uvs, Z;
  // A leaf that would dip below the crown's floor is tipped up, 4° at a time, until it clears.
  for (let attempt = 0; attempt < 30; attempt++) {
    const Y = d, X = norm(cross(Y, (Z = norm(sub(n, mul(d, dot(n, d)))))));
    grid = [];
    uvs = [];
    for (let j = 0; j <= NV; j++) {
      const t = T0 + ((T1 - T0) * j) / NV;
      for (let i = 0; i <= NU; i++) {
        const x = (-1 + (2 * i) / NU) * V.env[j];
        const tc = clamp(t);
        const z = fold * Math.abs(x) - roll * x * x + rise * tc - droop * tc * tc + twist * x * tc;
        grid.push(add(base, add(mul(X, x * size), add(mul(Y, t * size), mul(Z, z * size)))));
        uvs.push([(V.cell.x + CELL / 2 + x * LP) / TEX, (V.cell.y + MARGIN + (T1 - t) * LP) / TEX]);
      }
    }
    if (Math.min(...grid.map((p) => p[1])) >= CROWN_FLOOR) break;
    const axis = norm(cross(d, UP)); // turning about this by a positive angle tips d toward UP
    d = rot(d, axis, (4 * Math.PI) / 180);
    n = rot(n, axis, (4 * Math.PI) / 180);
  }
  const W = NU + 1, G = (i, j) => grid[clamp(j, 0, NV) * W + clamp(i, 0, NU)];
  const ids = grid.map((p, q) => {
    const i = q % W, j = Math.floor(q / W);
    let nn = cross(sub(G(i + 1, j), G(i - 1, j)), sub(G(i, j + 1), G(i, j - 1)));
    if (dot(nn, Z) < 0) nn = mul(nn, -1);
    const along = clamp(T0 + ((T1 - T0) * j) / NV);
    return leaves.v(p, nn, uvs[q], colour.map((c) => c * (0.88 + 0.12 * along)));
  });
  for (let j = 0; j < NV; j++) {
    for (let i = 0; i < NU; i++) leaves.quad(ids[j * W + i], ids[j * W + i + 1], ids[(j + 1) * W + i + 1], ids[(j + 1) * W + i]);
  }
}

function smoothNormals(part) {
  const acc = new Float64Array(part.p.length);
  for (let q = 0; q < part.i.length; q += 3) {
    const [a, b, c] = [part.i[q], part.i[q + 1], part.i[q + 2]];
    const P = (k) => [part.p[3 * k], part.p[3 * k + 1], part.p[3 * k + 2]];
    const g = cross(sub(P(b), P(a)), sub(P(c), P(a)));
    for (const k of [a, b, c]) for (let e = 0; e < 3; e++) acc[3 * k + e] += g[e];
  }
  for (let k = 0; k < part.p.length / 3; k++) {
    const nn = norm([acc[3 * k], acc[3 * k + 1], acc[3 * k + 2]]);
    part.n.splice(3 * k, 3, ...nn);
  }
}

// ---- Textures --------------------------------------------------------------------------------
const atlas = paintAtlas(variants);
const colourPNG = png(TEX, TEX, atlas.rgba, 4), normalPNG = png(TEX, TEX, atlas.rgb, 3);
if (flags.pngs) {
  mkdirSync(flags.pngs, { recursive: true });
  writeFileSync(join(flags.pngs, 'fig-leaves-colour.png'), colourPNG);
  writeFileSync(join(flags.pngs, 'fig-leaves-normal.png'), normalPNG);
}

// ---- glTF binary -----------------------------------------------------------------------------
const srgbToLinear = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const hex = (h) => [1, 3, 5].map((i) => srgbToLinear(parseInt(h.slice(i, i + 2), 16) / 255));

const json = {
  asset: { version: '2.0', generator: 'living-room scripts/plants/fiddle-leaf-fig.mjs' },
  extensionsUsed: ['KHR_materials_specular'],
  scene: 0,
  scenes: [{ name: 'fiddle-leaf-fig', nodes: [0] }],
  nodes: [{ name: 'fiddle_leaf_fig', children: [1, 2, 3, 4] }],
  meshes: [], accessors: [], bufferViews: [], buffers: [],
  materials: [
    { name: 'fig_pot', pbrMetallicRoughness: { baseColorFactor: [...hex(POT.colour), 1], metallicFactor: 0, roughnessFactor: POT.roughness } },
    { name: 'fig_soil', pbrMetallicRoughness: { metallicFactor: 0, roughnessFactor: 1 } },
    { name: 'fig_bark', pbrMetallicRoughness: { metallicFactor: 0, roughnessFactor: 0.85 } },
    // Satin rather than mirror-glossy, with a weaker specular (F0 2.4 % instead of 4 %): next to
    // the window the app's opening area lights reach every leaf unshadowed, and a glossier
    // leaf turns the whole crown silvery there. three.js loads this as a MeshPhysicalMaterial.
    {
      name: 'fig_leaves', alphaMode: 'MASK', alphaCutoff: 0.5, doubleSided: true,
      pbrMetallicRoughness: { baseColorTexture: { index: 0 }, metallicFactor: 0, roughnessFactor: 0.55 },
      normalTexture: { index: 1 },
      extensions: { KHR_materials_specular: { specularFactor: 0.6 } },
    },
  ],
  samplers: [{ magFilter: 9729, minFilter: 9987, wrapS: 33071, wrapT: 33071 }],
  images: [],
  textures: [{ sampler: 0, source: 0, name: 'fig_leaves_colour' }, { sampler: 0, source: 1, name: 'fig_leaves_normal' }],
};
const chunks = [];
let offset = 0;
function view(bytes, target) {
  const b = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  json.bufferViews.push({ buffer: 0, byteOffset: offset, byteLength: b.length, ...(target ? { target } : {}) });
  const padded = Buffer.concat([b, Buffer.alloc((4 - (b.length % 4)) % 4)]);
  chunks.push(padded);
  offset += padded.length;
  return json.bufferViews.length - 1;
}
function accessor(array, type, extra = {}) {
  const componentType = array instanceof Float32Array ? 5126 : array instanceof Uint32Array ? 5125 : 5123;
  const size = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 }[type];
  json.accessors.push({ bufferView: view(array, extra.target), componentType, count: array.length / size, type, ...extra.props });
  return json.accessors.length - 1;
}
for (const [image, name] of [[colourPNG, 'fig_leaves_colour'], [normalPNG, 'fig_leaves_normal']]) {
  json.images.push({ name, mimeType: 'image/png', bufferView: view(new Uint8Array(image)) });
}
[pot, soil, trunk, leaves].forEach((part, m) => {
  const P = new Float32Array(part.p), min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (let k = 0; k < P.length; k++) {
    min[k % 3] = Math.min(min[k % 3], P[k]);
    max[k % 3] = Math.max(max[k % 3], P[k]);
  }
  const attributes = {
    POSITION: accessor(P, 'VEC3', { target: 34962, props: { min, max } }),
    NORMAL: accessor(new Float32Array(part.n), 'VEC3', { target: 34962 }),
  };
  if (part.hasUV) attributes.TEXCOORD_0 = accessor(new Float32Array(part.t), 'VEC2', { target: 34962 });
  if (part.hasColour) attributes.COLOR_0 = accessor(new Float32Array(part.c), 'VEC4', { target: 34962 });
  const indices = part.p.length / 3 > 65535 ? new Uint32Array(part.i) : new Uint16Array(part.i);
  json.meshes.push({ name: part.name, primitives: [{ attributes, indices: accessor(indices, 'SCALAR', { target: 34963 }), material: m, mode: 4 }] });
  json.nodes.push({ name: part.name, mesh: m });
});
const bin = Buffer.concat(chunks);
json.buffers.push({ byteLength: bin.length });
const jsonBuf = Buffer.from(JSON.stringify(json));
const jsonChunk = Buffer.concat([jsonBuf, Buffer.alloc((4 - (jsonBuf.length % 4)) % 4, 0x20)]);
const header = Buffer.alloc(12);
header.writeUInt32LE(0x46546c67, 0);
header.writeUInt32LE(2, 4);
header.writeUInt32LE(12 + 8 + jsonChunk.length + 8 + bin.length, 8);
const chunkHead = (n, type) => {
  const b = Buffer.alloc(8);
  b.writeUInt32LE(n, 0);
  b.writeUInt32LE(type, 4);
  return b;
};
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, Buffer.concat([header, chunkHead(jsonChunk.length, 0x4e4f534a), jsonChunk, chunkHead(bin.length, 0x004e4942), bin]));

// Summary.
const bounds = (parts) => {
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (const part of parts) for (let k = 0; k < part.p.length; k++) {
    lo[k % 3] = Math.min(lo[k % 3], part.p[k]);
    hi[k % 3] = Math.max(hi[k % 3], part.p[k]);
  }
  return { lo, hi };
};
const all = bounds([pot, soil, trunk, leaves]), crown = bounds([leaves]);
const f2 = (v) => v.map((n) => n.toFixed(3)).join(', ');
console.log(`wrote ${out} (${(Buffer.byteLength(bin) / 1024).toFixed(0)} KB binary)`);
console.log(`triangles: pot ${pot.triangles}, soil ${soil.triangles}, trunk ${trunk.triangles}, leaves ${leaves.triangles} (${leafList.length} leaves); total ${pot.triangles + soil.triangles + trunk.triangles + leaves.triangles}`);
console.log(`bounds min ${f2(all.lo)} max ${f2(all.hi)}; crown (leaf quads) min ${f2(crown.lo)} max ${f2(crown.hi)}`);

// ---- PNG -------------------------------------------------------------------------------------
function png(w, h, pixels, channels) {
  const stride = w * channels, raw = Buffer.alloc((stride + 1) * h);
  for (let y = 0; y < h; y++) Buffer.from(pixels.buffer, pixels.byteOffset + y * stride, stride).copy(raw, y * (stride + 1) + 1);
  const chunk = (type, data) => {
    const head = Buffer.alloc(4);
    head.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([head, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr.set([8, channels === 4 ? 6 : 2, 0, 0, 0], 8);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}
function crc32(buf) {
  let c = ~0;
  for (const byte of buf) {
    c ^= byte;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}
