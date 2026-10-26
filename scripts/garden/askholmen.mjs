// IKEA ASKHOLMEN folding chair and folding table (solid acacia, dark brown stain), made for this
// planner: IKEA publishes no 3D model, so these are built from slats and frames to the sizes on
// IKEA's product pages and in its dimension drawings (ikea.com/ch, 2026-10-26):
//   chair  36 × 49 × 87 cm (W × D × H), seat 36 × 30 cm at 46 cm, back 34 cm wide with three
//          slats; the long frame runs from the front foot up into the reclined back, the short
//          one from the back foot to the seat front (the X you see from the side); folded 10 cm
//   table  top 60 × 62 cm of nine slats, 73 cm high, 6 cm deep under the top; the legs cross in
//          an X on each 62 cm side, 40 × 50 cm apart at the floor, with foot rails 10 cm up
// Parts: Wood (every frame member and slat; texture coordinates in metres, v along the grain) and,
// in the chair's cushion.glb only, Cushion (IKEA KUDDARNA chair pad, 36 × 32 cm). Metres, Y up,
// origin on the floor in the middle; the chair faces +z, the table's slats run along x.
//
// usage: node scripts/garden/askholmen.mjs     (rewrites the models in assets/garden/)
import { join, resolve } from 'node:path';
import { Part, writeGLB, summary, add, sub, mul, norm, cross, dot, len, lerp } from '../plants/lib.mjs';

const root = resolve(import.meta.dirname, '../..');
const X = [1, 0, 0], Y = [0, 1, 0], Z = [0, 0, 1];

// A straight member from a to b (its centre line), w wide along `side`, t thick across that.
function beam(part, a, b, side, w, t) {
  const d = norm(sub(b, a)), l = len(sub(b, a));
  const s = norm(sub(side, mul(d, dot(side, d)))), n = cross(d, s);
  const at = (p, u, v) => add(add(p, mul(s, (u * w) / 2)), mul(n, (v * t) / 2));
  const corner = (end, u, v) => at(end ? b : a, u, v);
  // Four long faces (texture u across, v along: the grain), then the two ends.
  const faces = [
    { n: s, q: [[0, 1, -1], [0, 1, 1], [1, 1, 1], [1, 1, -1]], across: t },
    { n: mul(s, -1), q: [[0, -1, -1], [0, -1, 1], [1, -1, 1], [1, -1, -1]], across: t },
    { n, q: [[0, -1, 1], [0, 1, 1], [1, 1, 1], [1, -1, 1]], across: w },
    { n: mul(n, -1), q: [[0, -1, -1], [0, 1, -1], [1, 1, -1], [1, -1, -1]], across: w },
  ];
  for (const f of faces) {
    const v = f.q.map(([end, u, vv], k) => part.v(corner(end, u, vv), f.n, [k === 1 || k === 2 ? f.across : 0, end * l]));
    part.quad(...v);
  }
  for (const [end, normal] of [[0, mul(d, -1)], [1, d]]) {
    const v = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([u, vv]) => part.v(corner(end, u, vv), normal, [(u + 1) * w / 2, (vv + 1) * t / 2]));
    part.quad(...v);
  }
}

// ---- Chair -----------------------------------------------------------------------------------
function chair({ cushion }) {
  const wood = new Part('Wood', { uv: true });
  const FRAME = { w: 0.022, t: 0.036 }; // the side members: 2.2 cm across, 3.6 cm deep
  for (const sx of [-1, 1]) {
    // The long member: front foot → under the back of the seat → top of the reclined back.
    const foot = [sx * 0.155, 0.006, 0.232], knee = [sx * 0.155, 0.445, -0.105], top = [sx * 0.155, 0.852, -0.2];
    beam(wood, foot, knee, X, FRAME.w, FRAME.t);
    beam(wood, knee, top, X, FRAME.w, FRAME.t);
    // The short member, inside it: back foot → seat front.
    beam(wood, [sx * 0.13, 0.006, -0.232], [sx * 0.13, 0.43, 0.14], X, FRAME.w, FRAME.t);
    // Seat rail along each side, under the slats.
    beam(wood, [sx * 0.143, 0.43, -0.135], [sx * 0.143, 0.43, 0.165], Y, 0.03, 0.02);
  }
  // Six seat slats across the width (36 × 30 cm), at 46 cm.
  for (let k = 0; k < 6; k++) {
    const z = -0.12 + k * 0.053;
    beam(wood, [-0.18, 0.452, z], [0.18, 0.452, z], Z, 0.042, 0.016);
  }
  // Three back slats on the front of the uprights, tilted with the back.
  const knee = [0, 0.445, -0.105], top = [0, 0.852, -0.2];
  const up = norm(sub(top, knee)), front = norm(cross(X, up)); // toward +z, square to the back
  for (const f of [0.66, 0.8, 0.94]) {
    const c = add(lerp(knee, top, f), mul(front, 0.026));
    beam(wood, [-0.17, c[1], c[2]], [0.17, c[1], c[2]], up, 0.046, 0.015);
  }
  // Foot rails 10 cm up: across the long members' front feet and the short members' back feet.
  const along = (a, b, y) => lerp(a, b, (y - a[1]) / (b[1] - a[1]));
  const fr = along([0, 0.006, 0.232], knee, 0.1), br = along([0, 0.006, -0.232], [0, 0.43, 0.14], 0.1);
  beam(wood, [-0.155, 0.1, fr[2]], [0.155, 0.1, fr[2]], Y, 0.03, 0.018);
  beam(wood, [-0.13, 0.1, br[2]], [0.13, 0.1, br[2]], Y, 0.03, 0.018);
  const parts = [wood];
  if (cushion) {
    // KUDDARNA chair pad, 36 × 32 cm, about 3 cm thick, tied on the seat.
    const pad = new Part('Cushion', { uv: true });
    beam(pad, [-0.18, 0.475, 0.0], [0.18, 0.475, 0.0], Y, 0.03, 0.32);
    parts.push(pad);
  }
  return parts;
}

// ---- Table -----------------------------------------------------------------------------------
function table() {
  const wood = new Part('Wood', { uv: true });
  // Nine slats along x, 60 cm long, over the 62 cm depth; the top at 73 cm.
  for (let k = 0; k < 9; k++) {
    const z = -0.281 + k * 0.07025;
    beam(wood, [-0.3, 0.722, z], [0.3, 0.722, z], Z, 0.058, 0.016);
  }
  // Two cleats under the slats, over the leg frames (6 cm from the top to the frame's underside).
  for (const sx of [-1, 1]) beam(wood, [sx * 0.2, 0.692, -0.3], [sx * 0.2, 0.692, 0.3], X, 0.03, 0.044);
  // The legs cross in an X on each side: one pair outside, one inside, so they can fold.
  for (const sx of [-1, 1]) {
    beam(wood, [sx * 0.212, 0.006, 0.25], [sx * 0.212, 0.668, -0.27], X, 0.022, 0.04);
    beam(wood, [sx * 0.188, 0.006, -0.25], [sx * 0.188, 0.668, 0.27], X, 0.022, 0.04);
  }
  // Foot rails 10 cm up, front and back.
  const zAt = (y) => 0.25 - ((y - 0.006) / (0.668 - 0.006)) * 0.52;
  beam(wood, [-0.212, 0.1, zAt(0.1)], [0.212, 0.1, zAt(0.1)], Y, 0.03, 0.018);
  beam(wood, [-0.188, 0.1, -zAt(0.1)], [0.188, 0.1, -zAt(0.1)], Y, 0.03, 0.018);
  return [wood];
}

const MATERIALS = [
  { name: 'acacia', pbrMetallicRoughness: { baseColorFactor: [0.27, 0.13, 0.06, 1], metallicFactor: 0, roughnessFactor: 0.7 } },
  { name: 'cushion', pbrMetallicRoughness: { baseColorFactor: [0.58, 0.54, 0.46, 1], metallicFactor: 0, roughnessFactor: 0.95 } },
];
const MODELS = [
  ['assets/garden/ikea-askholmen-chair/model.glb', 'ASKHOLMEN chair, outdoor, foldable', chair({ cushion: false })],
  ['assets/garden/ikea-askholmen-chair/cushion.glb', 'ASKHOLMEN chair with KUDDARNA chair pad', chair({ cushion: true })],
  ['assets/garden/ikea-askholmen-table-60x62/model.glb', 'ASKHOLMEN table, outdoor, foldable, 60 × 62 cm', table()],
];
for (const [file, name, parts] of MODELS) {
  const out = join(root, file);
  writeGLB(out, { name, generator: 'living-room scripts/garden/askholmen.mjs', parts: parts.map((part, k) => ({ part, material: k })), materials: MATERIALS });
  summary(out, parts);
}
