// Shrinks a manufacturer OBJ for the web: rounds coordinates and drops comments, smoothing
// groups and the material library (materials are assigned in src/furniture.js by group name).
//
// usage: node scripts/compact-obj.mjs <in.obj> <out.obj> [v-decimals] [--vt=<decimals>]
//   v-decimals  rounding for positions, default 1 (0.1 mm when the file is in millimetres)
//   --vt=N      rounding for texture coordinates; by default chosen from their range:
//               4 decimals for 0–1 UVs, 1 for UVs in model units (e.g. millimetres)
// Files that name their parts only with `usemtl` (no `g`/`o` groups) get one `g` group per
// material instead, so the parts can still be told apart.
import { readFileSync, writeFileSync } from 'node:fs';

const args = process.argv.slice(2);
const flags = Object.fromEntries(args.filter((a) => a.startsWith('--')).map((a) => a.slice(2).split('=')));
const [input, output, vDec = '1'] = args.filter((a) => !a.startsWith('--'));
if (!input || !output) {
  console.error('usage: node scripts/compact-obj.mjs <in.obj> <out.obj> [v-decimals] [--vt=<decimals>]');
  process.exit(1);
}

const lines = readFileSync(input, 'utf8').split(/\r?\n/);
const hasGroups = lines.some((l) => /^\s*[go]\s/.test(l));
let maxUv = 0;
for (const l of lines) {
  if (l.startsWith('vt ')) for (const n of l.split(/\s+/).slice(1, 3)) maxUv = Math.max(maxUv, Math.abs(Number(n)));
}
const vtDec = Number(flags.vt ?? (maxUv <= 4 ? 4 : 1));

const round = (s, d) => String(Number(Number(s).toFixed(d)));
const out = [];
for (const line of lines) {
  const t = line.trim();
  if (!t || t.startsWith('#') || t.startsWith('mtllib') || t.startsWith('s ')) continue;
  const [kind, ...rest] = t.split(/\s+/);
  if (kind === 'usemtl') {
    if (!hasGroups) out.push(`g ${rest.join('_')}`);
  } else if (kind === 'v') out.push(`v ${rest.slice(0, 3).map((n) => round(n, Number(vDec))).join(' ')}`);
  else if (kind === 'vt') out.push(`vt ${rest.slice(0, 2).map((n) => round(n, vtDec)).join(' ')}`);
  else if (kind === 'vn') out.push(`vn ${rest.map((n) => round(n, 3)).join(' ')}`);
  else out.push(t); // f, g, o lines unchanged (indices stay valid: no v/vt/vn lines are dropped)
}
writeFileSync(output, out.join('\n') + '\n');
console.log(`Wrote ${output} (${out.length} lines; positions ${vDec} decimals, UVs ${vtDec}${hasGroups ? '' : '; groups from materials'})`);
