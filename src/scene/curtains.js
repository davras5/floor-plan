import * as THREE from 'three';
import { seededRandom } from '../util.js';
import { extraSunShadowBias } from '../lighting/shader-hooks.js';
import { SUN_SHADOW } from '../lighting/lighting.js';

// The sheer white voile curtains from the photos: two floor-length panels on the rail,
// gathered at its ends (one in the left corner, one right of the balcony door). Each panel
// is a pleated sheet: folds a few centimetres deep, a little tighter at the heading and
// freer toward the hem, with an uneven hem. Sheer, so the window glows through, and they
// let some sun through too (hashed transparency in the shadow map).
//
// They can be drawn: setClosed(t) slides the panels from their stacks (0) until they meet in
// the middle of the rail (1). The same fabric spread wider hangs in shallower folds.

const FOLD = 0.07; // m of stack width per fold

export function buildCurtains(R) {
  const rail = R.curtainRail;
  const { stack, hem, inFront } = R.curtains;
  const group = new THREE.Group();
  group.name = 'curtains';

  const voile = new THREE.MeshStandardMaterial({
    color: 0xf6f5f1, roughness: 0.95, side: THREE.DoubleSide,
    transparent: true, opacity: 0.78, depthWrite: false, dithering: true,
  });
  // It receives the sun's shadow (or it would be sunlit through the wall), offset by 4 cm so
  // the folds (3.5 cm deep) don't shadow each other as a dotted pattern; the wall that should
  // shade them is 30 cm or more away.
  extraSunShadowBias(voile, 0.04, SUN_SHADOW.far - SUN_SHADOW.near);
  // Shadows: about half the sunlight gets through a gathered voile stack.
  const shadow = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking, alphaHash: true, opacity: 0.5 });

  const top = rail.height + 0.012, bottom = hem;
  const z = inFront; // the heading hangs on the front of the rail
  const middle = (rail.from + rail.to) / 2, overlap = 0.03; // drawn, they overlap a little
  const panels = [[rail.from, 11, 1], [rail.to, 23, -1]].map(([end, seed, dir]) => {
    const panel = pleatedPanel(stack, bottom, top, z, seededRandom(seed));
    const mesh = new THREE.Mesh(panel.geometry, voile);
    mesh.customDepthMaterial = shadow;
    mesh.castShadow = mesh.receiveShadow = true;
    mesh.renderOrder = 3; // after the window glass (2), so from inside the glass doesn't tint the voile
    group.add(mesh);
    // Its fixed end stays at the rail's end; the other slides toward the middle.
    const layout = (t) => {
      const reach = THREE.MathUtils.lerp(stack, Math.abs(middle - end) + overlap, t);
      panel.layout(dir > 0 ? end : end - reach, dir > 0 ? end + reach : end);
    };
    layout(0);
    return { mesh, layout };
  });
  let closed = 0;
  return {
    group,
    material: voile,
    meshes: panels.map((p) => p.mesh),
    get closed() {
      return closed;
    },
    setClosed(t) {
      closed = t;
      for (const p of panels) p.layout(t);
    },
  };
}

// A pleated sheet `width` wide (the fabric as gathered), hung between y0 and y1; layout(x0, x1)
// spreads it over that span of the rail, keeping each point's place on the fabric.
function pleatedPanel(width, y0, y1, z, rnd) {
  const h = y1 - y0;
  const folds = Math.max(2, Math.round(width / FOLD));
  const nu = folds * 12, nv = 32;
  const geometry = new THREE.PlaneGeometry(width, h, nu, nv);
  const pos = geometry.attributes.position;
  const uv = Float32Array.from({ length: pos.count * 2 }, (_, k) => {
    const i = k >> 1;
    return k & 1 ? (pos.getY(i) + h / 2) / h : (pos.getX(i) + width / 2) / width;
  });
  // Each fold gets its own depth and a slow sideways drift down the drop.
  const depth = Array.from({ length: folds }, () => 0.8 + 0.4 * rnd());
  const drift = Array.from({ length: folds }, () => (rnd() - 0.5) * 0.012);
  const hemWave = Array.from({ length: 5 }, () => rnd() * Math.PI * 2);
  function layout(x0, x1) {
    const w = x1 - x0;
    const spread = Math.sqrt(Math.min(1, width / w)); // shallower folds when drawn wide
    for (let i = 0; i < pos.count; i++) {
      const u = uv[2 * i]; // 0 → 1 across
      const v = uv[2 * i + 1]; // 0 at the hem → 1 at the heading
      const f = Math.min(folds - 1, Math.floor(u * folds));
      const fall = 1 - v; // how far down the drop
      const amp = (0.018 + 0.017 * fall) * depth[f] * spread; // tighter at the pleated heading
      const x = x0 + u * w + drift[f] * fall;
      const dz = amp * Math.sin(2 * Math.PI * folds * u);
      let y = y0 + v * h;
      if (v === 0) y += 0.004 * Math.sin(u * 9 + hemWave[0]) + 0.003 * Math.sin(u * 23 + hemWave[1]);
      pos.setXYZ(i, x, y, z + 0.035 + dz);
    }
    pos.needsUpdate = true;
    geometry.computeVertexNormals();
    geometry.computeBoundingSphere();
    geometry.computeBoundingBox();
  }
  return { geometry, layout };
}
