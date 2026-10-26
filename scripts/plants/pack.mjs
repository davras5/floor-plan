// Makes the web copies of the plants in assets/plants/<name>/:
//   model.glb   WebP textures (1k at most), quantized geometry with meshopt compression
//               (three.js: GLTFLoader.setMeshoptDecoder, from three/addons/libs/meshopt_decoder.module.js)
//   info.json   source, author, licence, triangles, size, materials and their roles
// Sources: the procedural fig (raw/plants/fiddle-leaf-fig.glb, from fiddle-leaf-fig.mjs) and the
// Poly Haven download in raw/downloads/plants/ (raw/ is gitignored).
//
// The glTF tools aren't app dependencies, so they're not in package.json. Either install them
// next to the repo (node_modules/ is gitignored):
//   npm i --no-save @gltf-transform/core@4 @gltf-transform/extensions@4 @gltf-transform/functions@4 meshoptimizer@1 sharp
// or point GLTF_TOOLS at any folder that has them in its node_modules.
//
// usage: node scripts/plants/pack.mjs [name ...]     (default: all plants below)
import { readFileSync, writeFileSync, mkdirSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = resolve(import.meta.dirname, '../..');
const tools = createRequire(join(resolve(process.env.GLTF_TOOLS ?? root), 'package.json'));
const load = async (id) => import(pathToFileURL(tools.resolve(id)).href);
const { NodeIO } = await load('@gltf-transform/core');
const { ALL_EXTENSIONS, EXTTextureWebP } = await load('@gltf-transform/extensions');
const { dedup, prune, weld, meshopt, getBounds, listTextureSlots } = await load('@gltf-transform/functions');
const { MeshoptEncoder, MeshoptDecoder } = await load('meshoptimizer');
const sharp = (await load('sharp')).default;
await Promise.all([MeshoptEncoder.ready, MeshoptDecoder.ready]);

const PLANTS = {
  'fiddle-leaf-fig': {
    input: 'raw/plants/fiddle-leaf-fig.glb',
    info: {
      name: 'Fiddle-leaf fig (Ficus lyrata), grown as a standard',
      source: {
        kind: 'procedural',
        script: 'scripts/plants/fiddle-leaf-fig.mjs (seed 11), then scripts/plants/pack.mjs',
        url: null,
        author: 'Generated for this project (no third-party content)',
        licence: 'CC0 1.0',
        why: 'Poly Haven (CC0) has no fiddle-leaf fig, olive, monstera or strelitzia; its one tall potted plant (Potted Plant 01) is in an ornate terracotta urn',
      },
      pot: {
        recolourable: true,
        how: 'material fig_pot has no texture and no vertex colours: set its color',
        current: '#d6cdc1',
        suggested: { default: '#d6cdc1 (warm sand stoneware)', alternatives: ['#ece9e3 (off-white)', '#b5694a (terracotta)', '#3b3a37 (charcoal)'] },
      },
    },
    roles: {
      fig_leaves: 'leaves: alpha-tested cut-outs (alphaMode MASK, cutoff 0.5), double-sided; the alpha is in the base colour texture. KHR_materials_specular (specularFactor 0.6) makes three.js load it as a MeshPhysicalMaterial',
      fig_pot: 'pot: plain colour, recolourable',
      fig_soil: 'soil: vertex colours',
      fig_bark: 'trunk, branches and leaf stalks: vertex colours',
    },
  },
  'rubber-plant': {
    input: 'raw/plants/rubber-plant.glb',
    info: {
      name: 'Rubber plant (Ficus elastica), young, three cuttings in a clay pot',
      source: {
        kind: 'procedural',
        script: 'scripts/plants/rubber-plant.mjs (seed 5, uses lib.mjs), then scripts/plants/pack.mjs',
        url: null,
        author: 'Generated for this project (no third-party content)',
        licence: 'CC0 1.0',
      },
      pot: {
        recolourable: true,
        how: 'material rubber_pot has no texture and no vertex colours: set its color',
        current: '#b5694a',
        suggested: { default: '#b5694a (terracotta)', alternatives: ['#d6cdc1 (warm sand)', '#ece9e3 (off-white)', '#3b3a37 (charcoal)'] },
      },
    },
    roles: {
      rubber_leaves: 'leaves: opaque geometry cut to the leaf outline (no alpha), double-sided. KHR_materials_specular (specularFactor 0.6) makes three.js load it as a MeshPhysicalMaterial',
      rubber_pot: 'pot: plain colour, recolourable',
      rubber_soil: 'soil: vertex colours',
      rubber_stems: 'stems, leaf stalks and the red leaf sheaths: vertex colours',
    },
  },
  'snake-plant': {
    input: 'raw/plants/snake-plant.glb',
    info: {
      name: "Snake plant (Dracaena trifasciata 'Laurentii'), small",
      source: {
        kind: 'procedural',
        script: 'scripts/plants/snake-plant.mjs (seed 3, uses lib.mjs), then scripts/plants/pack.mjs',
        url: null,
        author: 'Generated for this project (no third-party content)',
        licence: 'CC0 1.0',
      },
      pot: {
        recolourable: true,
        how: 'material snake_pot has no texture and no vertex colours: set its color',
        current: '#3b3a37',
        suggested: { default: '#3b3a37 (charcoal)', alternatives: ['#d6cdc1 (warm sand)', '#ece9e3 (off-white)', '#b5694a (terracotta)'] },
      },
    },
    roles: {
      snake_leaves: 'leaves: opaque geometry cut to the leaf outline (no alpha), double-sided; vertex colours darken the bases',
      snake_pot: 'pot: plain colour, recolourable',
      snake_soil: 'soil: vertex colours',
    },
  },
  'zebra-haworthia': {
    input: 'raw/downloads/plants/polyhaven-potted_plant_04-1k/potted_plant_04_1k.gltf',
    prepare: prepareHaworthia,
    textureLimits: { metallicRoughnessTexture: 512, occlusionTexture: 512 },
    info: {
      name: 'Zebra haworthia in a white ceramic pot (Poly Haven "Potted Plant 04")',
      source: {
        kind: 'download',
        url: 'https://polyhaven.com/a/potted_plant_04',
        files: 'https://api.polyhaven.com/files/potted_plant_04 (glTF, 1k), downloaded 2026-10-26',
        author: 'James Ray Cock',
        licence: 'CC0 1.0 (https://polyhaven.com/license)',
        changes: 'one material split into leaves/pot/soil (same textures), the ARM texture also used as occlusion, textures re-encoded as WebP (ARM 512 px), meshopt',
      },
      pot: {
        recolourable: 'tint only',
        how: 'haworthia_pot uses the scan\'s colour texture (an off-white glazed pot); its color multiplies that texture, so it can be tinted darker but not lightened',
        current: '#ffffff (texture: off-white glaze)',
        suggested: { default: 'leave as is (off-white)', alternatives: ['#d9d2c6 (sand tint)', '#9fa79a (sage tint)'] },
      },
    },
    roles: {
      haworthia_leaves: 'leaves: solid scanned geometry (no alpha needed), double-sided',
      haworthia_pot: 'pot: scanned colour texture, tintable',
      haworthia_soil: 'soil and gravel top dressing',
    },
  },
};

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.encoder': MeshoptEncoder, 'meshopt.decoder': MeshoptDecoder });
const names = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(PLANTS);
for (const name of names) await pack(name, PLANTS[name]);

async function pack(name, spec) {
  const doc = await io.read(join(root, spec.input));
  if (spec.prepare) spec.prepare(doc);
  await webpTextures(doc, spec.textureLimits ?? {});
  // keepUniqueNames: the haworthia's three materials are identical apart from their names.
  await doc.transform(dedup({ keepUniqueNames: true }), prune(), weld(), meshopt({ encoder: MeshoptEncoder, level: 'medium' }));
  const dir = join(root, 'assets/plants', name);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'model.glb');
  writeFileSync(file, await io.writeBinary(doc));
  writeFileSync(join(dir, 'info.json'), JSON.stringify(describe(doc, spec, statSync(file).size), null, 2) + '\n');
  console.log(`${name}: ${(statSync(file).size / 1024).toFixed(0)} KB`);
}

// Re-encodes every texture as WebP, at most 1024 px (less for the slots in `limits`). Colour
// maps keep a lossless alpha channel (sharp's default), so cut-outs stay exact.
async function webpTextures(doc, limits) {
  doc.createExtension(EXTTextureWebP).setRequired(true);
  for (const tex of doc.getRoot().listTextures()) {
    const slots = listTextureSlots(tex);
    const max = Math.min(1024, ...slots.map((s) => limits[s] ?? 1024));
    const normal = slots.includes('normalTexture'), colour = slots.includes('baseColorTexture');
    const image = await sharp(tex.getImage())
      .resize({ width: max, height: max, fit: 'inside', withoutEnlargement: true })
      .webp({ quality: normal ? 90 : colour ? 86 : 82, smartSubsample: true, effort: 6 })
      .toBuffer();
    const base = (tex.getName() || tex.getURI().replace(/^.*\//, '')).replace(/\.\w+$/, '').replace(/_\d+k$/, '');
    tex.setImage(new Uint8Array(image)).setMimeType('image/webp').setURI(`${base}.webp`).setName(base);
  }
}

function describe(doc, spec, bytes) {
  const docRoot = doc.getRoot(), scene = docRoot.listScenes()[0];
  const b = getBounds(scene), r3 = (v) => v.map((n) => Math.round(n * 1000) / 1000);
  let triangles = 0;
  const parts = [];
  for (const node of docRoot.listNodes()) {
    const mesh = node.getMesh();
    if (!mesh) continue;
    const t = mesh.listPrimitives().reduce((s, p) => s + (p.getIndices()?.getCount() ?? p.getAttribute('POSITION').getCount()) / 3, 0);
    triangles += t;
    const nb = getBounds(node);
    parts.push({ node: node.getName(), triangles: t, material: mesh.listPrimitives()[0].getMaterial()?.getName(), min: r3(nb.min), max: r3(nb.max) });
  }
  const hex = (c) => '#' + c.slice(0, 3).map((v) => Math.round(255 * (v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055)).toString(16).padStart(2, '0')).join('');
  const texInfo = (t) => t && { image: t.getURI(), format: t.getMimeType(), size: t.getSize()?.join('×'), kb: Math.round(t.getImage().byteLength / 1024) };
  return {
    name: spec.info.name,
    file: 'model.glb',
    bytes,
    source: spec.info.source,
    units: 'metres, Y up, origin at the centre of the pot\'s base (on the floor)',
    triangles,
    size: { width: r3([b.max[0] - b.min[0]])[0], depth: r3([b.max[2] - b.min[2]])[0], height: r3([b.max[1] - b.min[1]])[0], note: 'W = x, D = z, H = y, metres' },
    bounds: { min: r3(b.min), max: r3(b.max) },
    footprint: (() => {
      const p = parts.find((q) => q.node === 'pot');
      return p && { width: r3([p.max[0] - p.min[0]])[0], depth: r3([p.max[2] - p.min[2]])[0], height: r3([p.max[1] - p.min[1]])[0], note: 'the pot alone (W = x, D = z)' };
    })(),
    parts,
    materials: docRoot.listMaterials().map((m) => ({
      name: m.getName(),
      role: spec.roles[m.getName()] ?? null,
      alphaMode: m.getAlphaMode(),
      ...(m.getAlphaMode() === 'MASK' ? { alphaCutoff: m.getAlphaCutoff(), alphaTexture: 'alpha channel of baseColorTexture' } : {}),
      doubleSided: m.getDoubleSided(),
      baseColorFactor: hex(m.getBaseColorFactor()),
      roughnessFactor: m.getRoughnessFactor(),
      metallicFactor: m.getMetallicFactor(),
      ...(m.getExtension('KHR_materials_specular') ? { specularFactor: m.getExtension('KHR_materials_specular').getSpecularFactor() } : {}),
      three: m.listExtensions().length ? 'MeshPhysicalMaterial' : 'MeshStandardMaterial', // what GLTFLoader (r170) makes of it
      vertexColors: docRoot.listMeshes().some((mesh) => mesh.listPrimitives().some((p) => p.getMaterial() === m && p.getAttribute('COLOR_0'))),
      textures: Object.fromEntries(Object.entries({
        baseColor: texInfo(m.getBaseColorTexture()), normal: texInfo(m.getNormalTexture()),
        metallicRoughness: texInfo(m.getMetallicRoughnessTexture()), occlusion: texInfo(m.getOcclusionTexture()),
      }).filter(([, v]) => v)),
    })),
    pot: spec.info.pot,
    gltf: {
      extensionsRequired: docRoot.listExtensionsRequired().map((e) => e.extensionName),
      loader: 'GLTFLoader with setMeshoptDecoder(MeshoptDecoder) from three/addons/libs/meshopt_decoder.module.js; WebP textures and quantized geometry need nothing else in three r170',
    },
  };
}

// Poly Haven's Potted Plant 04 has one material for everything. Split it so the pot, soil and
// leaves can be told apart (and the pot tinted), use the ARM texture's AO too, and stand the
// pot's base on the origin.
function prepareHaworthia(doc) {
  const docRoot = doc.getRoot();
  const [base] = docRoot.listMaterials();
  const arm = base.getMetallicRoughnessTexture(); // R = AO, G = roughness, B = metalness
  arm.setName('potted_plant_04_arm'); // Poly Haven's glTF calls it "rough"
  base.setOcclusionTexture(arm);
  const mats = {
    leaves: base.setName('haworthia_leaves'),
    pot: base.clone().setName('haworthia_pot'),
    soil: base.clone().setName('haworthia_soil'),
  };
  const roles = { potted_plant_04_plant: ['leaves', 'leaves'], potted_plant_04_pot: ['pot', 'pot'], potted_plant_04_dirt: ['soil', 'soil'], potted_plant_04_ground: ['soil', 'gravel'] };
  const pot = docRoot.listNodes().find((n) => n.getName() === 'potted_plant_04_pot');
  const pb = getBounds(pot), shift = [-(pb.min[0] + pb.max[0]) / 2, -pb.min[1], -(pb.min[2] + pb.max[2]) / 2];
  const group = doc.createNode('zebra_haworthia').setTranslation(shift);
  const scene = docRoot.listScenes()[0];
  for (const node of docRoot.listNodes()) {
    const role = roles[node.getName()];
    if (!role) continue;
    for (const p of node.getMesh().listPrimitives()) p.setMaterial(mats[role[0]]);
    node.getMesh().setName(role[1]);
    node.setName(role[1]);
    scene.removeChild(node);
    group.addChild(node);
  }
  scene.addChild(group);
}
