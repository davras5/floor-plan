import * as THREE from 'three';

// The existing pendant: an opal-glass pebble on a thin curly cord, hanging from the
// ceiling outlet. Its profile was traced from the photos (half-width against height,
// both as fractions of the shade's width and height).
const PROFILE = [
  [0.22, 0], [0.324, 0.053], [0.437, 0.134], [0.486, 0.241], [0.5, 0.348], [0.496, 0.455],
  [0.478, 0.561], [0.445, 0.668], [0.393, 0.775], [0.308, 0.882], [0.142, 0.989], [0, 1],
];

export function buildPendant(R) {
  const { x, z } = R.ceilingOutlet;
  const { width, height, bottom } = R.pendant;
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
  shade.position.set(x, bottom, z);
  group.add(shade);

  // Domed canopy at the ceiling.
  const canopy = new THREE.Mesh(new THREE.CylinderGeometry(0.065, 0.05, 0.07, 40), white);
  canopy.position.set(x, H - 0.035, z);
  group.add(canopy);

  // Cord with a gentle curl, as in the photos.
  const top = bottom + height, start = H - 0.07;
  const pts = Array.from({ length: 9 }, (_, i) => {
    const t = i / 8;
    const wiggle = Math.sin(t * Math.PI * 3) * 0.012 * Math.sin(t * Math.PI);
    return new THREE.Vector3(x + wiggle, start + (top - start) * t, z + wiggle * 0.4);
  });
  const cord = new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 48, 0.0025, 8), cordMat);
  group.add(cord);

  // The shade lets light through, so none of it casts shadows. But all of it receives them:
  // a mesh that doesn't is lit by the sun straight through the walls and ceiling.
  group.traverse((o) => {
    if (!o.isMesh) return;
    o.castShadow = false;
    o.receiveShadow = true;
  });

  // Light source sits inside the shade.
  const lightPosition = new THREE.Vector3(x, bottom + height * 0.4, z);
  return { group, glass, lightPosition };
}
