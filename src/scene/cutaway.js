import * as THREE from 'three';
import { SECTION } from './room.js';

// Cutaway: in the 3D view, walls between the camera and the room drop to a low stub; in Plan the
// ceiling goes (and main.js's plan camera cuts everything at 1.2 m with its near plane). Cut
// walls swap to a clipped copy of their material; shadows still use the full wall (clipShadows
// stays off), so daylight falls the same way in every view. Each wall's section cap and
// dimension lines follow its state.

export function createCutaway(room, notes) {
  const stubPlane = new THREE.Plane(new THREE.Vector3(0, -1, 0), SECTION.stub);
  const clipped = new Map();

  function setCut(wall, cut) {
    wall.cut = cut;
    wall.group.traverse((o) => {
      if (!o.isMesh || o.userData.outline) return; // a selection outline keeps its own material
      const base = (o.userData.baseMaterial ??= o.material);
      if (!cut) {
        o.material = base;
        return;
      }
      if (!clipped.has(base)) {
        const m = base.clone();
        m.clippingPlanes = [stubPlane];
        // clone() doesn't copy shader hooks (the corner shading), so carry them over.
        m.onBeforeCompile = base.onBeforeCompile;
        m.customProgramCacheKey = base.customProgramCacheKey;
        clipped.set(base, m);
      }
      o.material = clipped.get(base);
    });
  }

  function update(mode, cameraPosition) {
    for (const wall of room.walls) {
      const cut =
        mode === 'orbit' ? wall.outside(cameraPosition) :
        mode === 'plan' ? wall.name === 'ceiling' : false;
      if (cut !== wall.cut) setCut(wall, cut);
      if (wall.caps) {
        wall.caps.stub.visible = mode === 'orbit' && wall.cut;
        wall.caps.plan.visible = mode === 'plan';
      }
      const dims = notes.sides[wall.name];
      if (dims) dims.visible = mode === 'plan' || wall.cut;
    }
  }

  // clippedOf: the cut copy of a material, if any.
  return { setCut, update, clippedOf: (material) => clipped.get(material) };
}
