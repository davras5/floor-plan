import * as THREE from 'three';

// The existing pendant: an opal-glass pebble on a thin curly cord, hanging from the
// ceiling outlet. Its profile was traced from the photos (half-width against height,
// both as fractions of the shade's width and height).
//
// It can be swagged (setHang): the cord runs along the ceiling from the outlet to a hook and
// drops from there, so a preset can hang the shade over a table, lower, where a low shade belongs
// (the layout check wants nothing at head height over open floor). The outlet and its canopy stay
// where they are.
const PROFILE = [
  [0.22, 0], [0.324, 0.053], [0.437, 0.134], [0.486, 0.241], [0.5, 0.348], [0.496, 0.455],
  [0.478, 0.561], [0.445, 0.668], [0.393, 0.775], [0.308, 0.882], [0.142, 0.989], [0, 1],
];

export function buildPendant(R) {
  const outlet = { x: R.ceilingOutlet.x, z: R.ceilingOutlet.z, bottom: R.pendant.bottom };
  const { width, height } = R.pendant;
  const H = R.height;
  const group = new THREE.Group();
  group.name = 'pendant';

  // Opal glass: soft white by day; glows with the bulb's light when the lamp is on (lighting.js
  // drives emissive and its colour).
  const glass = new THREE.MeshPhysicalMaterial({
    color: 0xf6f5f1, roughness: 0.45, clearcoat: 0.6, clearcoatRoughness: 0.25,
    emissive: 0xffdcb0, emissiveIntensity: 0,
  });
  const white = new THREE.MeshStandardMaterial({ color: 0xf2f2ef, roughness: 0.4 });
  // Opaque: a transparent 5 mm cord breaks up into dashes on screen.
  const cordMat = new THREE.MeshStandardMaterial({ color: 0xd8d8d4, roughness: 0.3 });

  // Flat base, then a smooth curve up over the dome.
  const curve = new THREE.SplineCurve(PROFILE.map(([r, t]) => new THREE.Vector2(r * width, t * height)));
  const shade = new THREE.Mesh(new THREE.LatheGeometry([new THREE.Vector2(0, 0), ...curve.getPoints(48)], 72), glass);
  shade.scale.z = 0.94; // slightly pebble-shaped rather than perfectly round
  shade.rotation.y = 0.4;
  group.add(shade);

  // Domed canopy at the ceiling outlet.
  const canopy = new THREE.Mesh(new THREE.CylinderGeometry(0.065, 0.05, 0.07, 40), white);
  canopy.position.set(outlet.x, H - 0.035, outlet.z);
  group.add(canopy);

  // A ceiling hook, where the cord is swagged to (hidden otherwise).
  const hook = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.016, 0.035, 16), white);
  hook.visible = false;
  group.add(hook);

  const cord = new THREE.Mesh(new THREE.BufferGeometry(), cordMat);
  group.add(cord);

  // The light source sits inside the shade.
  const lightPosition = new THREE.Vector3();
  let hang = null; // { x, z, bottom } when swagged

  // The cord's path from the canopy to the top of the shade: straight down with a gentle curl
  // (as in the photos), or along the ceiling to the hook, sagging a little, then down.
  function cordPoints(x, z, top) {
    const start = H - 0.07;
    const curl = (t, amp) => Math.sin(t * Math.PI * 3) * amp * Math.sin(t * Math.PI);
    if (!hang) {
      return Array.from({ length: 9 }, (_, i) => {
        const t = i / 8, w = curl(t, 0.012);
        return new THREE.Vector3(x + w, start + (top - start) * t, z + w * 0.4);
      });
    }
    const run = Math.hypot(x - outlet.x, z - outlet.z), sag = Math.min(0.08, 0.05 * run);
    const pts = [new THREE.Vector3(outlet.x, start, outlet.z)];
    for (let i = 1; i < 4; i++) {
      const t = i / 4;
      pts.push(new THREE.Vector3(THREE.MathUtils.lerp(outlet.x, x, t), start - sag * Math.sin(Math.PI * t), THREE.MathUtils.lerp(outlet.z, z, t)));
    }
    const drop = H - 0.09;
    pts.push(new THREE.Vector3(x, H - 0.045, z), new THREE.Vector3(x, drop, z));
    for (let i = 1; i <= 6; i++) {
      const t = i / 6, w = curl(t, 0.01);
      pts.push(new THREE.Vector3(x + w, drop + (top - drop) * t, z + w * 0.4));
    }
    return pts;
  }

  function layout() {
    const x = hang?.x ?? outlet.x, z = hang?.z ?? outlet.z, bottom = hang?.bottom ?? outlet.bottom;
    shade.position.set(x, bottom, z);
    cord.geometry.dispose();
    cord.geometry = new THREE.TubeGeometry(new THREE.CatmullRomCurve3(cordPoints(x, z, bottom + height), false, 'centripetal'), 72, 0.0025, 8);
    hook.visible = !!hang;
    hook.position.set(x, H - 0.0175, z);
    lightPosition.set(x, bottom + height * 0.4, z);
  }
  layout();

  // The shade lets light through, so none of it casts shadows. But all of it receives them:
  // a mesh that doesn't is lit by the sun straight through the walls and ceiling.
  group.traverse((o) => {
    if (!o.isMesh) return;
    o.castShadow = false;
    o.receiveShadow = true;
  });

  return {
    group,
    glass,
    lightPosition,
    // Hang the shade from a hook at (x, z) with its bottom `bottom` up; null hangs it from the
    // outlet again. Returns whether anything changed (the caller moves the lamp's light and
    // redraws).
    setHang(h) {
      const next = h ? { x: h.x, z: h.z, bottom: h.bottom ?? outlet.bottom } : null;
      if (JSON.stringify(next) === JSON.stringify(hang)) return false;
      hang = next;
      layout();
      return true;
    },
    get hang() {
      return hang;
    },
    // Where the shade is now: its centre, bottom height and radius.
    get position() {
      return { x: hang?.x ?? outlet.x, z: hang?.z ?? outlet.z, bottom: hang?.bottom ?? outlet.bottom, radius: width / 2 };
    },
  };
}
