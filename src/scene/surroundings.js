import * as THREE from 'three';
import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import { seededRandom } from '../util.js';
import { noAreaLights } from '../lighting/shader-hooks.js';

// The flat's real neighbourhood, from swisstopo open data prepared by scripts/surroundings.py:
// terrain draped with the aerial photo, buildings with roofs, and trees found in the surface
// model. The data arrives in "site" coordinates (metres from the map pin; x east, y up, z south)
// and is placed so the room's window wall sits on the building's real garden facade.
//
// It's cut into tiles, so that three can leave out what a camera doesn't see: the sun's shadow
// camera (a narrow box from the room toward the sun) only draws the few tiles it crosses, each
// face of the light capture only its quarter of the view, and Walk only what's in front. One
// mesh per kind, as it was, has a bounding sphere 500 m across that every camera intersects.
// The terrain is drawn more coarsely with distance from the flat (each tile at one step, with a
// skirt hanging from its edges so tiles of different steps never show a crack between them).

// Height grid cells per terrain tile (2 m each), and tiles per side for buildings and trees.
const TERRAIN_TILE = 48;
const TILES = 4;
// detail ('high' / 'medium' / 'low', from the rendering quality): the terrain's grid step (×2 m)
// up to each distance from the flat, and the tree crowns' icosphere detail near the flat and
// further out.
// photo: the largest size of the aerial photo on the GPU (the file is 2048 px; at 1024 it takes
// 6 MB of GPU memory instead of 22).
const DETAIL = {
  high: { terrain: [[50, 1], [120, 2], [Infinity, 4]], crowns: [2, 1], photo: 4096 },
  medium: { terrain: [[50, 1], [120, 2], [Infinity, 4]], crowns: [2, 1], photo: 1024 },
  low: { terrain: [[50, 2], [120, 4], [Infinity, 8]], crowns: [1, 0], photo: 1024 },
};
const SKIRT = 3; // m

// options: anisotropy (the aerial photo's filtering), detail ('high', 'medium', 'low': DETAIL),
// onRequested() once all its downloads have started.
export async function loadSurroundings(R, { anisotropy: aniso = 1, detail = 'high', onRequested = () => {} } = {}, base = 'assets/surroundings/') {
  const get = async (file) => {
    const r = await fetch(base + file);
    if (!r.ok) throw new Error(`${file}: HTTP ${r.status}`);
    return r;
  };
  let site, downloads;
  try {
    site = await (await get('site.json')).json();
    downloads = Promise.all([
      get(site.buildings.file).then((r) => r.arrayBuffer()),
      get(site.terrain.file).then((r) => r.arrayBuffer()),
      new THREE.TextureLoader().loadAsync(base + site.ortho.file),
    ]);
  } finally {
    onRequested();
  }
  const [buildings, terrain, photo] = await downloads;
  photo.colorSpace = THREE.SRGBColorSpace;
  photo.anisotropy = aniso;
  const heights = new Float32Array(terrain);
  const photos = new Map([[photo.image.width, photo]]); // px → texture

  // Outdoors, the window and balcony-door area lights only cost time: they face into the room.
  const materials = {
    ground: noAreaLights(new THREE.MeshStandardMaterial({ map: photo, roughness: 1 })),
    // Walls and roofs in one material (vertex colours), so a tile is one draw. Faces in the
    // source data aren't consistently wound, so both sides are drawn.
    buildings: noAreaLights(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9, side: THREE.DoubleSide })),
    leaves: noAreaLights(new THREE.MeshStandardMaterial({ roughness: 0.9 })),
    bark: noAreaLights(new THREE.MeshStandardMaterial({ color: 0x5b4a3c, roughness: 1 })),
  };

  const inner = new THREE.Group(); // site coordinates
  const terrainGroup = new THREE.Group(), treeGroup = new THREE.Group();
  terrainGroup.name = 'terrain';
  treeGroup.name = 'trees';
  inner.add(terrainGroup, buildingTiles(site, buildings, materials.buildings), treeGroup);

  const toRoom = siteToRoom(R, site);
  const group = new THREE.Group();
  group.name = 'surroundings';
  group.matrixAutoUpdate = false;
  group.matrix.copy(toRoom);
  group.add(inner);

  let visible = false, casting = true;
  const meshes = () => {
    const out = [];
    group.traverse((o) => o.isMesh && out.push(o));
    return out;
  };
  const applyVisible = () => {
    for (const o of meshes()) {
      o.layers.set(1);
      if (visible) o.layers.enable(0);
    }
  };
  const applyCasting = () => {
    for (const o of meshes()) o.castShadow = casting && !!o.userData.casts;
  };

  // Terrain and trees at a level of detail; buildings are the same at every level.
  function build(level) {
    const d = DETAIL[level] ?? DETAIL.high;
    for (const g of [terrainGroup, treeGroup]) {
      for (const o of [...g.children]) {
        o.geometry.dispose();
        o.dispose?.();
        g.remove(o);
      }
    }
    // The aerial photo at the size the level allows (a smaller copy is drawn from the original).
    const size = Math.min(d.photo, photo.image.width);
    if (!photos.has(size)) {
      const canvas = Object.assign(document.createElement('canvas'), { width: size, height: size });
      canvas.getContext('2d').drawImage(photo.image, 0, 0, size, size);
      const t = new THREE.CanvasTexture(canvas);
      t.colorSpace = THREE.SRGBColorSpace;
      t.anisotropy = photo.anisotropy;
      photos.set(size, t);
    }
    const map = photos.get(size);
    if (materials.ground.map !== map) {
      materials.ground.map?.dispose(); // frees the GPU copy; the image stays, to upload again
      map.anisotropy = materials.ground.map?.anisotropy ?? map.anisotropy;
      materials.ground.map = map;
    }
    terrainGroup.add(...terrainTiles(site, heights, materials.ground, d.terrain));
    treeGroup.add(...treeTiles(site, materials, d.crowns));
    group.updateMatrixWorld(true);
    applyVisible();
    applyCasting();
  }
  let current = null;
  function setDetail(level) {
    if (level === current) return;
    current = level;
    build(level);
  }
  setDetail(detail);

  return {
    group,
    site,
    // Turns a direction given as compass azimuth/elevation (degrees) into room coordinates.
    direction(azimuth, elevation) {
      const a = THREE.MathUtils.degToRad(azimuth), e = THREE.MathUtils.degToRad(elevation);
      const d = new THREE.Vector3(Math.sin(a) * Math.cos(e), Math.sin(e), -Math.cos(a) * Math.cos(e));
      return d.transformDirection(toRoom);
    },
    // Show to the camera, or keep only as a shadow caster (layer 1 is rendered by the sun's shadow camera only).
    setVisible(on) {
      visible = on;
      applyVisible();
    },
    // How finely the terrain and trees are drawn, and the aerial photo's size (DETAIL).
    setDetail,
    // Shadow casting on or off (it only matters for the sun). Changes no shaders.
    setCasting(on) {
      casting = on;
      applyCasting();
    },
    // Triangles and meshes, for the performance notes.
    get stats() {
      let tris = 0, n = 0;
      for (const o of meshes()) {
        n++;
        const g = o.geometry, t = (g.index ? g.index.count : g.attributes.position.count) / 3;
        tris += t * (o.isInstancedMesh ? o.count : 1);
      }
      return { meshes: n, triangles: Math.round(tris) };
    },
  };
}

// Site → room: the window wall's outside face lies on the facade, level with the map pin
// (plus `alongFacade`), with the floor `floorAboveGround` above the garden. The room is kept
// on its own building's facade: the pin can sit right at the boundary with the next house.
function siteToRoom(R, site) {
  const b = THREE.MathUtils.degToRad(site.facade.bearing);
  const out = new THREE.Vector3(Math.sin(b), 0, -Math.cos(b)); // facade normal, pointing outside
  const up = new THREE.Vector3(0, 1, 0);
  const right = new THREE.Vector3(-out.z, 0, out.x); // room +x: to the right when facing the window
  const [e0, e1] = site.facade.extent ?? [-Infinity, Infinity];
  const lo = e0 + R.width / 2 + 0.3, hi = e1 - R.width / 2 - 0.3;
  const centre = lo <= hi ? THREE.MathUtils.clamp(R.site.alongFacade, lo, hi) : (e0 + e1) / 2;
  const origin = new THREE.Vector3(site.facade.x, site.facade.ground + R.site.floorAboveGround, site.facade.z)
    .addScaledVector(right, centre - R.width / 2)
    .addScaledVector(out, -R.wallThickness.north);
  return new THREE.Matrix4().makeBasis(right, up, out.clone().negate()).setPosition(origin).invert();
}

// The tile (0 … TILES-1 on each axis) of a point in site coordinates.
function tileOf(site, x, z) {
  const span = 2 * site.half, k = (v) => THREE.MathUtils.clamp(Math.floor(((v + site.half) / span) * TILES), 0, TILES - 1);
  return k(x) * TILES + k(z);
}

// The terrain as tiles of TERRAIN_TILE cells, each at the step its distance from the flat asks
// for (lods: [[distance, step], …], steps in grid cells), plus a skirt along its edges.
function terrainTiles(site, heights, material, lods) {
  const { cols, rows, step, x0, z0 } = site.terrain;
  const half = site.ortho.size / 2, fx = site.facade.x, fz = site.facade.z;
  const h = (i, j) => heights[THREE.MathUtils.clamp(j, 0, rows - 1) * cols + THREE.MathUtils.clamp(i, 0, cols - 1)];
  // Tile boundaries in grid lines; a last sliver joins the tile before it.
  const cuts = (n) => {
    const c = [];
    for (let k = 0; k < n - 1; k += TERRAIN_TILE) c.push(k);
    if (n - 1 - c[c.length - 1] < TERRAIN_TILE / 2 && c.length > 1) c.pop();
    c.push(n - 1);
    return c;
  };
  const ci = cuts(cols), cj = cuts(rows);
  const tiles = [];
  for (let a = 0; a + 1 < ci.length; a++) {
    for (let b = 0; b + 1 < cj.length; b++) {
      const i0 = ci[a], i1 = ci[a + 1], j0 = cj[b], j1 = cj[b + 1];
      // Distance from the flat to the nearest point of the tile.
      const dx = Math.max(x0 + i0 * step - fx, 0, fx - (x0 + i1 * step));
      const dz = Math.max(z0 + j0 * step - fz, 0, fz - (z0 + j1 * step));
      const f = lods.find(([d]) => Math.hypot(dx, dz) < d)[1];
      const lines = (s, e) => {
        const l = [];
        for (let k = s; k < e; k += f) l.push(k);
        l.push(e);
        return l;
      };
      const is = lines(i0, i1), js = lines(j0, j1), nx = is.length, nz = js.length;
      const pos = [], nrm = [], uv = [], index = [];
      const vertex = (i, j, y) => {
        const x = x0 + i * step, z = z0 + j * step;
        pos.push(x, y, z);
        // The normal from the full-resolution grid, so shading matches across steps and tiles.
        const n = new THREE.Vector3(h(i - 1, j) - h(i + 1, j), 2 * step, h(i, j - 1) - h(i, j + 1)).normalize();
        nrm.push(n.x, n.y, n.z);
        uv.push((x + half) / site.ortho.size, 1 - (z + half) / site.ortho.size);
        return pos.length / 3 - 1;
      };
      for (const j of js) for (const i of is) vertex(i, j, h(i, j));
      const at = (c, r) => r * nx + c;
      for (let r = 0; r + 1 < nz; r++) {
        for (let c = 0; c + 1 < nx; c++) {
          const p = at(c, r), q = at(c, r + 1), s = at(c + 1, r + 1), t = at(c + 1, r);
          index.push(p, q, t, q, s, t); // facing up
        }
      }
      // Skirts: each edge copied SKIRT lower, joined to it from both sides.
      const edge = (cells) => {
        let prev = null;
        for (const [c, r] of cells) {
          const top = at(c, r), low = vertex(is[c], js[r], h(is[c], js[r]) - SKIRT);
          if (prev) index.push(prev[0], prev[1], top, top, prev[1], low, prev[0], top, prev[1], top, low, prev[1]);
          prev = [top, low];
        }
      };
      edge(is.map((_, c) => [c, 0]));
      edge(is.map((_, c) => [c, nz - 1]));
      edge(js.map((_, r) => [0, r]));
      edge(js.map((_, r) => [nx - 1, r]));
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      geo.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
      geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
      geo.setIndex(index);
      geo.computeBoundingSphere();
      const mesh = new THREE.Mesh(geo, material);
      mesh.name = `terrain ${a},${b} (step ${f * step} m)`;
      tiles.push(mesh);
    }
  }
  return tiles;
}

// Buildings: the walls and roofs (triangle soups) sorted into tiles by each triangle's middle,
// one mesh per tile with the roof colour as vertex colour.
function buildingTiles(site, buffer, material) {
  const all = new Float32Array(buffer);
  const wallEnd = site.buildings.walls, end = wallEnd + site.buildings.roofs;
  const colours = { wall: new THREE.Color(0xe9e4da), roof: new THREE.Color(0x8d7f77) }; // linear, like a material colour
  const bins = Array.from({ length: TILES * TILES }, () => ({ pos: [], col: [] }));
  for (let k = 0; k < end; k += 9) {
    const cx = (all[k] + all[k + 3] + all[k + 6]) / 3, cz = (all[k + 2] + all[k + 5] + all[k + 8]) / 3;
    const bin = bins[tileOf(site, cx, cz)], c = k < wallEnd ? colours.wall : colours.roof;
    for (let v = 0; v < 9; v++) bin.pos.push(all[k + v]);
    for (let v = 0; v < 3; v++) bin.col.push(c.r, c.g, c.b);
  }
  const group = new THREE.Group();
  group.name = 'buildings';
  bins.forEach((bin, i) => {
    if (!bin.pos.length) return;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(bin.pos, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(bin.col, 3));
    geo.computeVertexNormals(); // unindexed, so each face keeps its own (flat) normal
    geo.computeBoundingSphere();
    const mesh = new THREE.Mesh(geo, material);
    mesh.name = `buildings ${i}`;
    mesh.userData.casts = true; // casts into the room; receives none (outside the room's shadow map, it would only cost lookups)
    group.add(mesh);
  });
  return group;
}

// A lumpy unit sphere, so crowns don't read as perfect balls. (The icosphere comes with
// separate vertices per face; merging them first keeps the shading smooth.)
// detail 2 = 320 triangles, 1 = 80, 0 = 20: a thousand trees at detail 3 would be 1.3 M.
function crownGeometry(detail) {
  const geo = mergeVertices(new THREE.IcosahedronGeometry(1, detail));
  const p = geo.attributes.position, v = new THREE.Vector3();
  for (let i = 0; i < p.count; i++) {
    v.fromBufferAttribute(p, i);
    const bump = 0.12 * Math.sin(5.1 * v.x + 1.3) * Math.sin(4.3 * v.y + 0.7) * Math.sin(4.7 * v.z + 2.1) + 0.06 * Math.sin(11 * v.x + 9 * v.z);
    v.multiplyScalar(1 + bump - 0.15 * Math.max(0, -v.y)); // and a flatter underside
    p.setXYZ(i, v.x, v.y, v.z);
  }
  geo.computeVertexNormals();
  return geo;
}

// Trees from the surface model: a trunk and a slightly squashed crown sized from the tree's
// height. Crowns within NEAR metres of the flat get the finer shape (crowns: [near, far] detail);
// the rest are seen from far away. Each tile has its crowns (near, far) and trunks.
const NEAR = 60;
function treeTiles(site, materials, [nearDetail, farDetail]) {
  const trees = site.trees;
  // Crowns in front of the flat's own facade may not grow into the building.
  const b = THREE.MathUtils.degToRad(site.facade.bearing);
  const out = [Math.sin(b), -Math.cos(b)];
  const isNear = ([x, , z]) => Math.hypot(x - site.facade.x, z - site.facade.z) < NEAR;
  const shapes = { near: crownGeometry(nearDetail), far: crownGeometry(farDetail), trunk: new THREE.CylinderGeometry(0.7, 1, 1, 7) };
  // The same random numbers in the same order as before tiling, so every tree keeps its look.
  const rnd = seededRandom(7);
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), p = new THREE.Vector3(), c = new THREE.Color();
  const yAxis = new THREE.Vector3(0, 1, 0);
  const bins = new Map(); // `${tile}|${kind}` → [{ matrix, color }]
  const put = (key, matrix, color) => {
    if (!bins.has(key)) bins.set(key, []);
    bins.get(key).push([matrix.clone(), color?.clone()]);
  };
  for (const tree of trees) {
    const [x, y, z, h] = tree;
    const ahead = (x - site.facade.x) * out[0] + (z - site.facade.z) * out[1]; // metres in front of the facade
    const r = THREE.MathUtils.clamp(Math.min(0.3 * h, ahead > 0 ? ahead - 0.8 : Infinity), 1.2, 6.5); // crown radius
    const ry = Math.min(0.5 * h, 1.15 * r); // crown half-height
    q.setFromAxisAngle(yAxis, rnd() * Math.PI);
    const tile = tileOf(site, x, z);
    m.compose(p.set(x, y + h - ry, z), q, s.set(r, ry, r * (0.85 + 0.3 * rnd())));
    c.setHSL(0.24 + 0.06 * rnd(), 0.32 + 0.15 * rnd(), 0.26 + 0.1 * rnd(), THREE.SRGBColorSpace); // HSL picked as sRGB, not linear
    put(`${tile}|${isNear(tree) ? 'near' : 'far'}`, m, c);
    const th = Math.max(0.5, h - 1.6 * ry); // visible trunk below the crown, plus a bit inside it
    m.compose(p.set(x, y + th / 2 + 0.3 * ry / 2, z), q, s.set(0.08 + 0.012 * h, th + 0.3 * ry, 0.08 + 0.012 * h));
    put(`${tile}|trunk`, m, null);
  }
  const meshes = [];
  for (const [key, list] of bins) {
    const kind = key.split('|')[1];
    const mesh = new THREE.InstancedMesh(shapes[kind], kind === 'trunk' ? materials.bark : materials.leaves, list.length);
    list.forEach(([matrix, color], i) => {
      mesh.setMatrixAt(i, matrix);
      if (color) mesh.setColorAt(i, color);
    });
    mesh.computeBoundingSphere();
    mesh.userData.casts = true; // casts into the room; receives none
    mesh.name = `tree ${kind === 'trunk' ? 'trunks' : `crowns (${kind})`} ${key.split('|')[0]}`;
    meshes.push(mesh);
  }
  return meshes;
}
