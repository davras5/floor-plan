// A small snake plant (Dracaena trifasciata 'Laurentii', formerly Sansevieria) for the window
// sill: seven stiff sword-shaped leaves, dark green with grey-green cross-bands and yellow
// margins, in a 14 cm charcoal cylinder pot. The leaves stand in a loose fan along the window
// (as a sill plant is usually turned), so the plant is wide and shallow.
//
// The leaves are real geometry cut to their outline (no alpha): channelled, slightly twisted
// blades with a sharp point. Parts:
//   pot     plain colour in baseColorFactor (charcoal), recolourable
//   soil    vertex colours
//   leaves  opaque, double-sided; a 4-column texture (one pattern per column), mapped across
//           each leaf's width, and vertex colours darkening the bases inside the clump
// Metres, Y up, origin at the centre of the pot's base. Writes raw/plants/snake-plant.glb;
// scripts/plants/pack.mjs makes the web copy in assets/plants/snake-plant/.
//
// usage: node scripts/plants/snake-plant.mjs [out.glb] [--seed=N] [--pngs=<dir>]
import { writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { random, add, mul, cross, norm, rot, clamp, smooth, deg, UP, fbm, Part, pot, soilDisc, gridSurface, png, linear, writeGLB, summary } from './lib.mjs';

const args = process.argv.slice(2);
const flags = Object.fromEntries(args.filter((a) => a.startsWith('--')).map((a) => a.slice(2).split('=')));
const root = resolve(import.meta.dirname, '../..');
const out = resolve(args.find((a) => !a.startsWith('--')) ?? join(root, 'raw/plants/snake-plant.glb'));
const rand = random(Number(flags.seed ?? 3));
const range = rand.range;

// A plain cylinder, Ø 14 cm, 12.5 cm tall.
const POT = { rTop: 0.07, rBottom: 0.064, height: 0.125, wall: 0.007, colour: '#3b3a37', roughness: 0.72 };
const SOIL_Y = 0.11;
const SIDEWAYS = 0.35; // the fan: leaning toward the room or the glass is squeezed to this

// ---- Leaf texture: 4 columns of 256 × 1024, u across the leaf (-1 … 1), t along (tip at top) ---
const TW = 1024, TH = 1024, COL = 256, PAD = 0.04; // PAD: leaves use the middle 92 % of a column
function paint() {
  const rgb = new Uint8Array(TW * TH * 3);
  const DARK = [38, 64, 34], BAND = [120, 146, 108], YELLOW = [214, 196, 92], INNER = [150, 160, 70], BASE = [196, 204, 168];
  for (let k = 0; k < 4; k++) {
    for (let py = 0; py < TH; py++) {
      const t = 1 - (py + 0.5) / TH;
      for (let px = k * COL; px < (k + 1) * COL; px++) {
        const u = (((px + 0.5 - k * COL) / COL - PAD) / (1 - 2 * PAD)) * 2 - 1, au = Math.abs(u);
        // Cross-bands: irregular, zig-zagging light bands across the dark green.
        const wob = 0.05 * Math.sin(u * 5.5 + k * 1.7) + 0.035 * Math.sin(u * 13 + k) + 0.06 * (fbm(u * 1.5 + k * 4, t * 9, 11) - 0.5);
        const s = (t + wob) * (30 + 3 * k);
        const band = smooth(0.45, 0.85, 0.5 + 0.5 * Math.sin(2 * Math.PI * s + fbm(u * 3, t * 40, 13 + k) * 2.5));
        const fade = 0.55 + 0.45 * fbm(u * 2 + k, t * 6, 17);
        let c = DARK.map((d, q) => d + (BAND[q] - d) * band * fade * 0.75);
        // Yellow margins, a slightly ragged 9–12 % of the width each side, a greener line inside.
        const edge = 0.79 + 0.04 * (fbm(t * 60, k * 3.3, 19) - 0.5) * 2;
        c = c.map((v, q) => v + (INNER[q] - v) * smooth(edge - 0.05, edge, au) * 0.35);
        c = c.map((v, q) => v + (YELLOW[q] - v) * smooth(edge - 0.015, edge + 0.015, au));
        // Pale where the leaf comes out of the soil, a dry brown point at the very tip.
        c = c.map((v, q) => v + (BASE[q] - v) * smooth(0.07, 0.0, t) * 0.6);
        c = c.map((v, q) => v + ([120, 92, 52][q] - v) * smooth(0.985, 1.0, t));
        const n = fbm(px * 0.08, py * 0.02, 23, 2);
        const o = 3 * (py * TW + px);
        for (let q = 0; q < 3; q++) rgb[o + q] = clamp(Math.round(c[q] * (0.95 + 0.1 * n)), 0, 255);
      }
    }
  }
  return rgb;
}

// Leaf outline: narrow at the base, widest a little below the middle, a long sharp point.
const HW = [[0, 0.55], [0.12, 0.78], [0.3, 0.95], [0.45, 1], [0.6, 0.96], [0.74, 0.82], [0.85, 0.58], [0.93, 0.32], [0.98, 0.1], [1, 0]];
const halfWidth = (t) => {
  t = clamp(t);
  let i = 1;
  while (i < HW.length - 1 && HW[i][0] < t) i++;
  const [t0, w0] = HW[i - 1], [t1, w1] = HW[i], f = (t - t0) / (t1 - t0);
  return w0 + (w1 - w0) * (f * f * (3 - 2 * f) * 0.4 + f * 0.6);
};

// ---- The plant ---------------------------------------------------------------------------------
const potPart = new Part('pot');
const soil = new Part('soil', { colour: true });
const leaves = new Part('leaves', { uv: true, colour: true });

const inner = pot(potPart, { ...POT, soilY: SOIL_Y, segs: 48 });
soilDisc(soil, { r: inner(SOIL_Y) + 0.0015, y: SOIL_Y, seed: 41, dome: 0.002, bump: 0.004 });

// Seven leaves: a main clump of five and a young offset of two at one side. az = direction it
// leans toward (0 = +x), lean/arch in degrees, length above the soil, width at the widest.
const LEAVES = [
  { at: [-0.004, 0.0], az: 180, lean: 6, arch: 8, length: 0.3, width: 0.05 },
  { at: [0.006, 0.004], az: 10, lean: 4, arch: 6, length: 0.285, width: 0.053 },
  { at: [-0.014, -0.006], az: 200, lean: 13, arch: 14, length: 0.235, width: 0.046 },
  { at: [0.016, -0.005], az: 345, lean: 14, arch: 16, length: 0.25, width: 0.048 },
  { at: [0.0, 0.012], az: 95, lean: 9, arch: 10, length: 0.205, width: 0.044 },
  { at: [0.038, 0.016], az: 20, lean: 12, arch: 12, length: 0.155, width: 0.037 },
  { at: [0.03, 0.022], az: 60, lean: 16, arch: 14, length: 0.12, width: 0.032 },
];

LEAVES.forEach((L, li) => {
  const a = deg(L.az + range(-8, 8));
  const out = norm([Math.cos(a), 0, Math.sin(a) * SIDEWAYS]); // horizontal lean direction
  const side = norm(cross(UP, out)); // across the blade
  const twist = range(-0.45, 0.45), channel = range(0.18, 0.3), col = li % 4;
  const base = [L.at[0], SOIL_Y - 0.018, L.at[1]];
  const NU = 4, NV = 12, total = L.length + 0.018;
  // The midrib: a curve leaning out by `lean` at the base and `lean + arch` at the tip.
  const spine = [base];
  for (let j = 1; j <= NV; j++) {
    const t = (j - 0.5) / NV, ang = deg(L.lean + L.arch * t * t);
    const d = norm(add(mul(UP, Math.cos(ang)), mul(out, Math.sin(ang))));
    spine.push(add(spine[j - 1], mul(d, total / NV)));
  }
  const frame = (j) => {
    const t = j / NV, tw = twist * t;
    const along = norm(j < NV ? add(spine[j + 1], mul(spine[j], -1)) : add(spine[j], mul(spine[j - 1], -1)));
    const X = rot(side, along, tw), Z = norm(cross(along, X)); // Z: toward the clump's centre, the cupped face
    return { t, X, Z };
  };
  gridSurface(leaves, NU, NV, {
    pointAt: (i, j) => {
      const { t, X, Z } = frame(j), u = -1 + (2 * i) / NU, hw = (halfWidth(t) * L.width) / 2;
      return add(spine[j], add(mul(X, u * hw), mul(Z, channel * hw * u * u)));
    },
    uvAt: (i, j) => [(col * COL + (PAD + (1 - 2 * PAD) * (i / NU)) * COL) / TW, 1 - j / NV],
    colourAt: (i, j) => {
      const t = j / NV, ao = 0.6 + 0.4 * smooth(0.0, 0.45, t);
      return [ao, ao, ao];
    },
    facing: (i, j) => frame(j).Z,
  });
});

// ---- Write -------------------------------------------------------------------------------------
const colourPNG = png(TW, TH, paint(), 3);
if (flags.pngs) {
  mkdirSync(flags.pngs, { recursive: true });
  writeFileSync(join(flags.pngs, 'snake-leaf-colour.png'), colourPNG);
}
writeGLB(out, {
  name: 'snake-plant',
  generator: 'living-room scripts/plants/snake-plant.mjs',
  parts: [{ part: potPart, material: 0 }, { part: soil, material: 1 }, { part: leaves, material: 2 }],
  materials: [
    { name: 'snake_pot', pbrMetallicRoughness: { baseColorFactor: [...linear(POT.colour), 1], metallicFactor: 0, roughnessFactor: POT.roughness } },
    { name: 'snake_soil', pbrMetallicRoughness: { metallicFactor: 0, roughnessFactor: 1 } },
    { name: 'snake_leaves', doubleSided: true, pbrMetallicRoughness: { baseColorTexture: { index: 0 }, metallicFactor: 0, roughnessFactor: 0.55 } },
  ],
  images: [{ name: 'snake_leaf_colour', png: colourPNG }],
  textures: [{ source: 0, name: 'snake_leaf_colour' }],
});
summary(out, [potPart, soil, leaves]);
