import * as THREE from 'three';
import { RectAreaLightUniformsLib } from 'three/addons/lights/RectAreaLightUniformsLib.js';

// Direct light: the sun (with real shadows, including from the neighbours), soft area lights
// in the window and balcony-door openings standing in for the sky seen through them, and the
// pendant once it's dark (or whenever it's switched on). Everything indirect (light bounced off the oak floor and the white
// walls) comes from the room's own light probe, scene.environment (indirect.js), and exposure
// is metered from that probe like a camera would.
//
// Units are relative but consistent: the sky's radiance (`sky` × `skyIntensity`), the openings'
// radiance and the sun's irradiance keep daylight's real proportions roughly (sun a few times
// the sky dome), so sunlit patches read as bright as in the photos once exposure is metered.

// Daylight, and what it fades to after sunset (`daylight` blends the two through twilight).
// `key` and `maxExposure` set the metered exposure, like a camera's: a night interior is
// shown darker than a day one, as the eye sees it.
//
// The pendant is about a tenth of the daylight in the room at noon (some 100 lux under it,
// against about 1,000 lux of daylight indoors), so switching it on by day changes little. At
// night it's the main light: everything that's lit at night (the sky, the window openings, the
// shade's glow) is set against it, and the metered exposure goes up to see it, as eyes adapt.
// NIGHT_K is that ratio, so the night look is tuned in the lamp's own terms.
const NIGHT_K = 1 / 13;
const DAY = {
  sun: 4.5, skyIntensity: 1.6, openings: 0.8, openingColor: 0xf0f3fa, env: 1, key: 0.36, maxExposure: 10,
  sky: { top: 0x8fb6dd, horizon: 0xe9eff3, bottom: 0xbcbdb6 },
};
const NIGHT = {
  // openings: the light coming in at night (city glow, the moon), so a room without the lamp is dim, not black.
  skyIntensity: 0.25 * NIGHT_K, openings: 0.5 * NIGHT_K, openingColor: 0x8a93aa, key: 0.2, maxExposure: 6 / NIGHT_K,
  sky: { top: 0x161d36, horizon: 0xc98559, bottom: 0x23211f },
};
// The pendant, when it's on: its light and the glow of its shade.
const LAMP = { intensity: 6 * NIGHT_K, glow: 1.4 * NIGHT_K };
// Switched on automatically when daylight drops below this (the sun about 1° above the horizon).
const LAMP_AUTO_ON = 0.6;

// The sun's shadow camera: from 1 m to 230 m toward the sun (room plus neighbourhood).
// shadow.bias is a fraction of this range; shader-hooks.js offsets are computed from it too.
export const SUN_SHADOW = { near: 1, far: 230, reach: 200 };

// pendant: { lightPosition, glass } from pendant.js — the lamp light sits inside the shade.
export function createLighting(scene, R, layout, skyUniforms, pendant) {
  RectAreaLightUniformsLib.init();
  const { W, L, H, T, win, bal, frameZ } = layout;

  const group = new THREE.Group();
  group.name = 'lighting';
  scene.add(group);

  // The sun's shadow map covers just the room and balcony (refitted to each sun direction, so
  // its texels stay small), but reaches far back toward the sun so the neighbours' buildings
  // and trees can shade the windows. (They're on layer 1; three picks shadow casters by the
  // *viewing* camera's layers, so main.js renders shadows with a camera that sees all layers.)
  const sun = new THREE.DirectionalLight(0xfff0dc, 1);
  const aim = new THREE.Vector3(W / 2, H / 2, L / 2);
  const reach = SUN_SHADOW.reach;
  sun.target.position.copy(aim);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  Object.assign(sun.shadow.camera, { near: SUN_SHADOW.near, far: SUN_SHADOW.far });
  group.add(sun, sun.target);
  const shadowBox = new THREE.Box3(
    new THREE.Vector3(-T.west - 0.3, -0.25, -T.north - R.balcony.depth - 0.3),
    new THREE.Vector3(W + T.east + 0.3, H + 0.3, L + T.south + 0.3),
  );
  const _view = new THREE.Matrix4(), _corner = new THREE.Vector3(), _fit = new THREE.Box3();
  function fitShadow() {
    // Bounds of the box seen from the sun, in the shadow camera's own (view) space.
    _view.lookAt(sun.position, aim, THREE.Object3D.DEFAULT_UP).setPosition(sun.position).invert();
    _fit.makeEmpty();
    for (let i = 0; i < 8; i++) {
      _corner.set(i & 1 ? shadowBox.max.x : shadowBox.min.x, i & 2 ? shadowBox.max.y : shadowBox.min.y, i & 4 ? shadowBox.max.z : shadowBox.min.z);
      _fit.expandByPoint(_corner.applyMatrix4(_view));
    }
    const cam = sun.shadow.camera;
    Object.assign(cam, { left: _fit.min.x, right: _fit.max.x, bottom: _fit.min.y, top: _fit.max.y });
    cam.updateProjectionMatrix();
    // Bias in texel terms. The walls and ceiling cast from both faces (room.js), so the stored
    // depth is the slab's outside face and small offsets can't open a leak at the junctions;
    // `bias` is a fraction of the depth range (230 m), so it's given here in metres / range.
    const texel = Math.max(_fit.max.x - _fit.min.x, _fit.max.y - _fit.min.y) / sun.shadow.mapSize.x;
    sun.shadow.normalBias = 1.5 * texel;
    sun.shadow.bias = -0.002 / (cam.far - cam.near);
  }
  let lampMode = 'auto'; // 'auto' (on when it's dark), or switched 'on' / 'off' by hand
  let sunStrength = 1; // direct sun: fades out as the sun nears the horizon
  let daylight = 1; // sky light: fades through twilight, down to 6° below the horizon

  const openings = [
    [win.x1 - win.x0, win.y1 - win.y0, (win.x0 + win.x1) / 2, (win.y0 + win.y1) / 2],
    [bal.x1 - bal.x0, bal.y1, (bal.x0 + bal.x1) / 2, bal.y1 / 2],
  ].map(([w, h, x, y]) => {
    const light = new THREE.RectAreaLight(0xffffff, 1, w, h);
    light.position.set(x, y, frameZ - 0.05);
    // Tilted 25° down: sky light comes in from above the horizon, so most of it lands on the
    // floor, not the ceiling (a vertical emitter would light both equally).
    light.lookAt(x, y - Math.tan(THREE.MathUtils.degToRad(25)) * L, L);
    group.add(light);
    return light;
  });

  const lamp = new THREE.PointLight(0xffc489, 1, 0, 2);
  lamp.position.copy(pendant.lightPosition);
  lamp.castShadow = true;
  // A point light's shadow is a cube unrolled to 4 × 2 tiles: 512 → 2048 × 1024 (16 MB with
  // depth) rather than 64 MB at 1024. The lamp's shadows are soft anyway.
  lamp.shadow.mapSize.set(512, 512);
  Object.assign(lamp.shadow.camera, { near: 0.05, far: 12 });
  lamp.shadow.bias = -0.005 / (lamp.shadow.camera.far - lamp.shadow.camera.near); // ≈ 5 mm (was 2.4 cm)
  lamp.shadow.normalBias = 0.005;
  group.add(lamp);

  // dir: unit vector toward the sun, in room coordinates.
  function setSun(dir) {
    sun.position.copy(aim).addScaledVector(dir, reach);
    fitShadow();
    const elevation = Math.asin(THREE.MathUtils.clamp(dir.y, -1, 1)) * 180 / Math.PI;
    // Direct sun fades in over the first degrees above the horizon (none below it, where it
    // would shine upward through the floor).
    sunStrength = THREE.MathUtils.smoothstep(elevation, 0.3, 6);
    daylight = THREE.MathUtils.smoothstep(elevation, -6, 6);
    // Low sun is warmer: roughly 5700 K overhead to 3000 K near the horizon (sRGB values).
    const low = 1 - THREE.MathUtils.smoothstep(elevation, 4, 30);
    sunBase.set(0xfff4e6).lerp(c.set(0xffb46b), low * 0.85);
    apply();
  }

  function setLamp(mode) {
    lampMode = mode;
    apply();
  }
  const lampOn = () => (lampMode === 'auto' ? daylight < LAMP_AUTO_ON : lampMode === 'on');

  // Daylight follows the sun: after sunset the sky light and the sky itself fade toward dusk.
  // White balance, like a camera's: a per-channel gain on every light source (sun, openings,
  // lamp, glowing shade, sky). Rendering is linear in the lights, so this is the same as
  // balancing the image, and the room's light capture picks it up too.
  const balance = new THREE.Color(1, 1, 1);
  const sunBase = new THREE.Color(), lampBase = new THREE.Color(0xffc489), glowBase = pendant.glass.emissive.clone();

  const c = new THREE.Color(), d = new THREE.Color();
  function apply() {
    const p = DAY;
    const k = THREE.MathUtils.lerp(NIGHT.openings, 1, daylight); // the openings, relative to daylight
    // The sun stays in the scene when it's down (at night, in Evening), just dark, and only its
    // shadow pass stops. Taking it out (visible = false) would change every shader's light count
    // and recompile them all at each sunset.
    sun.intensity = p.sun * sunStrength;
    sun.shadow.autoUpdate = sun.intensity > 0;
    sun.color.copy(sunBase).multiply(balance);
    for (const light of openings) {
      light.intensity = p.openings * k;
      light.color.set(c.set(NIGHT.openingColor).lerp(d.set(p.openingColor), daylight)).multiply(balance);
    }
    // Off means out of the scene: a point light with shadows costs every pixel a cube-map lookup.
    const on = lampOn();
    lamp.intensity = on ? LAMP.intensity : 0;
    lamp.visible = on;
    lamp.color.copy(lampBase).multiply(balance);
    pendant.glass.emissive.copy(glowBase).multiply(balance);
    pendant.glass.emissiveIntensity = on ? LAMP.glow : 0;
    scene.environmentIntensity = p.env;
    const skyK = THREE.MathUtils.lerp(NIGHT.skyIntensity, p.skyIntensity, daylight);
    for (const key of ['top', 'horizon', 'bottom']) {
      const target = skyUniforms[key].value.set(p.sky[key]);
      target.lerp(c.set(NIGHT.sky[key]), 1 - daylight);
      target.multiplyScalar(skyK).multiply(balance); // HDR: the sky is brighter than any surface in the room
    }
  }

  // Corrects toward neutral from the light's measured colour on the white surfaces (the room
  // capture). Only partly, like a camera that keeps a room's warmth: light bounced off an oak
  // floor really is orange (R:B ≈ 2.5 on the walls here), and balancing it away completely
  // turns the walls cyan. Lamp light keeps more of its warmth. Returns how much it moved.
  function whiteBalance(measured) {
    const strength = THREE.MathUtils.lerp(0.3, 0.45, daylight);
    // The capture was lit with the current balance; divide it out to get the light's own colour
    // (rendering is linear in the lights), so the result doesn't creep toward full correction.
    const raw = measured.clone().multiply(c.setRGB(1 / balance.r, 1 / balance.g, 1 / balance.b));
    const lum = 0.2126 * raw.r + 0.7152 * raw.g + 0.0722 * raw.b;
    if (lum <= 0) return 0;
    const before = balance.clone();
    for (const ch of ['r', 'g', 'b']) balance[ch] = Math.pow(lum / Math.max(raw[ch], 1e-6), strength);
    const n = 0.2126 * balance.r + 0.7152 * balance.g + 0.0722 * balance.b; // keep brightness
    balance.multiplyScalar(1 / n);
    // Kept moderate: the warm bounce and the cool window light are two illuminants, and
    // a strong correction for one tints walls lit by the other (mint walls facing the window).
    for (const ch of ['r', 'g', 'b']) balance[ch] = THREE.MathUtils.clamp(balance[ch], 0.8, 1.25);
    apply();
    return Math.max(Math.abs(balance.r - before.r), Math.abs(balance.g - before.g), Math.abs(balance.b - before.b));
  }

  // Exposure for a metered (log-average) luminance at the middle of the room, like a camera's
  // light meter: `key` is the mid-grey target, lower at night (so a night interior stays dim).
  function exposureFor(luminance) {
    const key = THREE.MathUtils.lerp(NIGHT.key, DAY.key, daylight);
    const max = THREE.MathUtils.lerp(NIGHT.maxExposure, DAY.maxExposure, daylight);
    return THREE.MathUtils.clamp(key / Math.max(luminance, 1e-4), 0.25, max);
  }

  // Shadow map sizes in px (the lamp's per cube face), from the rendering quality. The old maps
  // are dropped; three makes new ones at the next shadow pass. The sun's normal bias is in texels.
  function setShadowSizes(sunSize, lampSize) {
    for (const [light, size] of [[sun, sunSize], [lamp, lampSize]]) {
      if (light.shadow.mapSize.x === size) continue;
      light.shadow.mapSize.set(size, size);
      light.shadow.map?.dispose();
      light.shadow.map = null;
    }
    fitShadow();
  }

  // Until the real sun is known, light comes in through the window wall from above and to one side.
  setSun(new THREE.Vector3(-2.4, 4.6, -7.0).normalize());
  // Runs fn with the lamp switched on (for compiling its shaders ahead of time), then puts it back.
  function withLamp(fn) {
    const was = lamp.visible;
    lamp.visible = true;
    try {
      fn();
    } finally {
      lamp.visible = was;
    }
  }

  return {
    setSun, setLamp, exposureFor, whiteBalance, withLamp, setShadowSizes, balance, sun, lamp,
    get sunUp() {
      return sun.intensity > 0;
    },
    get lampOn() {
      return lampOn();
    },
    get lampMode() {
      return lampMode;
    },
  };
}
