// Checks the product catalog and the presets (assets/catalog/) against each other and against
// every product's options file, so a preset can only ever choose something the maker sells:
//   - products: required fields, model files present, parts and variants that exist
//   - options: each group's default exists, its parts exist, `model` options name a variant
//   - pieces: products and alternatives exist, one placement rule, references to earlier pieces
//   - presets: unique ids, pieces and products that exist, every choice an option of that
//     product that is sold (not `offered: false`), placements well formed
// Run by `npm test`; prints every problem and exits 1 if there are any.
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const read = (path) => JSON.parse(readFileSync(resolve(root, path), 'utf8'));
const problems = [];
const fail = (where, what) => problems.push(`${where}: ${what}`);

const { products, partSets = {} } = read('assets/catalog/products.json');
const { pieces, presets, palette = [], default: defaultPreset } = read('assets/catalog/presets.json');

// ---- Products and their options ----
const options = {};
const partsOf = (spec) => (typeof spec.parts === 'string' ? partSets[spec.parts] : spec.parts) ?? [];
for (const [id, p] of Object.entries(products)) {
  const at = `products.${id}`;
  for (const key of ['maker', 'name', 'category', 'size', 'model']) if (p[key] == null) fail(at, `no ${key}`);
  if (!p.url && !p.source) fail(at, 'needs a url (the product page) or a source (where the model comes from)');
  if (p.itemUrl && !p.itemUrl.includes('{item}')) fail(at, 'itemUrl has no {item}');
  for (const [name, m] of [['model', p.model], ...Object.entries(p.model?.variants ?? {}).map(([v, m]) => [`variant ${v}`, m])]) {
    if (!m?.file || !existsSync(resolve(root, m.file))) fail(at, `${name}: file ${m?.file} missing`);
    if (typeof m?.parts === 'string' && !partSets[m.parts]) fail(at, `${name}: no part set "${m.parts}"`);
    for (const part of partsOf(m ?? {})) {
      try { new RegExp(part.match); } catch { fail(at, `${name}: part ${part.id} has a bad match`); }
    }
  }
  if (!p.options) continue;
  if (!existsSync(resolve(root, p.options))) {
    fail(at, `options file ${p.options} missing`);
    continue;
  }
  const o = (options[id] = read(p.options));
  const partIds = new Set(partsOf(p.model).map((part) => part.id));
  for (const g of o.groups) {
    const ids = new Set(g.options.map((x) => x.id));
    if (!ids.has(g.default)) fail(`${p.options} ${g.id}`, `default ${g.default} is not an option`);
    else if (g.options.find((x) => x.id === g.default).offered === false) fail(`${p.options} ${g.id}`, `default ${g.default} is not sold`);
    for (const part of g.parts ?? []) if (!partIds.has(part)) fail(`${p.options} ${g.id}`, `part ${part} not in the model`);
    for (const x of g.options) if (x.model && x.model !== 'standard' && !p.model.variants?.[x.model]) fail(`${p.options} ${g.id}.${x.id}`, `model ${x.model} is not a variant`);
    // Each part's fallback (shown until the options load) looks like the default option.
    const def = g.options.find((x) => x.id === g.default);
    for (const partId of g.parts ?? []) {
      const fallback = partsOf(p.model).find((part) => part.id === partId)?.material;
      const want = specOf(g, def, partId);
      if (!fallback || !want) continue;
      const where = `${at} part ${partId}`;
      if (want.color && fallback.color && deltaE(want.color, fallback.color) > 3) fail(where, `fallback ${fallback.color} isn't the default ${def.name} (${want.color})`);
      if ((want.type === 'metal') !== ((fallback.metalness ?? 0) > 0.5)) fail(where, `fallback ${want.type === 'metal' ? 'should' : "shouldn't"} be metal, like the default ${def.name}`);
      if (want.roughness != null && fallback.roughness != null && Math.abs(want.roughness - fallback.roughness) > 0.15) fail(where, `fallback roughness ${fallback.roughness}, the default's is ${want.roughness}`);
    }
  }
}

// The material an option gives one part, as furniture.js's materialSpec() works it out.
function specOf(group, option, partId) {
  if (option.materials) return option.materials[partId] ?? null;
  if (option.material) return option.material;
  const family = group.families?.find((f) => f.id === option.family);
  return family ? { ...family.material, color: option.color } : { type: 'plain', color: option.color };
}

// CIE76 colour difference between two sRGB hex colours.
function deltaE(a, b) {
  const lab = (hex) => {
    const [r, g, bl] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
    const xyz = [(0.4124 * r + 0.3576 * g + 0.1805 * bl) / 0.9505, 0.2126 * r + 0.7152 * g + 0.0722 * bl, (0.0193 * r + 0.1192 * g + 0.9505 * bl) / 1.089];
    const f = xyz.map((t) => (t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 * t + 16) / 116));
    return [116 * f[1] - 16, 500 * (f[0] - f[1]), 200 * (f[1] - f[2])];
  };
  const [x, y] = [lab(a), lab(b)];
  return Math.hypot(x[0] - y[0], x[1] - y[1], x[2] - y[2]);
}

// ---- Pieces ----
const pieceIds = new Set();
for (const [i, piece] of pieces.entries()) {
  const at = `pieces[${i}] ${piece.id}`;
  if (pieceIds.has(piece.id)) fail(at, 'duplicate id');
  if (!products[piece.product]) fail(at, `product ${piece.product} unknown`);
  for (const alt of piece.alternatives ?? []) if (!products[alt]) fail(at, `alternative ${alt} unknown`);
  if (piece.alternatives && !piece.alternatives.includes(piece.product)) fail(at, 'its product is not among its alternatives');
  const rules = ['place', 'attach', 'around'].filter((k) => piece[k]);
  if (rules.length !== 1) fail(at, `needs exactly one of place / attach / around (has ${rules.join(', ') || 'none'})`);
  if (piece.place) checkPlace(at, piece.place);
  for (const k of ['attach', 'around']) if (piece[k] && !pieceIds.has(piece[k].to)) fail(at, `${k}.to ${piece[k].to} is not an earlier piece`);
  if (piece.match && !pieceIds.has(piece.match)) fail(at, `match ${piece.match} is not an earlier piece`);
  pieceIds.add(piece.id);
}
function checkPlace(at, place) {
  const across = ['left', 'right', 'x'].filter((k) => place[k] != null), along = ['window', 'door', 'z'].filter((k) => place[k] != null);
  if (across.length !== 1) fail(at, 'place needs one of left / right / x');
  if (along.length !== 1) fail(at, 'place needs one of window / door / z');
  if (![0, 90, 180, 270].includes(place.rotation)) fail(at, `rotation ${place.rotation} is not 0, 90, 180 or 270`);
}

// ---- Presets ----
if (!presets.some((p) => p.id === defaultPreset)) fail('presets.json', `default ${defaultPreset} is not a preset`);
const presetIds = new Set();
for (const preset of presets) {
  const at = `presets.${preset.id}`;
  if (presetIds.has(preset.id) || preset.id === 'none') fail(at, 'duplicate or reserved id');
  presetIds.add(preset.id);
  // Its maker label lists the makers of the furniture it names (plants aside), no more, no fewer.
  const makers = new Set();
  for (const [key, entry] of Object.entries(preset.pieces)) {
    const piece = pieces.find((p) => p.id === key) ?? pieces.find((p) => p.product === key);
    const product = products[entry.product ?? piece?.product];
    if (product && product.category !== 'plant' && entry.present !== false) makers.add(product.maker);
  }
  const listed = (preset.maker ?? '').split(' · ').filter(Boolean);
  if (listed.sort().join() !== [...makers].sort().join()) fail(at, `maker "${preset.maker ?? ''}" should be "${[...makers].join(' · ')}"`);
  for (const [key, entry] of Object.entries(preset.pieces)) {
    // A piece id, or a product id for every piece of that product.
    const targets = pieceIds.has(key) ? pieces.filter((p) => p.id === key) : pieces.filter((p) => p.product === key);
    if (!targets.length) {
      fail(at, `${key} is neither a piece nor a product in the room`);
      continue;
    }
    for (const piece of targets) {
      const product = entry.product ?? piece.product;
      if (!products[product]) fail(`${at}.${key}`, `product ${product} unknown`);
      else if (entry.product && !(piece.alternatives ?? [piece.product]).includes(product)) fail(`${at}.${key}`, `${product} is not an alternative for ${piece.id}`);
      if (entry.present === false && !piece.optional) fail(`${at}.${key}`, `${piece.id} isn't optional, so it can't be left out`);
      if (entry.place) checkPlace(`${at}.${key}`, entry.place);
      const o = options[product];
      for (const [group, choice] of Object.entries(entry.choices ?? {})) {
        const g = o?.groups.find((x) => x.id === group);
        const option = g?.options.find((x) => x.id === choice);
        if (!g) fail(`${at}.${key}`, `${product} has no option group ${group}`);
        else if (!option) fail(`${at}.${key}`, `${product} ${group} has no option ${choice}`);
        else if (option.offered === false) fail(`${at}.${key}`, `${product} ${group} ${choice} (${option.name}) is not sold`);
      }
    }
  }
}
for (const [key, group] of palette) {
  const piece = pieces.find((p) => p.id === key || p.product === key);
  if (!piece) fail('palette', `${key} is not in the room`);
  else if (!options[piece.product]?.groups.some((g) => g.id === group)) fail('palette', `${piece.product} has no group ${group}`);
}

if (problems.length) {
  console.error(`✗ catalog: ${problems.length} problem${problems.length > 1 ? 's' : ''}\n  ${problems.join('\n  ')}`);
  process.exit(1);
}
console.log(`✓ catalog: ${Object.keys(products).length} products, ${pieces.length} pieces, ${presets.length} presets, every choice sold`);
