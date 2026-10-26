import * as THREE from 'three';
import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import { seededRandom } from '../util.js';

// The flat's real neighbourhood, from swisstopo open data prepared by scripts/surroundings.py:
// terrain draped with the aerial photo, buildings with roofs, and trees found in the surface
// model. The data arrives in "site" coordinates (metres from the map pin; x east, y up, z south)
// and is placed so the room's window wall sits on the building's real garden facade.

// options: anisotropy (the aerial photo's filtering), detail ('high' or 'low': see setDetail).
export async function loadSurroundings(R, { anisotropy: aniso = 1, detail = 'high' } = {}, base = 'assets/surroundings/') {
  const get = async (file) => {
    const r = await fetch(base + file);
    if (!r.ok) throw new Error(`${file}: HTTP ${r.status}`);
    return r;
  };
  const site = await (await get('site.json')).json();
  const [buildings, terrain, photo] = await Promise.all([
    get(site.buildings.file).then((r) => r.arrayBuffer()),
    get(site.terrain.file).then((r) => r.arrayBuffer()),
    new THREE.TextureLoader().loadAsync(base + site.ortho.file),
  ]);
  photo.colorSpace = THREE.SRGBColorSpace;
  photo.anisotropy = aniso;

  const inner = new THREE.Group(); // site coordinates
  inner.add(terrainMesh(site, new Float32Array(terrain), photo), ...buildingMeshes(site, buildings), ...treeMeshes(site));

  const toRoom = siteToRoom(R, site);
  const group = new THREE.Group();
  group.name = 'surroundings';
  group.matrixAutoUpdate = false;
  group.matrix.copy(toRoom);
  group.add(inner);

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
      group.traverse((o) => {
        if (!o.isMesh) return;
        o.layers.set(1);
        if (on) o.layers.enable(0);
      });
    },
    // How finely the terrain and trees are drawn ('high' or 'low'), from the rendering quality.
    setDetail(level) {
      detail = level;
    },
    // Shadow casting on or off (it only matters for the sun). Changes no shaders.
    setCasting(on) {
      group.traverse((o) => {
        if (!o.isMesh) return;
        o.userData.casts ??= o.castShadow;
        o.castShadow = on && o.userData.casts;
      });
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

function terrainMesh(site, heights, photo) {
  const { cols, rows, step, x0, z0 } = site.terrain;
  const geo = new THREE.PlaneGeometry((cols - 1) * step, (rows - 1) * step, cols - 1, rows - 1);
  geo.rotateX(-Math.PI / 2); // first row of vertices is now the north edge, like the height grid
  geo.translate(x0 + ((cols - 1) * step) / 2, 0, z0 + ((rows - 1) * step) / 2);
  const pos = geo.attributes.position, uv = geo.attributes.uv, half = site.ortho.size / 2;
  for (let i = 0; i < pos.count; i++) {
    pos.setY(i, heights[i]);
    uv.setXY(i, (pos.getX(i) + half) / site.ortho.size, 1 - (pos.getZ(i) + half) / site.ortho.size);
  }
  geo.computeVertexNormals();
  const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ map: photo, roughness: 1 }));
  mesh.name = 'terrain';
  return mesh;
}

function buildingMeshes(site, buffer) {
  const all = new Float32Array(buffer);
  const soup = (from, to, material) => {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(all.subarray(from, to), 3));
    geo.computeVertexNormals(); // unindexed, so each face keeps its own (flat) normal
    const mesh = new THREE.Mesh(geo, material);
    mesh.castShadow = true; // casts into the room; receives none (outside the room's shadow map, it would only cost lookups)
    return mesh;
  };
  // Faces in the source data aren't consistently wound, so both sides are drawn.
  const walls = soup(0, site.buildings.walls, new THREE.MeshStandardMaterial({ color: 0xe9e4da, roughness: 0.92, side: THREE.DoubleSide }));
  const roofs = soup(site.buildings.walls, site.buildings.walls + site.buildings.roofs, new THREE.MeshStandardMaterial({ color: 0x8d7f77, roughness: 0.85, side: THREE.DoubleSide }));
  walls.name = 'building walls';
  roofs.name = 'roofs';
  return [walls, roofs];
}

// A lumpy unit sphere, so crowns don't read as perfect balls. (The icosphere comes with
// separate vertices per face; merging them first keeps the shading smooth.)
// detail 2 = 320 triangles, detail 1 = 80: a thousand trees at detail 3 would be 1.3 M.
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

// Trees from the surface model: a trunk and a slightly squashed crown sized from the tree's height.
// Crowns within NEAR metres of the flat get the finer shape; the rest are seen from far away.
const NEAR = 60;
function treeMeshes(site) {
  const trees = site.trees;
  // Crowns in front of the flat's own facade may not grow into the building.
  const b = THREE.MathUtils.degToRad(site.facade.bearing);
  const out = [Math.sin(b), -Math.cos(b)];
  const isNear = ([x, , z]) => Math.hypot(x - site.facade.x, z - site.facade.z) < NEAR;
  const nearCount = trees.filter(isNear).length;
  const leaves = new THREE.MeshStandardMaterial({ roughness: 0.9 });
  const crownsNear = new THREE.InstancedMesh(crownGeometry(2), leaves, nearCount);
  const crownsFar = new THREE.InstancedMesh(crownGeometry(1), leaves, trees.length - nearCount);
  const trunks = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.7, 1, 1, 7), new THREE.MeshStandardMaterial({ color: 0x5b4a3c, roughness: 1 }), trees.length);
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), p = new THREE.Vector3(), c = new THREE.Color();
  const yAxis = new THREE.Vector3(0, 1, 0);
  const rnd = seededRandom(7);
  let iNear = 0, iFar = 0;
  trees.forEach((tree, i) => {
    const [x, y, z, h] = tree;
    const ahead = (x - site.facade.x) * out[0] + (z - site.facade.z) * out[1]; // metres in front of the facade
    const r = THREE.MathUtils.clamp(Math.min(0.3 * h, ahead > 0 ? ahead - 0.8 : Infinity), 1.2, 6.5); // crown radius
    const ry = Math.min(0.5 * h, 1.15 * r); // crown half-height
    q.setFromAxisAngle(yAxis, rnd() * Math.PI);
    const [crowns, k] = isNear(tree) ? [crownsNear, iNear++] : [crownsFar, iFar++];
    crowns.setMatrixAt(k, m.compose(p.set(x, y + h - ry, z), q, s.set(r, ry, r * (0.85 + 0.3 * rnd()))));
    crowns.setColorAt(k, c.setHSL(0.24 + 0.06 * rnd(), 0.32 + 0.15 * rnd(), 0.26 + 0.1 * rnd(), THREE.SRGBColorSpace)); // HSL picked as sRGB, not linear
    const th = Math.max(0.5, h - 1.6 * ry); // visible trunk below the crown, plus a bit inside it
    trunks.setMatrixAt(i, m.compose(p.set(x, y + th / 2 + 0.3 * ry / 2, z), q, s.set(0.08 + 0.012 * h, th + 0.3 * ry, 0.08 + 0.012 * h)));
  });
  const meshes = [crownsNear, crownsFar, trunks];
  for (const mesh of meshes) {
    mesh.castShadow = true; // casts into the room; receives none (outside the room's shadow map, it would only cost lookups)
    mesh.computeBoundingSphere();
  }
  crownsNear.name = 'tree crowns (near)';
  crownsFar.name = 'tree crowns (far)';
  trunks.name = 'tree trunks';
  return meshes;
}
