// A young rubber plant (Ficus elastica), the size garden centres sell for a windowsill: three
// cuttings of different heights in a 13 cm terracotta pot, a dozen or so glossy oval leaves,
// each stem ending in the red sheath that wraps the next leaf. Leaves fan out mostly sideways
// (along the window, as a sill plant grows), so it stays within the sill's depth.
//
// The leaves are real geometry cut to their outline (no alpha), with a colour and normal texture
// for the midrib, the fine parallel side veins and the paler margin. Parts:
//   pot     plain colour in baseColorFactor (terracotta), recolourable
//   soil    vertex colours
//   stems   stems, leaf stalks and the red sheaths; vertex colours
//   leaves  opaque, double-sided; vertex colours tint young leaves and darken inner ones;
//           KHR_materials_specular lowers the specular (three.js: MeshPhysicalMaterial)
// Metres, Y up, origin at the centre of the pot's base. Writes raw/plants/rubber-plant.glb;
// scripts/plants/pack.mjs makes the web copy in assets/plants/rubber-plant/.
//
// usage: node scripts/plants/rubber-plant.mjs [out.glb] [--seed=N] [--pngs=<dir>]
import { writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  random, add, sub, mul, dot, cross, len, norm, lerp, rot, clamp, smooth, deg, UP, fbm,
  Part, pot, soilDisc, tube, bezier, gridSurface, normalsFromHeight, png, linear, writeGLB, summary, bounds,
} from './lib.mjs';

const args = process.argv.slice(2);
const flags = Object.fromEntries(args.filter((a) => a.startsWith('--')).map((a) => a.slice(2).split('=')));
const root = resolve(import.meta.dirname, '../..');
const out = resolve(args.find((a) => !a.startsWith('--')) ?? join(root, 'raw/plants/rubber-plant.glb'));
const rand = random(Number(flags.seed ?? 5));
const range = rand.range;

// A standard clay pot: Ø 13.2 cm at the collar, 11.8 cm tall.
const POT = { rTop: 0.066, rBottom: 0.049, height: 0.118, wall: 0.007, collar: { height: 0.024, step: 0.004 }, colour: '#b5694a', roughness: 0.9 };
const SOIL_Y = 0.104;
const LEAF_FLOOR = 0.075; // no leaf hangs lower than this (the pot's upper half)
const SIDEWAYS = 0.5; // how much the leaves' spread toward the room and the glass is squeezed

// ---- Leaf outline: elliptic, widest just below the middle, a short point at the tip ----------
const HW = [[0, 0.014], [0.04, 0.085], [0.12, 0.165], [0.25, 0.222], [0.42, 0.25], [0.58, 0.245], [0.72, 0.215],
  [0.83, 0.165], [0.91, 0.105], [0.96, 0.052], [0.99, 0.014], [1, 0]];
const halfWidth = (t) => {
  t = clamp(t);
  let i = 1;
  while (i < HW.length - 1 && HW[i][0] < t) i++;
  const [t0, w0] = HW[i - 1], [t1, w1] = HW[i], f = (t - t0) / (t1 - t0);
  const s = f * f * (3 - 2 * f) * 0.35 + f * 0.65; // a little smoothing between the points
  return w0 + (w1 - w0) * s;
};

// ---- Leaf texture: one leaf, 512 × 1024 (x across, t along: stalk at the bottom) --------------
const TW = 512, TH = 1024, LP = 960, T1 = 1.02, MARGIN = Math.round((TH - (T1 + 0.02) * LP) / 2);
const texX = (x) => TW / 2 + x * LP, texY = (t) => MARGIN + (T1 - t) * LP;
function paintLeaf() {
  const rgb = new Uint8Array(TW * TH * 3), height = new Float32Array(TW * TH);
  const BASE = [40, 66, 28], DEEP = [30, 52, 22], RIB = [150, 158, 92], EDGE = [92, 112, 52];
  for (let py = 0; py < TH; py++) {
    const t = T1 - (py + 0.5 - MARGIN) / LP;
    for (let px = 0; px < TW; px++) {
      const x = (px + 0.5 - TW / 2) / LP, ax = Math.abs(x);
      const hw = halfWidth(t), edge = hw - ax; // distance in from the margin (leaf units)
      const n1 = fbm(x * 8, t * 8, 3), n2 = fbm(x * 70, t * 70, 7, 2);
      let c = BASE.map((b, q) => b + (DEEP[q] - b) * smooth(0.35, 0.75, n1));
      // Fine side veins, nearly square to the midrib and curving toward the tip near the margin.
      const vc = (t - 0.3 * ax - 0.9 * ax * ax) / 0.022;
      const vein = smooth(0.82, 1, Math.abs(Math.sin(Math.PI * vc))) * smooth(0.008, 0.03, ax) * smooth(0.0, 0.025, edge);
      c = c.map((v, q) => v + (EDGE[q] - v) * 0.14 * vein);
      // Midrib: a pale line, wide at the stalk and fading out at the tip.
      const ribW = 0.0055 * (1 - clamp(t)) + 0.0012;
      const onLeaf = t >= 0 && t <= 1;
      const rib = onLeaf && t < 0.985 ? smooth(ribW + 1.2 / LP, ribW - 0.6 / LP, ax) : 0;
      c = c.map((v, q) => v + (RIB[q] - v) * rib * (1 - 0.5 * clamp(t)));
      // Paler margin vein.
      const margin = onLeaf && edge > -0.002 ? smooth(0.006, 0.0015, edge) : 0;
      c = c.map((v, q) => v + (EDGE[q] - v) * 0.6 * margin);
      c = c.map((v) => v * (0.97 + 0.06 * n2));
      const o = 3 * (py * TW + px);
      for (let q = 0; q < 3; q++) rgb[o + q] = clamp(Math.round(c[q]), 0, 255);
      // Height: a sunken midrib channel, faint veins, the blade swelling between them.
      let h = -0.0012 * rib - 0.00025 * vein + 0.0009 * smooth(0, 0.05, edge) + 0.00015 * (n2 - 0.5);
      height[py * TW + px] = h * LP;
    }
  }
  return { rgb, normal: normalsFromHeight(height, TW, TH, 1) };
}

// ---- The plant ---------------------------------------------------------------------------------
const potPart = new Part('pot');
const soil = new Part('soil', { colour: true });
const stems = new Part('stems', { colour: true });
const leaves = new Part('leaves', { uv: true, colour: true });

const inner = pot(potPart, { ...POT, soilY: SOIL_Y, segs: 48 });
soilDisc(soil, { r: inner(SOIL_Y) + 0.0015, y: SOIL_Y, seed: 33, dome: 0.003, bump: 0.004 });

const STEM = [0.13, 0.11, 0.05], YOUNG = [0.15, 0.17, 0.06], SHEATH = [0.42, 0.07, 0.05], STALK = [0.11, 0.15, 0.045]; // linear

// Three cuttings: tall in the middle-ish, two shorter ones leaning out to the sides.
const cuttings = [
  { at: [0.004, -0.004], height: 0.19, lean: [0.03, 0.0], leaves: 7 },
  { at: [-0.02, 0.008], height: 0.145, lean: [-0.06, 0.012], leaves: 5 },
  { at: [0.021, 0.011], height: 0.105, lean: [0.07, 0.015], leaves: 4 },
];
const leafSpecs = [];
for (const [ci, c] of cuttings.entries()) {
  const p0 = [c.at[0], SOIL_Y - 0.015, c.at[1]];
  const p2 = [c.at[0] + c.lean[0] * c.height * 4, SOIL_Y + c.height, c.at[1] + c.lean[1] * c.height * 4];
  const p1 = lerp(p0, [p2[0] * 0.4 + p0[0] * 0.6, (p0[1] + p2[1]) / 2, p2[2] * 0.4 + p0[2] * 0.6], 1);
  const pts = bezier(p0, p1, p2, 10);
  tube(stems, pts, pts.map((_, k) => 0.0044 - 0.0012 * (k / 10)), 7, (s) => lerp(STEM, YOUNG, smooth(0.3, 1, s)));
  // The sheath at the tip: a slim red cone wrapping the next leaf.
  const tan = norm(sub(pts[10], pts[9]));
  const sheathLen = range(0.028, 0.04);
  const sh = [pts[10], add(pts[10], mul(norm(add(tan, [range(-0.1, 0.1), 0, range(-0.05, 0.05)])), sheathLen * 0.5)),
    add(pts[10], mul(norm(add(tan, [range(-0.15, 0.15), 0.1, 0])), sheathLen))];
  tube(stems, sh, [0.0036, 0.0028, 0.001], 6, () => SHEATH);
  // Leaves along all but the bottom of the stem, alternate, a golden angle apart.
  let az = range(0, 6.3) + ci;
  for (let k = 0; k < c.leaves; k++) {
    const s = 0.18 + (0.78 * k) / Math.max(1, c.leaves - 1); // along the stem
    const i = Math.min(9, Math.floor(s * 10)), f = s * 10 - i;
    const p = lerp(pts[i], pts[i + 1], f), axis = norm(sub(pts[i + 1], pts[i]));
    az += 2.4;
    const top = k === c.leaves - 1;
    leafSpecs.push({ p, axis, az, size: (top ? range(0.08, 0.095) : range(0.13, 0.165)) * (1 - 0.15 * s) * (ci === 2 ? 0.92 : 1), top, s, ci });
  }
}

for (const L of leafSpecs) {
  const A = L.axis;
  const b1 = norm(cross(A, Math.abs(A[1]) < 0.95 ? UP : [1, 0, 0])), b2 = cross(A, b1);
  let outDir = add(mul(b1, Math.cos(L.az)), mul(b2, Math.sin(L.az)));
  outDir = norm([outDir[0], outDir[1], outDir[2] * SIDEWAYS]);
  const spread = deg(L.top ? range(18, 28) : range(32, 52));
  let d = norm(add(mul(A, Math.cos(spread)), mul(outDir, Math.sin(spread))));
  d = norm(add(d, [0, -(L.top ? 0 : range(0.05, 0.22)), 0]));
  // Leaf stalk.
  const stalk = range(0.014, 0.022);
  const base = add(L.p, mul(norm(add(d, mul(A, 0.6))), stalk));
  tube(stems, [L.p, lerp(L.p, base, 0.5), base], [0.0021, 0.002, 0.0018], 4, () => STALK);
  let n = sub(UP, mul(d, dot(UP, d)));
  if (len(n) < 0.15) n = outDir;
  // Leaves spreading along the window would show the room only their edges: each blade is
  // turned 30–60° about its midrib, toward the room or toward the glass.
  n = rot(norm(n), d, (rand() < 0.5 ? -1 : 1) * deg(range(30, 60)));
  L.base = base;
  L.d = d;
  L.n = n;
}

// Shading: the top (young) leaf of each stem lighter and warmer, inner and lower leaves darker.
for (const L of leafSpecs) {
  const r = Math.hypot(L.base[0], L.base[2]);
  const ao = 0.7 + 0.18 * smooth(0.0, 0.05, r) + 0.12 * smooth(SOIL_Y + 0.05, SOIL_Y + 0.2, L.base[1]);
  const tint = L.top ? [1.0, 0.98, 0.78] : [range(0.8, 0.88), range(0.84, 0.9), range(0.78, 0.86)];
  addLeaf(L, tint.map((v) => v * ao));
}

function addLeaf(L, colour) {
  const { size } = L;
  const fold = range(0.08, 0.16), roll = range(0.5, 1.0), rise = range(0.04, 0.08), droop = range(0.08, 0.2), twist = range(-0.15, 0.15);
  let d = L.d, n = L.n;
  for (let attempt = 0; attempt < 30; attempt++) {
    const Z = norm(sub(n, mul(d, dot(n, d)))), X = norm(cross(d, Z));
    const NU = 6, NV = 12;
    const at = (i, j) => {
      const t = j / NV, x = (-1 + (2 * i) / NU) * halfWidth(t);
      const z = fold * Math.abs(x) - roll * x * x + rise * t - droop * t * t + twist * x * t;
      return { t, x, p: add(L.base, add(mul(X, x * size), add(mul(d, t * size), mul(Z, z * size)))) };
    };
    let low = Infinity;
    for (let j = 0; j <= NV; j++) for (let i = 0; i <= NU; i++) low = Math.min(low, at(i, j).p[1]);
    if (low < LEAF_FLOOR && attempt < 29) {
      const axis = norm(cross(d, UP));
      d = rot(d, axis, deg(4));
      n = rot(n, axis, deg(4));
      continue;
    }
    gridSurface(leaves, NU, NV, {
      pointAt: (i, j) => at(i, j).p,
      uvAt: (i, j) => {
        const { t, x } = at(i, j);
        return [texX(x) / TW, texY(t) / TH];
      },
      colourAt: (i, j) => colour.map((c) => c * (0.9 + 0.1 * (j / NV))),
      facing: () => Z,
    });
    return;
  }
}

// ---- Write -------------------------------------------------------------------------------------
const tex = paintLeaf();
const colourPNG = png(TW, TH, tex.rgb, 3), normalPNG = png(TW, TH, tex.normal, 3);
if (flags.pngs) {
  mkdirSync(flags.pngs, { recursive: true });
  writeFileSync(join(flags.pngs, 'rubber-leaf-colour.png'), colourPNG);
  writeFileSync(join(flags.pngs, 'rubber-leaf-normal.png'), normalPNG);
}
writeGLB(out, {
  name: 'rubber-plant',
  generator: 'living-room scripts/plants/rubber-plant.mjs',
  extensionsUsed: ['KHR_materials_specular'],
  parts: [{ part: potPart, material: 0 }, { part: soil, material: 1 }, { part: stems, material: 2 }, { part: leaves, material: 3 }],
  materials: [
    { name: 'rubber_pot', pbrMetallicRoughness: { baseColorFactor: [...linear(POT.colour), 1], metallicFactor: 0, roughnessFactor: POT.roughness } },
    { name: 'rubber_soil', pbrMetallicRoughness: { metallicFactor: 0, roughnessFactor: 1 } },
    { name: 'rubber_stems', pbrMetallicRoughness: { metallicFactor: 0, roughnessFactor: 0.7 } },
    {
      name: 'rubber_leaves', doubleSided: true,
      pbrMetallicRoughness: { baseColorTexture: { index: 0 }, metallicFactor: 0, roughnessFactor: 0.42 },
      normalTexture: { index: 1 },
      extensions: { KHR_materials_specular: { specularFactor: 0.6 } },
    },
  ],
  images: [{ name: 'rubber_leaf_colour', png: colourPNG }, { name: 'rubber_leaf_normal', png: normalPNG }],
  textures: [{ source: 0, name: 'rubber_leaf_colour' }, { source: 1, name: 'rubber_leaf_normal' }],
});
summary(out, [potPart, soil, stems, leaves]);
console.log(`${leafSpecs.length} leaves; leaf bounds depth ${bounds([leaves]).size[2].toFixed(3)} m`);
