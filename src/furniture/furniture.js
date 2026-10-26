import * as THREE from 'three';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';

// What can go in the room (products.json), what stands in it and where, and the presets
// (presets.json) are data in assets/catalog/; their schemas there and docs/catalog.md describe
// them. loadCatalog() reads both once and turns them into the shapes used below:
//   CATALOG  product id → spec: { maker, name, url, itemUrl, listed, footprint, finish, options,
//            source, model: { file, scale, parts }, variants }, with each part's `match` a RegExp
//   LAYOUT   the pieces: { id, label, item (product id), alternatives, present, optional, match,
//            movable, rotation, and one of place / attach / around }
//   PRESETS  [{ id, name, summary, note, pieces: { piece or product id: { item, present, choices, place } } }]
const CATALOG_FILES = { products: 'assets/catalog/products.json', presets: 'assets/catalog/presets.json' };
let CATALOG = {}, LAYOUT = [], PRESETS = [], PALETTE = [], DEFAULT_PRESET = null, signature = '';

async function loadCatalog() {
  const get = (path) => fetch(path).then((r) => (r.ok ? r.json() : Promise.reject(new Error(`${path}: ${r.status}`))));
  const [{ products, partSets = {} }, room] = await Promise.all([get(CATALOG_FILES.products), get(CATALOG_FILES.presets)]);
  const partsOf = (parts) => (typeof parts === 'string' ? partSets[parts] : parts)?.map((part) => ({ ...part, match: new RegExp(part.match) }));
  const modelOf = (m, base) => ({ file: m.file, scale: m.scale ?? base?.scale ?? 1, parts: partsOf(m.parts) ?? base?.parts ?? null });
  CATALOG = Object.fromEntries(Object.entries(products).map(([id, p]) => {
    const model = modelOf(p.model);
    const variants = p.model.variants && Object.fromEntries(Object.entries(p.model.variants).map(([v, m]) => [v, modelOf(m, model)]));
    return [id, { ...p, listed: p.size, model, variants }];
  }));
  // Inside, a piece's rule names the piece it refers to `id` (the file says `to`).
  const ruleOf = (r) => r && (({ to, rotation, hostWindow, ...rest }) => ({ id: to, ...rest, ...(hostWindow != null && { hostZ0: hostWindow }) }))(r);
  LAYOUT = room.pieces.map(({ product, place, attach, around, ...piece }) => ({
    ...piece, item: product, rotation: (place ?? attach ?? around).rotation,
    ...(place && { place }), ...(attach && { attach: ruleOf(attach) }), ...(around && { around: ruleOf(around) }),
  }));
  PRESETS = room.presets.map((preset) => ({
    ...preset,
    pieces: Object.fromEntries(Object.entries(preset.pieces).map(([k, { product, ...e }]) => [k, { ...e, ...(product && { item: product }) }])),
  }));
  PALETTE = room.palette ?? [];
  DEFAULT_PRESET = room.default;
  signature = JSON.stringify(room.pieces);
}

const WALL_GAP = 0.02; // pieces stop 2 cm short of a wall (clear of the baseboard)
const SNAP = 0.06; // and snap to that when dragged within 6 cm of it
const ACCENT = 0xf2c12e; // the UI's accent (the cat poster's yellow)
const STORE = 'living-room.layout';
const STORE_FINISH = 'living-room.finishes'; // kept apart, so a new default layout doesn't undo finishes

export class Furniture {
  // onChange(what): what === 'light' when only materials changed (a finish), so shadows can stay;
  // otherwise something moved or changed shape. anisotropy: texture filtering (the quality level).
  constructor(R, renderer, onChange, { anisotropy } = {}) {
    this.W = R.width;
    this.L = R.length;
    this.door = R.balconyDoor; // its swing must stay clear when a piece is placed for you
    this.onChange = onChange;
    this.aniso = Math.min(anisotropy ?? Infinity, renderer.capabilities.getMaxAnisotropy());
    this.group = new THREE.Group();
    this.group.name = 'furniture';
    this.items = [];
    this.presets = []; // filled by load()
    this.selected = null;
    this.hovered = null;
    this.editing = false;
    this.clearance = clearanceHelper();
    this.group.add(this.clearance.group);
    // The info card that follows the selected piece. main.js fills `popup.card`; this keeps
    // it next to the piece on screen. `popupBounds()` gives the free band between the UI panels.
    this.popupBounds = null;
    this.popup = infoPopup(this);
    this.overlay = new THREE.Group();
    this.overlay.name = 'info card';
    this.overlay.add(this.popup.object);
  }

  // preset: the one a link names (#preset=…). A first visit starts as that one, or the default
  // preset: its products are loaded straight away, then it puts on its finishes and places.
  // Otherwise the room is as the viewer left it (the editor then applies a linked preset).
  async load({ preset = null } = {}) {
    await loadCatalog();
    this.presets = PRESETS;
    this.defaultPreset = DEFAULT_PRESET;
    const saved = readSaved();
    const finishes = readFinishes();
    const fresh = !Object.keys(finishes).length && !Object.keys(saved).length;
    const start = fresh ? PRESETS.find((p) => p.id === preset) ?? PRESETS.find((p) => p.id === DEFAULT_PRESET) : null;
    const loaded = await Promise.all(LAYOUT.map(async (entry) => {
      const kept = finishes[entry.id] ?? (start ? { product: this.presetFor(start, { id: entry.id, home: entry })?.item } : {});
      const key = CATALOG[kept.product] && (entry.alternatives ?? [entry.item]).includes(kept.product) ? kept.product : entry.item;
      const options = await loadOptions(CATALOG[key].options);
      const pivot = new THREE.Group();
      pivot.name = entry.id;
      this.group.add(pivot);
      const item = {
        id: entry.id, key, spec: CATALOG[key], pivot, home: entry, options, choices: normalise(options, kept.choices),
        present: kept.present ?? entry.present ?? true, matching: kept.match ?? !!entry.match,
        x: 0, z: 0, rotation: 0, box: new THREE.Box3(), outline: null,
      };
      await this.loadInto(item, key, variantOf(options, item.choices));
      pivot.visible = item.present;
      const at = entry.movable === false ? null : saved[entry.id];
      if (at) this.place(item, at.x, at.z, at.rotation);
      else this.placeHome(item);
      await this.paintAll(item);
      return item;
    }));
    this.items.push(...loaded);
    // Pieces placed by another (the pouf by the sofa, which makes room for it; chairs around the
    // table) go there once all are known. LAYOUT lists each piece after the one it depends on.
    for (const item of this.items) if (!saved[item.id]) this.placeHome(item);
    if (start) await this.applyPreset(start.id);
    this.warnOverlaps();
    this.onChange();
  }

  // The default layout must not put pieces into each other (chairs tucked under their own table
  // excepted). Room measurements change, so this is checked on every load; the smoke test
  // fails on the warning.
  warnOverlaps() {
    const present = this.items.filter((i) => i.present && !i.y); // not what stands on the sill
    for (let a = 0; a < present.length; a++) {
      for (let b = a + 1; b < present.length; b++) {
        const p = present[a], q = present[b];
        if (p.home.around?.id === q.id || q.home.around?.id === p.id) continue;
        const f = this.footprint(p), g = this.footprint(q);
        const ox = Math.min(f.x1, g.x1) - Math.max(f.x0, g.x0), oz = Math.min(f.z1, g.z1) - Math.max(f.z0, g.z0);
        if (ox > 0.01 && oz > 0.01) console.warn(`furniture: ${p.id} and ${q.id} overlap by ${(ox * 100).toFixed(0)} × ${(oz * 100).toFixed(0)} cm`);
      }
    }
  }

  // Footprint on the floor, accounting for quarter turns; where it stands now, or `at` { x, z, rotation }.
  // A product's `footprint` (a plant's pot) stands in for its whole model when that's smaller.
  footprint(item, at = item) {
    const turned = ((at.rotation % 180) + 180) % 180 === 90;
    const w = item.spec.footprint?.width ?? item.size.x, d = item.spec.footprint?.depth ?? item.size.z;
    const hx = (turned ? d : w) / 2, hz = (turned ? w : d) / 2;
    return { x0: at.x - hx, x1: at.x + hx, z0: at.z - hz, z1: at.z + hz, hx, hz };
  }

  // How far a piece reaches into the room (its largest x) between z0 and z1, from its geometry
  // rather than its footprint box: the In Situ's door-side seat ends 60 cm short of its chaise.
  // -Infinity if no part of it is there.
  reach(item, z0, z1) {
    const m = new THREE.Matrix4(), v = new THREE.Vector3();
    item.pivot.updateMatrix();
    item.object.updateMatrix();
    let x = -Infinity;
    for (const mesh of item.meshes) {
      m.multiplyMatrices(item.pivot.matrix, item.object.matrix).multiply(mesh.matrix);
      const pos = mesh.geometry.getAttribute('position');
      for (let i = 0; i < pos.count; i++) {
        v.fromBufferAttribute(pos, i).applyMatrix4(m);
        if (v.z > z0 && v.z < z1 && v.x > x) x = v.x;
      }
    }
    return x;
  }

  // y: what it stands on (0, the floor; the sill's height for the plant there). A piece that
  // isn't `movable` (on the sill, outside the room's walls) isn't kept inside them.
  place(item, x, z, rotation = item.rotation, { snap = true, y = item.y ?? 0 } = {}) {
    item.rotation = ((Math.round(rotation / 90) * 90) % 360 + 360) % 360;
    const { hx, hz } = this.footprint(item);
    const free = item.home.movable === false;
    item.x = free ? x : fit(x, hx, this.W, snap);
    item.z = free ? z : fit(z, hz, this.L, snap);
    item.y = y;
    item.pivot.position.set(item.x, item.y, item.z);
    item.pivot.rotation.y = THREE.MathUtils.degToRad(item.rotation);
    // Its box (picking, the info card) is the whole model: a plant's crown reaches past its pot.
    turnedBox(item.local, item.rotation, item.box).translate(item.pivot.position);
    if (item === this.selected) {
      this.clearance.update(this.footprint(item), this.W, this.L);
      this.anchorPopup(item);
    }
    this.onChange();
  }

  // Where a `place` puts a piece: distances from its footprint to the walls (left / right,
  // window / door), or its centre (x, z), turned `rotation`, standing at height y.
  spotOf(item, p) {
    const { hx, hz } = this.footprint(item, { x: 0, z: 0, rotation: p.rotation });
    const x = p.left != null ? p.left + hx : p.right != null ? this.W - p.right - hx : p.x;
    const z = p.window != null ? p.window + hz : p.door != null ? this.L - p.door - hz : p.z;
    return { x, z, rotation: p.rotation, y: p.y ?? 0 };
  }

  placeAt(item, p) {
    const at = this.spotOf(item, p);
    this.place(item, at.x, at.z, at.rotation, { snap: false, y: at.y });
  }

  // Where a piece goes by itself (presets.json `pieces`): its `place`, the sofa's window end moved
  // along for a piece that needs the room (the pouf's `hostZ0`); for one that `attach`es to
  // another, in front of that one's window end (the pouf) or of its door-side seat (`end: 'door'`,
  // the coffee table); for one `around` another (the chairs), at an offset from it.
  // Returns { x, z, rotation, y } without placing it.
  homeOf(item) {
    const h = item.home, rotation = h.rotation;
    const { hx, hz } = this.footprint(item, { x: 0, z: 0, rotation });
    const at = (x, z) => ({ x: fit(x, hx, this.W, false), z: fit(z, hz, this.L, false), rotation, y: 0 });
    const to = this.hostOf(item);
    if (to && h.attach.end === 'door') {
      const f = this.footprint(to), a = h.attach;
      let z0 = f.z1 - a.seat - hz;
      // `front` clear of a piece at the host's window end too (the pouf, where it goes).
      for (const o of this.items) {
        if (o !== item && o.present && this.hostOf(o) === to && o.home.attach.end !== 'door') z0 = Math.max(z0, this.footprint(o, this.homeOf(o)).z1 + a.front);
      }
      // `front` off the seat there, and outside the host's footprint (past a chaise).
      const x0 = Math.max(this.reach(to, z0, z0 + 2 * hz) + a.front, f.x1 + a.clear);
      return at(x0 + hx, z0 + hz);
    }
    if (to) {
      const f = this.footprint(to), a = h.attach;
      const x0 = f.x1 + a.front;
      let z0 = f.z0 - a.past;
      // In front of a deep sofa (In Situ's chaise) it would land in the balcony door's swing: move it along.
      const d = this.door;
      if (d && x0 + 2 * hx > d.offset && z0 < d.width) z0 = Math.max(z0, d.width + 0.05);
      return at(x0 + hx, z0 + hz);
    }
    const around = h.around && this.items.find((i) => i.id === h.around.id);
    if (around) return at(around.x + h.around.dx, around.z + h.around.dz);
    // Placed by a piece that hasn't loaded yet: anywhere for now, load() places it again after.
    if (!h.place) return at(this.W / 2, this.L / 2);
    // Its own place; the window end moved along for a piece that needs the room there (the pouf's `hostZ0`).
    const guest = this.items.find((i) => i.present && this.hostOf(i) === item && i.home.attach.hostZ0 != null);
    const spot = this.spotOf(item, guest ? { ...h.place, window: guest.home.attach.hostZ0, door: undefined, z: undefined } : h.place);
    return h.movable === false ? spot : { ...at(spot.x, spot.z), y: spot.y };
  }

  placeHome(item) {
    const { x, z, rotation, y } = this.homeOf(item);
    this.place(item, x, z, rotation, { snap: false, y });
  }

  // The piece this one stands by (the sofa, for the pouf), if any.
  hostOf(item) {
    return item.home.attach ? this.items.find((i) => i.id === item.home.attach.id) : null;
  }

  atHome(item) {
    const h = this.homeOf(item);
    return Math.abs(h.x - item.x) < 0.005 && Math.abs(h.z - item.z) < 0.005 && h.rotation === item.rotation;
  }

  rotate(item, by = 90) {
    this.place(item, item.x, item.z, item.rotation + by);
    this.save();
  }

  // Back to where src/furniture.js places it. The finish is kept; see resetOptions().
  reset(item) {
    this.placeHome(item);
    this.save();
  }

  // Selected: a crisp outline (and, while editing, its footprint and wall distances). It can
  // also be one of the room's fittings (fixtures.js: `kind: 'fixture'`), which gets the outline
  // and the info card.
  select(item) {
    if (this.selected === item) return;
    const was = this.selected;
    this.selected = item;
    if (was) this.outlineState(was);
    // Wall distances only for what stands on the floor and can be moved.
    const piece = item && item.kind !== 'fixture' && item.home.movable !== false;
    if (item) {
      this.outlineState(item);
      if (piece) this.clearance.update(this.footprint(item), this.W, this.L);
      this.anchorPopup(item);
    }
    this.clearance.group.visible = !!piece && this.editing;
    // Nothing that casts a shadow changed, so main.js only needs to redraw (selectItem does).
  }

  // The info card hangs above the middle of the selection's box.
  anchorPopup(item) {
    if (item.kind === 'fixture') item.updateBox();
    const b = item.box;
    this.popup.object.position.set((b.min.x + b.max.x) / 2, b.max.y, (b.min.z + b.max.z) / 2);
  }

  // A lighter outline under the mouse while editing. Doesn't touch the shadows, so main.js
  // only needs to redraw.
  hover(item) {
    if (this.hovered === item) return;
    const was = this.hovered;
    this.hovered = item;
    if (was) this.outlineState(was);
    if (item) this.outlineState(item);
  }

  setEditing(on) {
    this.editing = on;
    if (!on) this.hover(null);
    const s = this.selected;
    this.clearance.group.visible = !!s && s.kind !== 'fixture' && s.home.movable !== false && on;
  }

  outlineState(item) {
    const state = item === this.selected ? 'selected' : item === this.hovered && this.editing ? 'hover' : null;
    if ((!state && !item.outline) || item.noOutline) return;
    item.outline ??= buildOutline(item.meshes);
    for (const { mask, rim, line } of item.outline) {
      mask.visible = !!state;
      if (rim) rim.visible = state === 'selected';
      if (line) {
        line.visible = !!state;
        line.material = state === 'hover' ? OUTLINE.hover : OUTLINE.line;
      }
    }
  }

  // The nearest piece under the ray as { item, point }, testing the cheap bounding box before the mesh.
  pick(raycaster) {
    let best = null;
    for (const item of this.items) {
      if (!item.present || !raycaster.ray.intersectsBox(item.box)) continue;
      const hit = raycaster.intersectObject(item.pivot, true)[0];
      if (hit && hit.distance < (best?.distance ?? Infinity)) best = { item, point: hit.point, distance: hit.distance };
    }
    return best;
  }

  // Footprints the walker can't pass through.
  obstacles() {
    return this.group.visible ? this.items.filter((i) => i.present && !i.y).map((i) => this.footprint(i)) : [];
  }

  // ---- Which pieces, which models ------------------------------------------------

  // Optional pieces (the pouf, the coffee table) can be taken out of the room and put back.
  // The piece it stands by (the sofa) makes room for it, or takes the room back, unless that
  // one has been moved by hand; the host's other pieces (the coffee table) move along with it,
  // unless they have been.
  setPresent(item, on, { save = true } = {}) {
    if (item.present === on) return;
    const host = this.hostOf(item);
    const hostAtHome = host?.present && this.atHome(host);
    const along = host ? this.items.filter((o) => o !== item && o.present && this.hostOf(o) === host && this.atHome(o)) : [];
    item.present = on;
    item.pivot.visible = on;
    if (hostAtHome) this.placeHome(host);
    if (on) this.placeHome(item);
    for (const o of along) this.placeHome(o);
    if (save) this.save();
    this.onChange();
  }

  // Swap a piece for another product it can be (the sofa: In Situ or Outline), keeping it in
  // the same corner. `choices` start from that product's defaults.
  async setProduct(item, key, choices = {}, { save = true } = {}) {
    if (!CATALOG[key]) return;
    const options = await loadOptions(CATALOG[key].options);
    item.options = options;
    item.choices = normalise(options, choices);
    await this.reshape(item, key, variantOf(options, item.choices));
    if (save) this.save();
    this.onChange();
  }

  alternatives(item) {
    return (item.home.alternatives ?? [item.key]).map((key) => ({ key, spec: CATALOG[key] }));
  }

  // Load a model (product + variant, e.g. Outline on castors) into the piece, without placing it.
  async loadInto(item, key, variant = 'standard') {
    const spec = CATALOG[key];
    const def = variant !== 'standard' && spec.variants?.[variant] ? spec.variants[variant] : spec.model;
    const model = await loadModel(`${key}#${def === spec.model ? 'standard' : variant}`, def, this.aniso, !!spec.footprint);
    if (item.object) item.pivot.remove(item.object);
    item.pivot.add(model.object);
    Object.assign(item, {
      key, spec, variant: def === spec.model ? 'standard' : variant, object: model.object, size: model.size, local: model.local,
      meshes: model.meshes, partDefs: model.partDefs, materials: model.materials, parts: indexParts(model.meshes, model.partDefs), outline: null,
    });
  }

  // A new model for a placed piece: same corner (its back stays on the wall, the 15 cm stays),
  // or its own place if it was there (a bigger coffee table stays centred on its seat); pieces that
  // stood against its far side move with it, and the finish goes back on. A piece at its door end
  // (the coffee table) goes to its new place there, or moves with that end if it was moved by hand.
  async reshape(item, key, variant) {
    const before = this.footprint(item);
    const wasHome = this.atHome(item);
    const doorEnd = this.items.filter((o) => o !== item && o.present && this.hostOf(o) === item && o.home.attach.end === 'door');
    const doorEndHome = doorEnd.filter((o) => this.atHome(o));
    await this.loadInto(item, key, variant);
    const { hx, hz } = this.footprint(item);
    if (wasHome) this.placeHome(item);
    else this.place(item, before.x0 + hx, before.z0 + hz, item.rotation, { snap: false });
    const after = this.footprint(item);
    for (const o of doorEnd) {
      if (doorEndHome.includes(o)) this.placeHome(o);
      else this.place(o, o.x + after.x1 - before.x1, o.z + after.z1 - before.z1, o.rotation, { snap: false });
    }
    for (const o of this.items) {
      if (o === item || !o.present || doorEnd.includes(o)) continue;
      const f = this.footprint(o);
      const besideZ = f.z0 < before.z1 && f.z1 > before.z0, besideX = f.x0 < before.x1 && f.x1 > before.x0;
      const front = this.hostOf(o) === item || (besideZ && Math.abs(f.x0 - before.x1) < 0.03); // the pouf, or a piece against it
      const dx = front ? after.x1 - before.x1 : 0;
      const dz = besideX && Math.abs(f.z0 - before.z1) < 0.03 ? after.z1 - before.z1 : 0;
      if (dx || dz) this.place(o, o.x + dx, o.z + dz, o.rotation, { snap: false });
    }
    await this.paintAll(item);
    if (item === this.selected || item === this.hovered) this.outlineState(item);
  }

  // ---- Finishes ---------------------------------------------------------------
  // item.choices maps each option group to the chosen option id, e.g. { upholstery: 'CD12', frame: '01' }.

  // The option groups of a piece (with `choice`, the chosen option), or [] if it has none.
  optionGroups(item) {
    return (item.options?.groups ?? []).map((g) => ({ ...g, choice: g.byId.get(item.choices[g.id]) ?? g.byId.get(g.default) }));
  }

  // Choose one finish. Resolves once the new material (and its texture, or model) is on the piece.
  // A piece that `match`es this one (the pouf the sofa) follows, unless it's been given its own.
  async setOption(item, groupId, optionId, { save = true, follow = true } = {}) {
    const group = item.options?.groups.find((g) => g.id === groupId);
    const option = group?.byId.get(optionId);
    if (!option) return;
    item.choices[groupId] = optionId;
    if (save) this.save();
    const followers = follow ? this.items.filter((o) => o.home.match === item.id && o.matching) : [];
    await Promise.all([
      option.model && option.model !== item.variant ? this.reshape(item, item.key, option.model) : this.paint(item, group, option),
      ...followers.map((o) => o.options?.groups.find((g) => g.id === groupId)?.byId.has(optionId) && this.setOption(o, groupId, optionId, { save: false, follow: false })),
    ]);
    if (save && followers.length) this.save();
    this.onChange('light'); // a new model (castors) has already said so when it was placed
  }

  // Put one group's chosen material on the piece's parts.
  async paint(item, group, option) {
    const assigned = await Promise.all(group.parts.map(async (partId) => {
      const spec = materialSpec(group, option, partId);
      const part = item.parts[partId];
      if (!spec || !part) return null;
      return { part, material: await optionMaterial(item.key, partId, group.id, option.id, spec, part.def, item.options.dir, this.aniso) };
    }));
    // A quicker later choice (or another model) wins over this one.
    if (item.choices[group.id] !== option.id) return;
    for (const a of assigned) {
      if (!a || !item.meshes.includes(a.part.meshes[0])) continue;
      for (const mesh of a.part.meshes) mesh.material = a.material;
    }
    item.materials = [...new Set(item.meshes.map((m) => m.material))];
  }

  async paintAll(item) {
    if (!item.options) return;
    await Promise.all(this.optionGroups(item).map((g) => g.choice && this.paint(item, g, g.choice)));
    this.onChange('light');
  }

  // Texture filtering for every texture the pieces use, now and later (the quality level).
  setAnisotropy(n) {
    this.aniso = n;
    for (const map of madeMaps) {
      if (map.anisotropy === n) continue;
      map.anisotropy = n;
      map.needsUpdate = true;
    }
  }

  // Apply a whole set of choices; anything missing or unknown falls back to the default.
  async setChoices(item, choices = {}, { save = true } = {}) {
    if (!item.options) return;
    item.choices = normalise(item.options, choices);
    const variant = variantOf(item.options, item.choices);
    if (variant !== item.variant) await this.reshape(item, item.key, variant);
    else await this.paintAll(item);
    for (const o of this.items.filter((o) => o.home.match === item.id && o.matching)) await this.follow(o);
    if (save) this.save();
  }

  resetOptions(item) {
    return this.setChoices(item, {});
  }

  isDefault(item) {
    return (item.options?.groups ?? []).every((g) => item.choices[g.id] === g.default);
  }

  // The pouf follows the sofa's upholstery and base while `matching`; picking its own ends that.
  async setMatching(item, on) {
    item.matching = on;
    if (on) await this.follow(item);
    this.save();
  }

  async follow(item) {
    const to = this.items.find((i) => i.id === item.home.match);
    if (!to?.options || !item.options) return;
    const choices = { ...item.choices };
    for (const g of item.options.groups) if (g.byId.has(to.choices[g.id])) choices[g.id] = to.choices[g.id];
    if (JSON.stringify(choices) === JSON.stringify(item.choices)) return;
    item.choices = normalise(item.options, choices);
    const variant = variantOf(item.options, item.choices);
    if (variant !== item.variant) await this.reshape(item, item.key, variant);
    else await this.paintAll(item);
  }

  // Every piece of the same product, this one included (e.g. the four chairs).
  copies(item) {
    return this.items.filter((i) => i.key === item.key && i.present);
  }

  applyToCopies(item) {
    return Promise.all(this.copies(item).filter((i) => i !== item).map((i) => this.setChoices(i, { ...item.choices })));
  }

  // ---- Presets ------------------------------------------------------------------
  // A preset sets, for each piece it names (by LAYOUT id, or by product for all copies), the
  // product, whether it's in the room, and its finish. Unnamed pieces keep theirs.
  presetFor(preset, item) {
    return preset.pieces[item.id] ?? preset.pieces[item.home.item];
  }

  async applyPreset(id) {
    const preset = PRESETS.find((p) => p.id === id);
    if (!preset) return;
    // The sofa first: what follows or attaches to it needs its new size. Which pieces are in the
    // room comes before anything is placed, since the sofa's place depends on the pouf.
    const order = [...this.items].sort((a, b) => !!a.home.attach - !!b.home.attach || !!a.home.match - !!b.home.match);
    for (const item of order) {
      const p = this.presetFor(preset, item);
      if (p?.present != null) this.setPresent(item, p.present, { save: false });
    }
    for (const item of order) {
      const p = this.presetFor(preset, item);
      if (!p) continue;
      if (item.home.match) item.matching = !p.choices;
      if (p.item && p.item !== item.key) await this.setProduct(item, p.item, p.choices ?? {}, { save: false });
      else if (p.choices) await this.setChoices(item, p.choices, { save: false });
      else if (item.matching) await this.follow(item);
      if (item.present && p.place) this.placeAt(item, p.place);
      else if (item.present && (p.item || p.present)) this.placeHome(item);
    }
    this.save();
    this.onChange();
  }

  // The colours `pieces` (a preset's, or the room's own) are made of, from PALETTE: [{ color, name }].
  async paletteOf(pieces) {
    const colors = await Promise.all(PALETTE.map(async ([piece, groupId]) => {
      const home = LAYOUT.find((h) => h.id === piece || h.item === piece);
      const p = pieces[home.id] ?? pieces[home.item] ?? {};
      const group = (await loadOptions(CATALOG[p.item ?? home.item].options))?.groups.find((g) => g.id === groupId);
      const option = group?.byId.get(p.choices?.[groupId]) ?? group?.byId.get(group.default);
      return option && { color: option.color, name: option.name };
    }));
    return colors.filter(Boolean);
  }

  // The preset the room looks like right now, if any.
  currentPreset() {
    if (!this.items.length) return null; // not loaded yet
    return PRESETS.find((preset) => this.items.every((item) => {
      const p = this.presetFor(preset, item);
      if (!p) return true;
      if (p.present != null && p.present !== item.present) return false;
      if (!item.present) return true;
      if (p.item && p.item !== item.key) return false;
      const want = p.choices ?? (item.home.match ? null : {});
      if (!want) return true;
      return Object.entries(normalise(item.options, want)).every(([g, id]) => item.choices[g] === id);
    }))?.id ?? null;
  }

  // Everything undo needs to put a piece back.
  snapshot(item) {
    return { item, key: item.key, present: item.present, matching: item.matching, x: item.x, z: item.z, y: item.y, rotation: item.rotation, choices: { ...item.choices } };
  }

  async restore(s) {
    const { item } = s;
    item.matching = s.matching;
    if (s.key !== item.key) await this.setProduct(item, s.key, s.choices, { save: false });
    else await this.setChoices(item, s.choices, { save: false });
    this.setPresent(item, s.present, { save: false });
    this.place(item, s.x, s.z, s.rotation, { snap: false, y: s.y });
    this.save();
  }

  // ---- What it is -----------------------------------------------------------------

  // The swatch for an option as CSS: an atlas cell, or a flat colour. `px` is the drawn size.
  swatchStyle(item, group, option, px) {
    const fam = option.family ? group.familyById.get(option.family) : null;
    const atlas = fam?.atlas ?? group.atlas;
    if (atlas == null || option.cell == null) return { backgroundColor: option.color };
    const cols = fam?.cols ?? group.cols, rows = fam?.rows ?? group.rows;
    const x = (option.cell % cols) * px, y = Math.floor(option.cell / cols) * px;
    return {
      backgroundColor: option.color,
      backgroundImage: `url("${assetPath(item.options.dir, atlas)}")`,
      backgroundSize: `${cols * px}px ${rows * px}px`,
      backgroundPosition: `-${x}px -${y}px`,
    };
  }

  // What the info card and the edit panel show.
  describe(item) {
    const groups = this.optionGroups(item);
    const parts = groups.filter((g) => g.choice).map((g) => ({ group: g, option: g.choice, family: g.choice.family ? g.familyById.get(g.choice.family) : null }));
    let total = null, extra = 0, offered = true;
    for (const { group, option } of parts) {
      if (option.offered === false) offered = false;
      // A price can depend on another group's choice (the Soft Side Table's on its size).
      const price = group.priceBy && option.price != null && typeof option.price === 'object' ? option.price[item.choices[group.priceBy]] : option.price;
      if (group.price === 'total' && price != null) total = (total ?? 0) + price;
      else if (group.price === 'add' && price) extra += price;
    }
    const code = (id) => {
      const g = groups.find((x) => x.id === id);
      return g?.choice ? g.choice.code ?? g.choice.id : '';
    };
    const itemNumber = item.options?.item?.replace(/\{(\w+)\}/g, (_, id) => code(id)) ?? null;
    // This configuration's page in the maker's shop: {item} is the item number, {group} a group's code.
    const shop = item.spec.itemUrl && itemNumber ? item.spec.itemUrl.replace(/\{(\w+)\}/g, (_, id) => (id === 'item' ? itemNumber : code(id))) : null;
    // Groups that colour no part (a size) aren't part of the finish; the size line shows them.
    const finished = parts.filter(({ group }) => group.parts.length);
    const finish = finished.length
      ? finished.map(({ group, option }) => `${option.name}${group.suffix ? ' ' + group.suffix : ''}`).join(' · ')
      : item.spec.finish;
    const notes = parts.map(({ option }) => option.note).filter(Boolean);
    return {
      maker: item.spec.maker, name: item.spec.name, url: item.spec.url ?? item.spec.source?.url, shop, source: item.spec.source, label: item.home.label ?? item.spec.name,
      finish, parts, notes, size: { w: item.size.x, d: item.size.z, h: item.size.y },
      price: offered && total != null ? { amount: total + extra, currency: item.options.currency ?? 'EUR' } : null,
      offered, itemNumber, market: item.options?.market,
    };
  }

  save() {
    try {
      const items = Object.fromEntries(this.items.map((i) => [i.id, { x: i.x, z: i.z, rotation: i.rotation }]));
      localStorage.setItem(STORE, JSON.stringify({ signature, items }));
      // Per piece: another product, in or out of the room, the pouf no longer matching the sofa,
      // and only the finishes that differ from the default.
      const finishes = {};
      for (const i of this.items) {
        const s = {};
        if (i.key !== i.home.item) s.product = i.key;
        if (i.present !== (i.home.present ?? true)) s.present = i.present;
        if (i.home.match && !i.matching) s.match = false;
        const changed = (i.options?.groups ?? []).filter((g) => i.choices[g.id] && i.choices[g.id] !== g.default);
        if (changed.length) s.choices = Object.fromEntries(changed.map((g) => [g.id, i.choices[g.id]]));
        if (Object.keys(s).length) finishes[i.id] = s;
      }
      localStorage.setItem(STORE_FINISH, JSON.stringify(finishes));
    } catch {
      // Storage can be unavailable (private windows, previews); positions just won't persist.
    }
  }
}

// Valid choices for a product: the given ones where they exist, defaults for the rest.
function normalise(options, choices = {}) {
  if (!options) return {};
  return Object.fromEntries(options.groups.map((g) => [g.id, g.byId.has(choices?.[g.id]) ? choices[g.id] : g.default]));
}

// The model variant the choices call for (an option with `model`, e.g. the Outline castors).
function variantOf(options, choices) {
  for (const g of options?.groups ?? []) {
    const m = g.byId.get(choices[g.id])?.model;
    if (m) return m;
  }
  return 'standard';
}

// Keep a half-extent h inside [0, len] with the wall gap, snapping to the walls.
function fit(c, h, len, snap) {
  const lo = WALL_GAP + h, hi = len - WALL_GAP - h;
  if (lo > hi) return len / 2;
  if (snap && c - lo < SNAP) return lo;
  if (snap && hi - c < SNAP) return hi;
  return THREE.MathUtils.clamp(c, lo, hi);
}

function readSaved() {
  try {
    const s = JSON.parse(localStorage.getItem(STORE));
    // Ignore saved moves once the default layout in this file changes.
    return s?.signature === signature ? s.items : {};
  } catch {
    return {};
  }
}

// Finishes picked in the app, by layout id. Unknown options fall back to the default.
function readFinishes() {
  try {
    const all = JSON.parse(localStorage.getItem(STORE_FINISH)) ?? {};
    // Earlier versions stored just { group: option } per piece.
    for (const [id, f] of Object.entries(all)) {
      if (f && !('choices' in f || 'product' in f || 'present' in f || 'match' in f)) all[id] = { choices: f };
    }
    return all;
  } catch {
    return {};
  }
}

// ---- Models ------------------------------------------------------------------------

const textures = new THREE.TextureLoader();
const images = new Map(); // texture path → Promise<Texture>, so each image is fetched once
const madeMaps = new Set(); // every texture handed to a material (for setAnisotropy)
const templates = new Map(); // catalog key → Promise of the loaded model

// Each catalog piece is fetched and parsed once. Every copy in the layout is a clone that
// shares its geometry and textures; materials are swapped per copy when its finish changes.
async function loadModel(key, def, aniso, keepOrigin = false) {
  if (!templates.has(key)) templates.set(key, loadTemplate(def, aniso, keepOrigin));
  const t = await templates.get(key);
  const object = t.object.clone();
  const own = new Map(t.materials.map((m) => [m, m.clone()]));
  const meshes = [];
  object.traverse((o) => {
    if (!o.isMesh) return;
    o.material = own.get(o.material);
    meshes.push(o);
  });
  return { object, meshes, partDefs: t.partDefs, size: t.size.clone(), local: t.local.clone(), materials: [...own.values()] };
}

// OBJ files are split into the catalog's parts by group name, each with the part's material.
// GLB files (the plants) keep their own materials, unless parts are given; they need the
// meshopt decoder (their geometry is compressed).
const gltfLoader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
async function loadTemplate(def, aniso, keepOrigin) {
  const glb = def.file.endsWith('.glb');
  const parts = def.parts ?? [];
  const [object, materials] = await Promise.all([
    glb ? gltfLoader.loadAsync(def.file).then((g) => g.scene) : new OBJLoader().loadAsync(def.file),
    Promise.all(parts.map((p) => makeMaterial(p.material, aniso))),
  ]);
  const used = parts.map((p, i) => ({ ...p, id: p.id ?? `part${i}`, material: materials[i] }));
  const own = new Set();
  object.traverse((o) => {
    if (!o.isMesh) return;
    o.castShadow = o.receiveShadow = true;
    const part = used.find((p) => p.match.test(o.name)) ?? used[0];
    if (!part) {
      own.add(o.material); // the file's own material
      return;
    }
    o.material = part.material;
    o.userData.part = part.id; // only plain data here: clone() copies userData through JSON
    if (part.planarUV) planarUV(o.geometry, part.planarUV);
    if (part.boxUV) o.geometry = boxUV(o.geometry);
  });
  object.scale.multiplyScalar(def.scale);
  // Stand the piece on the floor, its footprint centred on the pivot (or, for a product with its
  // own `footprint`, the model's origin: a plant's pot, not the middle of its crown).
  object.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(object);
  const centre = keepOrigin ? new THREE.Vector3() : box.getCenter(new THREE.Vector3());
  object.position.set(-centre.x, -box.min.y, -centre.z);
  const local = box.clone().translate(object.position);
  const partDefs = Object.fromEntries(used.map(({ material, ...p }) => [p.id, p]));
  return { object, partDefs, size: box.getSize(new THREE.Vector3()), local, materials: [...used.map((p) => p.material), ...own] };
}

// A box in a piece's own space, turned a quarter turn `rotation` (degrees) about the vertical.
function turnedBox(local, rotation, out) {
  const { min, max } = local;
  const r = ((rotation % 360) + 360) % 360;
  const [x0, x1, z0, z1] =
    r === 90 ? [min.z, max.z, -max.x, -min.x] :
    r === 180 ? [-max.x, -min.x, -max.z, -min.z] :
    r === 270 ? [-max.z, -min.z, min.x, max.x] : [min.x, max.x, min.z, max.z];
  out.min.set(x0, min.y, z0);
  out.max.set(x1, max.y, z1);
  return out;
}

// Texture coordinates from the vertex positions (model units), e.g. 'zx' → u = z, v = x.
function planarUV(geometry, axes) {
  const pos = geometry.getAttribute('position');
  const [a, b] = [...axes].map((c) => 'xyz'.indexOf(c));
  const uv = new Float32Array(pos.count * 2);
  for (let i = 0; i < pos.count; i++) {
    uv[i * 2] = pos.getComponent(i, a);
    uv[i * 2 + 1] = pos.getComponent(i, b);
  }
  geometry.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
}

function indexParts(meshes, partDefs) {
  const parts = {};
  for (const m of meshes) {
    const id = m.userData.part;
    (parts[id] ??= { def: partDefs[id], meshes: [] }).meshes.push(m);
  }
  return parts;
}

// Texture coordinates by box projection, in model units: each triangle is mapped from the side
// it faces most. Gives fabric one true scale across every panel, whatever the file's own UVs.
function boxUV(geometry) {
  const g = geometry.index ? geometry.toNonIndexed() : geometry;
  const pos = g.getAttribute('position');
  const uv = new Float32Array(pos.count * 2);
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), n = new THREE.Vector3();
  for (let i = 0; i < pos.count; i += 3) {
    a.fromBufferAttribute(pos, i); b.fromBufferAttribute(pos, i + 1); c.fromBufferAttribute(pos, i + 2);
    n.subVectors(c, b).cross(a.clone().sub(b));
    const ax = Math.abs(n.x), ay = Math.abs(n.y), az = Math.abs(n.z);
    const [u, v] = ax >= ay && ax >= az ? ['z', 'y'] : ay >= az ? ['x', 'z'] : ['x', 'y'];
    for (let k = 0; k < 3; k++) {
      const p = [a, b, c][k];
      uv[(i + k) * 2] = p[u];
      uv[(i + k) * 2 + 1] = p[v];
    }
  }
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  return g;
}

// Paths in options.json are relative to it, unless they start at the site root (assets/...).
const assetPath = (dir, p) => (p.startsWith('assets/') ? p : dir + p);

// ---- Materials ---------------------------------------------------------------------

// A part's fallback material is one of:
//   { color, roughness, metalness }   a plain MeshStandardMaterial
//   { fabric: 'x.jpg', tileMm }       upholstery; the photo repeats every tileMm of texture
//                                     coordinates that are in millimetres
//   { texture: 'x.jpg', tile, rotate, roughness, ... }
//                                     e.g. wood; the photo repeats every `tile` units of the model's
//                                     own texture coordinates, turned `rotate` degrees (default 0)
// Waits for the image, so a piece never shows up untextured.
async function makeMaterial(def, aniso) {
  if (def.fabric) {
    const map = tiled(await loadMap(def.fabric, aniso), 1 / def.tileMm, 1 / def.tileMm, 0);
    return new THREE.MeshPhysicalMaterial({ map, roughness: 0.92, sheen: 0.6, sheenRoughness: 0.75, sheenColor: 0xffffff });
  }
  if (def.texture) {
    const { texture, tile, rotate = 0, ...rest } = def;
    return new THREE.MeshStandardMaterial({ ...rest, map: tiled(await loadMap(texture, aniso), 1 / tile, 1 / tile, rotate) });
  }
  return new THREE.MeshStandardMaterial(def);
}

// A copy of the (shared) image with its own repeat and rotation.
async function loadMap(path, aniso) {
  if (!images.has(path)) images.set(path, textures.loadAsync(path));
  const map = (await images.get(path)).clone();
  map.colorSpace = THREE.SRGBColorSpace;
  map.wrapS = map.wrapT = THREE.RepeatWrapping;
  map.anisotropy = aniso;
  map.needsUpdate = true;
  madeMaps.add(map);
  return map;
}

function tiled(map, ru, rv, rotateDeg) {
  map.repeat.set(ru, rv);
  map.rotation = THREE.MathUtils.degToRad(rotateDeg);
  return map;
}

// The material spec an option gives one part: per-part `materials`, one `material` for all
// parts, or its family's material in the option's own colour.
function materialSpec(group, option, partId) {
  if (option.materials) return option.materials[partId] ?? null;
  if (option.material) return option.material;
  const fam = option.family ? group.familyById.get(option.family) : null;
  return fam ? { ...fam.material, color: option.color } : { type: 'plain', color: option.color };
}

const optionMaterials = new Map(); // one material per product, part and option, shared by every copy
function optionMaterial(key, partId, groupId, optionId, spec, part, dir, aniso) {
  const id = `${key}|${partId}|${groupId}|${optionId}`;
  if (!optionMaterials.has(id)) optionMaterials.set(id, buildMaterial(spec, part ?? {}, dir, aniso));
  return optionMaterials.get(id);
}

const WHITE = new THREE.Color(1, 1, 1);

// How each kind of finish is drawn. Values come from Muuto's own AR materials where they
// publish them (roughness), the swatches (colour) and the product photos.
//   fabric    matte with a soft sheen at grazing angles; a weave texture at its real scale,
//             tinted to the swatch colour (the texture holds only the weave's light and dark)
//   leather   no sheen, a little more gloss, the grain as a texture
//   wood      the wood photo itself; lacquered oak is satin
//   plastic   Fiber's moulded shell: satin
//   linoleum  matte, flat colour
//   laminate  the Soft Side Table's tops: flat colour, matte (nanolaminate the most)
//   paint     powder-coated metal: a satin paint, not bare metal
//   metal     polished aluminium legs
//   felt      fully rough
async function buildMaterial(spec, part, dir, aniso) {
  let map = null;
  if (spec.map) {
    const [tu, tv] = spec.tile ?? [1, 1];
    const k = part.uvPerM ?? 1;
    map = tiled(await loadMap(assetPath(dir, spec.map), aniso), 1 / (tu * k), 1 / (tv * k), (spec.rotate ?? 0) + (part.rotate ?? 0));
  }
  const swatch = new THREE.Color(spec.color ?? '#ffffff');
  // A weave/grain texture averages `detail`; scale the colour so the result averages the swatch.
  const color = map && spec.detail ? swatch.clone().multiplyScalar(1 / spec.detail) : map ? WHITE.clone() : swatch.clone();
  const roughness = spec.roughness ?? 0.8;
  switch (spec.type) {
    case 'fabric':
      return new THREE.MeshPhysicalMaterial({
        color, map, roughness, sheen: 0.55, sheenRoughness: 0.7, sheenColor: swatch.clone().lerp(WHITE, 0.25),
      });
    case 'leather':
      return new THREE.MeshPhysicalMaterial({ color, map, roughness, specularIntensity: 0.6, clearcoat: 0.08, clearcoatRoughness: 0.5 });
    case 'plastic':
      return new THREE.MeshPhysicalMaterial({ color, roughness, specularIntensity: 0.55, sheen: 0.15, sheenRoughness: 0.5, sheenColor: WHITE });
    case 'paint':
      return new THREE.MeshStandardMaterial({ color, roughness, metalness: 0.1 });
    case 'metal': // polished aluminium
      return new THREE.MeshStandardMaterial({ color, roughness, metalness: 1 });
    default: // wood, linoleum, laminate, felt, plain
      return new THREE.MeshStandardMaterial({ color, map, roughness, metalness: 0 });
  }
}

// ---- Finish options --------------------------------------------------------------------
// options.json (made from Muuto's configurator, see README) looks like:
//   { product, item: 'IS2SC7{upholstery}{frame}', market, fetched, sources,
//     groups: [{ id, label, suffix?, parts: [part ids], default, price?: 'total' | 'add',
//                priceBy?,                                  // another group's id, see `price`
//                atlas?, cols?, rows?,                      // swatch sprite sheet (64 px cells)
//                families?: [{ id, name, kind, price, atlas, cols, rows, material }],
//                options: [{ id, name, color, cell?, price?, family?, material? | materials?,
//                            model?, approx?, offered?, note? }] }] }
// `price` is a number, or with `priceBy` one per option of that group (the Soft Side Table's top:
// { '41R1': 425, '48R1': 495, ... } by size). `model` switches to a CATALOG `variants` model (or
// 'standard'). A group with no `parts` (a size) only picks the model and isn't named in the finish.
// A material is { type, color?, map?, tile: [u, v] metres, rotate?, roughness, detail? };
// paths are relative to the JSON file.
const optionFiles = new Map();
function loadOptions(path) {
  if (!path) return Promise.resolve(null);
  if (!optionFiles.has(path)) {
    optionFiles.set(path, fetch(path)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`${path}: ${r.status}`))))
      .then((data) => {
        data.dir = path.replace(/[^/]*$/, '');
        for (const g of data.groups) {
          g.byId = new Map(g.options.map((o) => [o.id, o]));
          g.familyById = new Map((g.families ?? []).map((f) => [f.id, f]));
        }
        return data;
      })
      .catch((err) => {
        console.warn('Finish options unavailable, keeping the default look:', err);
        return null;
      }));
  }
  return optionFiles.get(path);
}

// ---- Selection outline -------------------------------------------------------------
// The selection's silhouette only, without lines between its own parts (the top and the stem
// of a table, the cushions of a sofa). Each mesh is drawn once more into the stencil buffer
// (`mask`), marking every pixel the piece covers; then an inverted hull of each mesh (a copy
// drawn from the back, pushed out along smoothed normals by a fixed number of screen pixels)
// is drawn only where nothing is marked, so just the ring around the whole piece is left.
// A dark rim under the accent line keeps it readable on the oak floor, white walls and in the
// evening light. No post-processing pass needed (main.js asks the renderer for a stencil buffer).
const outlineRes = new THREE.Vector2(1, 1);
const outlineUniforms = { resolution: { value: outlineRes }, dpr: { value: 1 } };
const STENCIL = { stencilWrite: true, stencilRef: 1, stencilFuncMask: 0xff, stencilWriteMask: 0xff };
function outlineMaterial(color, px, opacity) {
  return new THREE.ShaderMaterial({
    uniforms: { ...outlineUniforms, color: { value: new THREE.Color(color) }, opacity: { value: opacity }, px: { value: px } },
    vertexShader: /* glsl */ `
      uniform vec2 resolution;
      uniform float px, dpr;
      void main() {
        vec4 clip = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        vec2 dir = (projectionMatrix * vec4(normalize(normalMatrix * normal), 0.0)).xy;
        float len = length(dir);
        if (len > 1e-6) clip.xy += dir / len * (px * dpr * 2.0 / resolution) * clip.w;
        gl_Position = clip;
      }`,
    fragmentShader: /* glsl */ `
      uniform vec3 color;
      uniform float opacity;
      void main() {
        gl_FragColor = vec4(color, opacity);
        #include <colorspace_fragment>
      }`,
    side: THREE.BackSide,
    transparent: true,
    depthWrite: false,
    toneMapped: false,
    // Only outside the piece (where its mask left no mark).
    ...STENCIL,
    stencilFunc: THREE.NotEqualStencilFunc,
    stencilWriteMask: 0,
  });
}
const OUTLINE = {
  rim: outlineMaterial(0x16140f, 3.6, 0.85),
  line: outlineMaterial(ACCENT, 2.2, 1),
  hover: outlineMaterial(ACCENT, 1.6, 0.6),
};
// Marks the piece's pixels: invisible, in front of whatever hides it (so the ring never cuts
// through an occluded part), and with the same cut-out as leaves that use one.
const masks = new Map();
function maskMaterial(source) {
  const cut = source.alphaTest > 0 && source.map ? source : null;
  const key = cut ? source.uuid : 'solid';
  if (!masks.has(key)) {
    masks.set(key, new THREE.MeshBasicMaterial({
      colorWrite: false, depthWrite: false, depthTest: false, side: THREE.DoubleSide,
      map: cut?.map ?? null, alphaTest: cut?.alphaTest ?? 0,
      ...STENCIL, stencilFunc: THREE.AlwaysStencilFunc, stencilZPass: THREE.ReplaceStencilOp,
    }));
  }
  return masks.get(key);
}

const hulls = new WeakMap(); // shared by every copy of a model
function hullGeometry(geometry) {
  let hull = hulls.get(geometry);
  if (!hull) {
    // Plain floats first: the plants' GLB geometry is quantized (and interleaved), which
    // mergeVertices can't copy; reading through the attribute decodes it.
    const pos = geometry.getAttribute('position');
    const flat = new Float32Array(pos.count * 3);
    for (let i = 0; i < pos.count; i++) flat.set([pos.getX(i), pos.getY(i), pos.getZ(i)], i * 3);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(flat, 3));
    if (geometry.index) g.setIndex(geometry.index);
    hull = mergeVertices(g, 0.01); // weld the faces so the normals average and the hull has no cracks
    hull.computeVertexNormals();
    hulls.set(geometry, hull);
  }
  return hull;
}

function buildOutline(meshes) {
  const syncSize = (renderer) => {
    renderer.getDrawingBufferSize(outlineRes);
    outlineUniforms.dpr.value = renderer.getPixelRatio();
  };
  return meshes.map((mesh) => {
    const make = (geometry, material, order) => {
      const m = new THREE.Mesh(geometry, material);
      m.renderOrder = order;
      m.raycast = () => {}; // never picked
      m.visible = false;
      m.castShadow = m.receiveShadow = false;
      m.userData.outline = true;
      m.onBeforeRender = syncSize;
      mesh.add(m);
      return m;
    };
    // Cut-out leaves are masked with their cut-out, but get no hull of their own: it would
    // follow the card, not the leaf. The rest of the plant (pot, trunk) is outlined.
    const cutOut = mesh.material.alphaTest > 0;
    return {
      mask: make(mesh.geometry, maskMaterial(mesh.material), 9),
      rim: cutOut ? null : make(hullGeometry(mesh.geometry), OUTLINE.rim, 10),
      line: cutOut ? null : make(hullGeometry(mesh.geometry), OUTLINE.line, 11),
    };
  });
}

// ---- Info card -----------------------------------------------------------------------
// A CSS2D label anchored to the selected piece. After each frame it moves its card to just
// above the piece's outline on screen (below it if there's no room), inside the free band.
function infoPopup(furniture) {
  const element = document.createElement('div');
  element.className = 'sel-pop';
  const card = document.createElement('div');
  card.className = 'sel-pop-card';
  element.append(card);
  const object = new CSS2DObject(element);
  object.center.set(0, 0); // the element's corner sits on the anchor; the card is offset from there
  object.visible = false;
  const v = new THREE.Vector3();
  object.onAfterRender = (renderer, scene, camera) => {
    const item = furniture.selected;
    if (!item) return;
    if (item.kind === 'fixture') furniture.anchorPopup(item);
    const { width: W, height: H } = renderer.getSize();
    v.setFromMatrixPosition(object.matrixWorld).project(camera);
    const ax = (v.x + 1) / 2 * W, ay = (1 - v.y) / 2 * H;
    // The piece's box on screen.
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (let i = 0; i < 8; i++) {
      v.set(i & 1 ? item.box.max.x : item.box.min.x, i & 2 ? item.box.max.y : item.box.min.y, i & 4 ? item.box.max.z : item.box.min.z).project(camera);
      if (v.z > 1) continue; // behind the camera
      const sx = (v.x + 1) / 2 * W, sy = (1 - v.y) / 2 * H;
      x0 = Math.min(x0, sx); x1 = Math.max(x1, sx); y0 = Math.min(y0, sy); y1 = Math.max(y1, sy);
    }
    if (x0 === Infinity) { x0 = x1 = ax; y0 = y1 = ay; }
    const b = furniture.popupBounds?.() ?? {};
    const top = b.top ?? 8, bottom = b.bottom ?? H - 8, margin = 8, gap = 12;
    const cw = card.offsetWidth, ch = card.offsetHeight;
    // While editing the panel says the same; if the card can't fit beside it, it steps aside.
    card.style.visibility = furniture.editing && bottom - top < ch ? 'hidden' : '';
    let x = (x0 + x1) / 2 - cw / 2;
    let y = y0 - gap - ch;
    if (y < top) y = y1 + gap; // no room above: below the piece
    if (y + ch > bottom) y = Math.max(top, bottom - ch); // nor below: as close as fits
    x = THREE.MathUtils.clamp(x, margin, Math.max(margin, W - margin - cw));
    // Never on top of the room card or the looks: beside a panel if there's room (to the right of
    // one on the left, to the left of one on the right), else under it.
    for (const a of [].concat(b.avoid ?? [])) {
      if (!(a.height > 0 && x < a.right + margin && x + cw > a.left - margin && y < a.bottom + margin && y + ch > a.top - margin)) continue;
      const onLeft = a.left + a.width / 2 < W / 2;
      if (onLeft && a.right + 2 * margin + cw <= W - margin) x = a.right + margin;
      else if (!onLeft && a.left - 2 * margin - cw >= margin) x = a.left - margin - cw;
      else y = Math.min(Math.max(y, a.bottom + margin), Math.max(a.bottom + margin, bottom - ch));
    }
    card.style.transform = `translate(${Math.round(x - ax)}px, ${Math.round(y - ay)}px)`;
  };
  return { object, element, card };
}

// ---- Wall distances and footprint ----------------------------------------------------
// Lines from the selected piece to each wall, labelled with the clear distance, and its
// footprint tinted on the floor.
function clearanceHelper() {
  const group = new THREE.Group();
  group.visible = false;
  const lines = new THREE.LineSegments(
    new THREE.BufferGeometry(),
    new THREE.LineDashedMaterial({ color: 0x14100c, transparent: true, opacity: 0.8, dashSize: 0.06, gapSize: 0.04 }),
  );
  lines.frustumCulled = false;
  group.add(lines);
  const fill = new THREE.Mesh(
    new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2),
    new THREE.MeshBasicMaterial({ color: ACCENT, transparent: true, opacity: 0.2, depthWrite: false, toneMapped: false }),
  );
  const edge = new THREE.LineLoop(
    new THREE.BufferGeometry().setFromPoints([[-0.5, -0.5], [0.5, -0.5], [0.5, 0.5], [-0.5, 0.5]].map(([x, z]) => new THREE.Vector3(x, 0, z))),
    new THREE.LineBasicMaterial({ color: ACCENT, transparent: true, opacity: 0.9, toneMapped: false }),
  );
  for (const o of [fill, edge]) {
    o.raycast = () => {};
    o.renderOrder = 2;
    group.add(o);
  }
  const labels = Array.from({ length: 4 }, () => {
    const el = document.createElement('div');
    el.className = 'dim clearance';
    el.setAttribute('aria-hidden', 'true'); // bare numbers; the editor announces positions instead
    const obj = new CSS2DObject(el);
    group.add(obj);
    return obj;
  });

  return {
    group,
    update(f, W, L) {
      const y = 0.012, cx = (f.x0 + f.x1) / 2, cz = (f.z0 + f.z1) / 2;
      for (const o of [fill, edge]) {
        o.position.set(cx, 0.004, cz);
        o.scale.set(f.x1 - f.x0, 1, f.z1 - f.z0);
      }
      const runs = [
        [f.x0, cz, 0, cz, f.x0], // to the left wall
        [f.x1, cz, W, cz, W - f.x1], // right wall
        [cx, f.z0, cx, 0, f.z0], // window wall
        [cx, f.z1, cx, L, L - f.z1], // door wall
      ];
      // Always 8 points (4 segments) so the buffer keeps its size; a hidden run collapses to a point.
      const pts = [];
      runs.forEach(([ax, az, bx, bz, d], i) => {
        const show = d >= 0.05;
        labels[i].visible = show;
        pts.push(new THREE.Vector3(ax, y, az), show ? new THREE.Vector3(bx, y, bz) : new THREE.Vector3(ax, y, az));
        labels[i].position.set((ax + bx) / 2, y, (az + bz) / 2);
        labels[i].element.textContent = d.toFixed(2);
      });
      lines.geometry.setFromPoints(pts);
      lines.computeLineDistances();
    },
  };
}
