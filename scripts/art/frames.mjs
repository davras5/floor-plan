// The framed art prints (assets/art/<product>/): one small glTF binary per frame profile, with
// four parts the catalog colours (products.json `parts`, the finishes in options.json):
//   Frame   four mitred bars; texture coordinates in metres, v along each bar (the wood grain)
//   Paper   the print's sheet, its white margin showing inside the frame (no passe-partout)
//   Image   the artwork on the sheet, texture coordinates 0–1 (v = 1 at the top), for print.jpg
// No glass. Metres, Y up, origin at the middle of the frame's bottom edge with its back on the
// wall (z = 0) and its front toward +z, the room. No textures inside: the catalog's materials
// and the print's JPEG are put on in the app.
//
// The sheet and image sizes were measured on the shop's photos of each print (Fondation Beyeler,
// 2026-10-26); the frame profiles are the frame makers' where they publish them, else typical.
//
// usage: node scripts/art/frames.mjs     (rewrites every model below)
import { join, resolve } from 'node:path';
import { Part, writeGLB, summary } from '../plants/lib.mjs';

const root = resolve(import.meta.dirname, '../..');

// face: visible width of the frame; depth: front to wall; overlap: how far the frame's lip covers
// the sheet's edge; recess: the sheet behind the frame's front (the glass, or acrylic, in between).
const PROFILES = {
  // A plain wooden frame with glass in a rebate: Fondation Beyeler's white frames for its prints,
  // and boesner's Quadro (oak, black). Neither publishes its profile; about 2 × 2.5 cm.
  wood: { face: 0.02, depth: 0.025, overlap: 0.005, recess: 0.008 },
  // Moebe Frame: a slim oak or aluminium frame holding the sheet between two acrylic panes
  // (no back board). 1.2 cm deep (Connox, 50 × 70 cm).
  moebe: { face: 0.011, depth: 0.012, overlap: 0.004, recess: 0.004 },
};

const ART = [
  {
    dir: 'assets/art/beyeler-hodler-grammont-60x80',
    name: 'Hodler, Le Grammont après la pluie, 60 × 80 cm',
    sheet: [0.8, 0.6], // landscape: W × H
    image: [0.7, 0.53], // centred on the sheet
    models: { 'model.glb': 'wood' },
  },
  {
    dir: 'assets/art/beyeler-hodler-mont-blanc-50x70',
    name: 'Hodler, Le Mont-Blanc aux nuages roses, 50 × 70 cm',
    sheet: [0.7, 0.5],
    image: [0.6, 0.42],
    models: { 'model.glb': 'wood', 'moebe.glb': 'moebe' },
  },
];

for (const art of ART) {
  for (const [file, profileId] of Object.entries(art.models)) {
    const parts = framed(art, PROFILES[profileId]);
    const out = join(root, art.dir, file);
    writeGLB(out, {
      name: `${art.name}, ${profileId} frame`,
      generator: 'living-room scripts/art/frames.mjs',
      parts: parts.map((part, material) => ({ part, material })),
      materials: [
        { name: 'frame', pbrMetallicRoughness: { baseColorFactor: [0.9, 0.9, 0.88, 1], metallicFactor: 0, roughnessFactor: 0.6 } },
        { name: 'paper', pbrMetallicRoughness: { baseColorFactor: [0.86, 0.84, 0.8, 1], metallicFactor: 0, roughnessFactor: 0.9 } },
        { name: 'image', pbrMetallicRoughness: { baseColorFactor: [0.5, 0.5, 0.5, 1], metallicFactor: 0, roughnessFactor: 0.85 } },
      ],
    });
    summary(out, parts);
  }
}

function framed({ sheet: [sw, sh], image: [iw, ih] }, { face: f, depth: d, overlap, recess }) {
  const W = sw + 2 * (f - overlap), H = sh + 2 * (f - overlap);
  const frame = new Part('Frame', { uv: true }), paper = new Part('Paper'), image = new Part('Image', { uv: true });

  // Each bar from its outer edge (o0 → o1, anticlockwise round the frame) to its inner edge
  // (i1 → i0), with the outer edge's outward normal; the mitres meet at the corners.
  const x0 = -W / 2, x1 = W / 2;
  const bars = [
    [[x0, 0], [x1, 0], [x1 - f, f], [x0 + f, f], [0, -1]], // bottom
    [[x1, 0], [x1, H], [x1 - f, H - f], [x1 - f, f], [1, 0]], // right
    [[x1, H], [x0, H], [x0 + f, H - f], [x1 - f, H - f], [0, 1]], // top
    [[x0, H], [x0, 0], [x0 + f, f], [x0 + f, H - f], [-1, 0]], // left
  ];
  for (const [o0, o1, i1, i0, out] of bars) {
    const t = [o1[0] - o0[0], o1[1] - o0[1]], l = Math.hypot(...t);
    const along = (p) => (p[0] * t[0] + p[1] * t[1]) / l, across = (p) => p[0] * out[0] + p[1] * out[1];
    const uv = (p) => [across(p), along(p)];
    // Front and back.
    for (const [z, nz] of [[d, 1], [0, -1]]) {
      const v = [o0, o1, i1, i0].map((p) => frame.v([p[0], p[1], z], [0, 0, nz], uv(p)));
      frame.quad(...v);
    }
    // Outer and inner sides (u across the depth).
    for (const [a, b, n] of [[o0, o1, out], [i0, i1, [-out[0], -out[1]]]]) {
      const v = [[a, 0], [b, 0], [b, d], [a, d]].map(([p, z]) => frame.v([p[0], p[1], z], [n[0], n[1], 0], [z, along(p)]));
      frame.quad(...v);
    }
  }

  // The sheet, behind the frame's front; its edges run under the frame's lip.
  const zp = d - recess, cy = H / 2;
  const rect = (part, w, h, z, withUV) => {
    const v = [[-w / 2, cy - h / 2, 0, 0], [w / 2, cy - h / 2, 1, 0], [w / 2, cy + h / 2, 1, 1], [-w / 2, cy + h / 2, 0, 1]]
      .map(([x, y, u, vv]) => part.v([x, y, z], [0, 0, 1], withUV ? [u, vv] : undefined));
    part.quad(...v);
  };
  rect(paper, sw, sh, zp, false);
  rect(image, iw, ih, zp + 0.0005, true);
  return [frame, paper, image];
}
