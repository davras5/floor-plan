// Shared pieces for the procedural plant generators in this folder (no dependencies): seeded
// random numbers, small vector maths, value noise, mesh parts with consistent winding, pots,
// soil, tubes, PNG encoding and a plain glTF-binary writer. Metres, Y up.
// (fiddle-leaf-fig.mjs predates this file and keeps its own copies.)
import { mkdirSync, writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { dirname } from 'node:path';

// ---- Random numbers --------------------------------------------------------------------------
export function random(seed) {
  let a = seed | 0;
  const next = () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  next.range = (lo, hi) => lo + (hi - lo) * next();
  return next;
}

// ---- Vectors -----------------------------------------------------------------------------------
export const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const mul = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
export const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
export const len = (a) => Math.hypot(a[0], a[1], a[2]);
export const norm = (a) => mul(a, 1 / (len(a) || 1));
export const lerp = (a, b, t) => add(a, mul(sub(b, a), t));
// Rotates v about the unit axis k by angle a (Rodrigues).
export const rot = (v, k, a) => {
  const c = Math.cos(a), s = Math.sin(a);
  return add(add(mul(v, c), mul(cross(k, v), s)), mul(k, dot(k, v) * (1 - c)));
};
export const clamp = (x, a = 0, b = 1) => Math.min(b, Math.max(a, x));
export const smooth = (a, b, x) => {
  const t = clamp((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};
export const UP = [0, 1, 0];
export const deg = (d) => (d * Math.PI) / 180;

// ---- Noise -------------------------------------------------------------------------------------
function hash2(i, j, s) {
  let h = (Math.imul(i, 374761393) + Math.imul(j, 668265263) + Math.imul(s, 982451653)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
export function vnoise(x, y, s) {
  const i = Math.floor(x), j = Math.floor(y), fx = x - i, fy = y - j;
  const ux = fx * fx * (3 - 2 * fx), uy = fy * fy * (3 - 2 * fy);
  const a = hash2(i, j, s), b = hash2(i + 1, j, s), c = hash2(i, j + 1, s), d = hash2(i + 1, j + 1, s);
  return a + (b - a) * ux + (c - a) * uy + (a - b - c + d) * ux * uy;
}
export function fbm(x, y, s, octaves = 4) {
  let v = 0, amp = 0.5, f = 1;
  for (let o = 0; o < octaves; o++, f *= 2, amp *= 0.5) v += amp * vnoise(x * f, y * f, s + o * 17);
  return v;
}

// ---- Mesh parts --------------------------------------------------------------------------------
export class Part {
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
  // side the normals face as the front.
  tri(a, b, c) {
    const P = (k) => [this.p[3 * k], this.p[3 * k + 1], this.p[3 * k + 2]];
    const N = (k) => [this.n[3 * k], this.n[3 * k + 1], this.n[3 * k + 2]];
    const g = cross(sub(P(b), P(a)), sub(P(c), P(a)));
    if (len(g) < 1e-14) return;
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
// square to that segment: smooth around, crisp at rims and feet.
export function lathe(part, profile, segs) {
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

// A pot: tapered walls, a rounded foot, optionally a collar (the thick rim band of a clay pot),
// a squared-off rim, the inside wall down to just under the soil, and a closed underside.
// Returns the radius of the inside wall at height y (for the soil).
export function pot(part, { rTop, rBottom, height: H, wall, soilY, collar = null, segs = 48 }) {
  const rb = rBottom, foot = Math.min(0.009, rb * 0.08);
  let profile;
  let rOuter; // outer radius as a function of height, below the collar
  if (collar) {
    const yc = H - collar.height, rc = rTop - collar.step; // the body meets the collar here
    rOuter = (y) => rb + ((rc - rb) * y) / yc;
    profile = [
      [rb - foot, 0], [rb - foot * 0.35, foot * 0.15], [rb - foot * 0.08, foot * 0.5], [rb, foot],
      [rc, yc], [rTop - 0.0015, yc + 0.0012], [rTop, yc + 0.003], [rTop, H - 0.002], [rTop - 0.002, H],
      [rTop - wall - collar.step + 0.0015, H], [rTop - wall - collar.step, H - 0.0025],
    ];
  } else {
    rOuter = (y) => rb + ((rTop - rb) * y) / H;
    profile = [
      [rb - foot, 0], [rb - foot * 0.35, foot * 0.15], [rb - foot * 0.08, foot * 0.5], [rb, foot],
      [rTop, H - 0.003], [rTop - 0.0015, H], [rTop - wall + 0.0015, H], [rTop - wall, H - 0.003],
    ];
  }
  const inner = (y) => rOuter(y) - wall;
  profile.push([inner(soilY - 0.015), soilY - 0.015]);
  lathe(part, profile, segs);
  const centre = part.v([0, 0, 0], [0, -1, 0]);
  const ring = Array.from({ length: segs + 1 }, (_, k) => {
    const a = (k / segs) * 2 * Math.PI;
    return part.v([(rb - foot) * Math.cos(a), 0, (rb - foot) * Math.sin(a)], [0, -1, 0]);
  });
  for (let k = 0; k < segs; k++) part.tri(centre, ring[k], ring[k + 1]);
  return inner;
}

// Soil: a slightly domed, lumpy disc of radius r at height y, tucked into the pot wall.
export function soilDisc(part, { r, y: y0, seed = 21, dome = 0.004, bump = 0.005, segs = 36 }) {
  const radii = [0, 0.25, 0.5, 0.75, 0.9, 1];
  const grid = radii.map((f, ri) => Array.from({ length: f === 0 ? 1 : segs + 1 }, (_, k) => {
    const a = (k / segs) * 2 * Math.PI, x = f * r * Math.cos(a), z = f * r * Math.sin(a);
    const b = (fbm(x * 60 + 3, z * 60 + 7, seed) - 0.5) * bump * (ri === radii.length - 1 ? 0 : 1);
    const n = fbm(x * 110, z * 110, seed + 10), dark = 0.035 + 0.035 * n;
    return part.v([x, y0 + dome * (1 - f * f) + b, z], UP, null, [dark * 1.3, dark, dark * 0.75]);
  }));
  for (let ri = 0; ri < radii.length - 1; ri++) {
    for (let k = 0; k < segs; k++) {
      if (ri === 0) part.tri(grid[0][0], grid[1][k], grid[1][k + 1]);
      else part.quad(grid[ri][k], grid[ri][k + 1], grid[ri + 1][k + 1], grid[ri + 1][k]);
    }
  }
  smoothNormals(part);
}

// A tube along a polyline, closed with a point at the far end.
export function tube(part, pts, radii, segs, colourAt) {
  let frameN = null, T = null;
  const rings = [];
  for (let i = 0; i < pts.length; i++) {
    T = norm(sub(pts[Math.min(i + 1, pts.length - 1)], pts[Math.max(i - 1, 0)]));
    if (!frameN) frameN = norm(cross(T, Math.abs(T[1]) < 0.9 ? UP : [1, 0, 0]));
    frameN = norm(sub(frameN, mul(T, dot(frameN, T))));
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

export function bezier(p0, p1, p2, n) {
  return Array.from({ length: n + 1 }, (_, k) => {
    const t = k / n;
    return add(add(mul(p0, (1 - t) * (1 - t)), mul(p1, 2 * t * (1 - t))), mul(p2, t * t));
  });
}

// Recomputes vertex normals from the faces (area-weighted).
export function smoothNormals(part) {
  const acc = new Float64Array(part.p.length);
  for (let q = 0; q < part.i.length; q += 3) {
    const [a, b, c] = [part.i[q], part.i[q + 1], part.i[q + 2]];
    const P = (k) => [part.p[3 * k], part.p[3 * k + 1], part.p[3 * k + 2]];
    const g = cross(sub(P(b), P(a)), sub(P(c), P(a)));
    for (const k of [a, b, c]) for (let e = 0; e < 3; e++) acc[3 * k + e] += g[e];
  }
  for (let k = 0; k < part.p.length / 3; k++) part.n.splice(3 * k, 3, ...norm([acc[3 * k], acc[3 * k + 1], acc[3 * k + 2]]));
}

// A grid surface: rows × cols points from pointAt(i, j) (i across, j along), normals by central
// differences turned to agree with `facing(i, j)`, UVs and colours per point.
export function gridSurface(part, cols, rows, { pointAt, uvAt, colourAt, facing }) {
  const W = cols + 1, pts = [];
  for (let j = 0; j <= rows; j++) for (let i = 0; i <= cols; i++) pts.push(pointAt(i, j));
  const G = (i, j) => pts[clamp(j, 0, rows) * W + clamp(i, 0, cols)];
  const ids = pts.map((p, q) => {
    const i = q % W, j = Math.floor(q / W);
    let nn = cross(sub(G(i + 1, j), G(i - 1, j)), sub(G(i, j + 1), G(i, j - 1)));
    if (len(nn) < 1e-12) nn = facing(i, j);
    if (dot(nn, facing(i, j)) < 0) nn = mul(nn, -1);
    return part.v(p, nn, uvAt?.(i, j), colourAt?.(i, j));
  });
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) part.quad(ids[j * W + i], ids[j * W + i + 1], ids[(j + 1) * W + i + 1], ids[(j + 1) * W + i]);
  }
  return pts;
}

// ---- Textures ----------------------------------------------------------------------------------
// Normal map (glTF convention: +X right, +Y up in the image) from a height field in pixels.
export function normalsFromHeight(height, w, h, strength = 1) {
  const rgb = new Uint8Array(w * h * 3);
  const H = (x, y) => height[clamp(y, 0, h - 1) * w + clamp(x, 0, w - 1)];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const gx = (H(x + 1, y) - H(x - 1, y)) / 2, gy = (H(x, y + 1) - H(x, y - 1)) / 2;
      const n = norm([-gx * strength, gy * strength, 1]);
      rgb.set(n.map((v) => Math.round((v * 0.5 + 0.5) * 255)), 3 * (y * w + x));
    }
  }
  return rgb;
}

export function png(w, h, pixels, channels) {
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

// ---- glTF binary -------------------------------------------------------------------------------
const srgbToLinear = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
export const linear = (hex) => [1, 3, 5].map((i) => srgbToLinear(parseInt(hex.slice(i, i + 2), 16) / 255));

// parts: [{ part, material }] (material = index into materials); images: [{ name, png }];
// textures reference images by index; materials are glTF JSON.
export function writeGLB(file, { name, generator, parts, materials, images = [], textures = [], extensionsUsed = [] }) {
  const json = {
    asset: { version: '2.0', generator },
    ...(extensionsUsed.length ? { extensionsUsed } : {}),
    scene: 0,
    scenes: [{ name, nodes: [0] }],
    nodes: [{ name: name.replace(/-/g, '_'), children: parts.map((_, k) => k + 1) }],
    meshes: [], accessors: [], bufferViews: [], buffers: [], materials,
    ...(textures.length ? { samplers: [{ magFilter: 9729, minFilter: 9987, wrapS: 33071, wrapT: 33071 }], images: [], textures: textures.map((t) => ({ sampler: 0, ...t })) } : {}),
  };
  const chunks = [];
  let offset = 0;
  const view = (bytes, target) => {
    const b = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    json.bufferViews.push({ buffer: 0, byteOffset: offset, byteLength: b.length, ...(target ? { target } : {}) });
    const padded = Buffer.concat([b, Buffer.alloc((4 - (b.length % 4)) % 4)]);
    chunks.push(padded);
    offset += padded.length;
    return json.bufferViews.length - 1;
  };
  const accessor = (array, type, target, props = {}) => {
    const componentType = array instanceof Float32Array ? 5126 : array instanceof Uint32Array ? 5125 : 5123;
    const size = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 }[type];
    json.accessors.push({ bufferView: view(array, target), componentType, count: array.length / size, type, ...props });
    return json.accessors.length - 1;
  };
  for (const im of images) json.images.push({ name: im.name, mimeType: 'image/png', bufferView: view(new Uint8Array(im.png)) });
  parts.forEach(({ part, material }) => {
    const P = new Float32Array(part.p), min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
    for (let k = 0; k < P.length; k++) {
      min[k % 3] = Math.min(min[k % 3], P[k]);
      max[k % 3] = Math.max(max[k % 3], P[k]);
    }
    const attributes = {
      POSITION: accessor(P, 'VEC3', 34962, { min, max }),
      NORMAL: accessor(new Float32Array(part.n), 'VEC3', 34962),
    };
    if (part.hasUV) attributes.TEXCOORD_0 = accessor(new Float32Array(part.t), 'VEC2', 34962);
    if (part.hasColour) attributes.COLOR_0 = accessor(new Float32Array(part.c), 'VEC4', 34962);
    const indices = part.p.length / 3 > 65535 ? new Uint32Array(part.i) : new Uint16Array(part.i);
    json.meshes.push({ name: part.name, primitives: [{ attributes, indices: accessor(indices, 'SCALAR', 34963), material, mode: 4 }] });
    json.nodes.push({ name: part.name, mesh: json.meshes.length - 1 });
  });
  const bin = Buffer.concat(chunks);
  json.buffers.push({ byteLength: bin.length });
  const jsonBuf = Buffer.from(JSON.stringify(json));
  const jsonChunk = Buffer.concat([jsonBuf, Buffer.alloc((4 - (jsonBuf.length % 4)) % 4, 0x20)]);
  const head = (n, type) => {
    const b = Buffer.alloc(8);
    b.writeUInt32LE(n, 0);
    b.writeUInt32LE(type, 4);
    return b;
  };
  const header = Buffer.alloc(12);
  header.writeUInt32LE(0x46546c67, 0);
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(12 + 8 + jsonChunk.length + 8 + bin.length, 8);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, Buffer.concat([header, head(jsonChunk.length, 0x4e4f534a), jsonChunk, head(bin.length, 0x004e4942), bin]));
  return bin.length;
}

// Bounds of some parts, and a one-line summary for the console.
export function bounds(parts) {
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (const part of parts) for (let k = 0; k < part.p.length; k++) {
    lo[k % 3] = Math.min(lo[k % 3], part.p[k]);
    hi[k % 3] = Math.max(hi[k % 3], part.p[k]);
  }
  return { lo, hi, size: hi.map((h, k) => h - lo[k]) };
}
export function summary(file, parts) {
  const f3 = (v) => v.map((n) => n.toFixed(3)).join(', ');
  const all = bounds(parts);
  console.log(`wrote ${file}`);
  console.log('triangles: ' + parts.map((p) => `${p.name} ${p.triangles}`).join(', ') + `; total ${parts.reduce((s, p) => s + p.triangles, 0)}`);
  console.log(`bounds min ${f3(all.lo)} max ${f3(all.hi)} (W × D × H ${all.size[0].toFixed(3)} × ${all.size[2].toFixed(3)} × ${all.size[1].toFixed(3)})`);
  for (const p of parts) {
    const b = bounds([p]);
    console.log(`  ${p.name}: min ${f3(b.lo)} max ${f3(b.hi)}`);
  }
}
