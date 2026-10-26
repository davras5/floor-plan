import * as THREE from 'three';

// Lights that come with a piece of furniture (products.json `lights`): the Post floor lamp's two
// heads, as spotlights hung from the piece's pivot, so they move and turn with it, and its
// diffusers, which glow. lighting.js switches each piece's light on its own (automatic, or by
// hand from the piece's card) and sets how bright.
//
// furniture: the Furniture; shadowSize: px of each spotlight's shadow map (only used where
// there are shadow maps). Returns sync(), to call when the furniture changes: it makes the
// lights of new pieces, drops those of pieces that changed product, and returns them all as
// [{ id, lights, present(), glow() }] for lighting.setPieceLights.
export function createPieceLights(furniture, shadowSize = 512) {
  const made = new Map(); // item id → { key, item, lights, def }
  return function sync() {
    for (const item of furniture.items) {
      let e = made.get(item.id);
      if (e && e.key !== item.key) {
        for (const light of e.lights) light.removeFromParent(), light.target.removeFromParent();
        made.delete(item.id);
        e = null;
      }
      const def = item.spec.lights;
      if (!def || e) continue;
      const lights = def.spots.map(({ position, direction }) => {
        const light = new THREE.SpotLight(0xffffff, 0, 0, THREE.MathUtils.degToRad(def.angle ?? 80) / 2, def.penumbra ?? 1, 2);
        light.name = `${item.id} light`;
        light.position.fromArray(position);
        light.target.position.fromArray(position).add(new THREE.Vector3().fromArray(direction));
        light.castShadow = true;
        light.shadow.mapSize.set(shadowSize, shadowSize);
        Object.assign(light.shadow.camera, { near: 0.05, far: 8 });
        light.shadow.bias = -0.0005;
        light.shadow.normalBias = 0.01;
        light.shadow.focus = 0.7; // the shadow camera's field: most of the cone, sharper texels
        light.visible = false;
        item.pivot.add(light, light.target);
        return light;
      });
      made.set(item.id, { key: item.key, item, lights, def });
    }
    return [...made.values()].map(({ item, lights, def }) => ({
      id: item.id,
      lights,
      present: () => item.present,
      // The glowing part's materials (they're new whenever the model is loaded again).
      glow: () => [...new Set((item.parts?.[def.glow]?.meshes ?? []).map((m) => m.material))],
    }));
  };
}
