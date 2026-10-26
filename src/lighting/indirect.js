import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

// Indirect light from the room itself. A cube camera in the middle of the room renders what
// a point there sees (sunlit floor, white walls, the bright windows, the lamp at night);
// that capture, filtered into an environment map (PMREM), becomes scene.environment. Every
// PBR material then gets the room's real bounced light as ambient, and plausible reflections
// (the windows in the lacquered floor, box-projected in shader-hooks.js).
//
// Each capture starts from no indirect light at all: the first pass sees only direct light,
// the second sees that pass's bounce too, so the result never depends on what came before.
//
// The ceiling gets its own small probe just below it. From the middle of the room the view
// downward is ~80% floor, but the ceiling's own view is about half walls; using the central
// probe made it come out dark and orange.
//
// The same capture meters exposure the way a camera's incident-light meter would: from the
// average light arriving at the middle of the room, independent of where you look. The read-
// back is asynchronous, so it doesn't stall the GPU.
//
// Captures only happen when something changes (sun, lamp, furniture), not per frame.
//
// Kept cheap to repeat: each probe has its own filter (PMREMGenerator) and output, made once
// and refilled in place, so nothing is allocated or recompiled per capture, and the scene's
// environment texture never changes identity.

const SIZE = 128; // per cube face; plenty for diffuse light and satin reflections

function probe(scene, size, position) {
  const target = new THREE.WebGLCubeRenderTarget(size, { type: THREE.HalfFloatType, generateMipmaps: false });
  const cube = new THREE.CubeCamera(0.05, 1500, target);
  cube.position.copy(position);
  for (const cam of cube.children) cam.layers.enableAll(); // the neighbourhood lives on layer 1
  scene.add(cube);
  return { target, cube };
}

// ceiling: { position, materials: () => [materials lit by the ceiling probe] }
// Sets scene.environment right away: a neutral stand-in (three's RoomEnvironment) at the
// capture's size, until the first capture fills the same texture with the room's own light.
// size: px per cube face of the main probe (the ceiling's is half that). At 64 px a capture took
// as long as at 128 (it isn't fill-bound) for 3.5 MB less, so every quality level keeps 128.
export function createIndirect(renderer, scene, position, ceiling, size = SIZE) {
  let main, top, pmrem, pmremTop, env, ceilingEnv = null, n = 0;
  const canMeter = renderer.extensions.has('EXT_color_buffer_float') || renderer.extensions.has('EXT_color_buffer_half_float');

  // (three notices the envMap change itself; the program is the same, so nothing recompiles.)
  const setCeilingEnv = (texture) => {
    for (const m of ceiling.materials()) m.envMap = texture;
  };

  function build(faceSize) {
    if (main) {
      setCeilingEnv(null);
      scene.remove(main.cube, top.cube);
      for (const t of [env, ceilingEnv, main.target, top.target]) t?.dispose();
      pmrem.dispose();
      pmremTop.dispose();
      ceilingEnv = null;
    }
    n = faceSize;
    main = probe(scene, n, position);
    top = probe(scene, Math.max(16, n / 2), ceiling.position);
    pmrem = new THREE.PMREMGenerator(renderer);
    pmremTop = new THREE.PMREMGenerator(renderer);
    const standIn = new RoomEnvironment();
    new THREE.CubeCamera(0.1, 100, main.target).update(renderer, standIn);
    standIn.dispose?.();
    env = pmrem.fromCubemap(main.target.texture);
    scene.environment = env.texture;
  }
  build(size);

  // What a camera's meter would read from the capture. Exposure: log-average luminance over
  // the whole capture. White balance: the colour of the white walls and ceiling, which is the
  // colour of the light falling on them; so the floor face (cube face 3, −y) is left out, and
  // so are very bright samples (sky through the windows, sunlit patches). Averaging everything
  // instead ("grey world") gets fooled by the big orange oak floor.
  // The samples are every 37th pixel at 128 px a face; at another size the stride keeps about
  // the same number of samples per face.
  const f = THREE.DataUtils.fromHalfFloat;
  async function meter() {
    if (!canMeter) return null;
    const size = n, target = main.target, stride = Math.max(1, Math.round(37 * (size / SIZE) ** 2));
    const faces = await Promise.all([0, 1, 2, 3, 4, 5].map((face) => {
      const buf = new Uint16Array(size * size * 4);
      return renderer.readRenderTargetPixelsAsync(target, 0, 0, size, size, buf, face).then(() => buf);
    }));
    const samples = [];
    let sum = 0;
    faces.forEach((pixels, face) => {
      for (let i = 0; i < pixels.length; i += 4 * stride) {
        const r = f(pixels[i]), g = f(pixels[i + 1]), b = f(pixels[i + 2]);
        const lum = Math.max(0, 0.2126 * r + 0.7152 * g + 0.0722 * b); // dithering dips below 0 at night
        sum += Math.log(1e-4 + lum);
        samples.push(face, r, g, b, lum);
      }
    });
    const luminance = Math.exp(sum / (samples.length / 5));
    const rgb = [0, 0, 0];
    for (let i = 0; i < samples.length; i += 5) {
      if (samples[i] === 3 || samples[i + 4] > 12 * luminance) continue;
      rgb[0] += samples[i + 1];
      rgb[1] += samples[i + 2];
      rgb[2] += samples[i + 3];
    }
    return { luminance, color: new THREE.Color(...rgb) };
  }

  return {
    // The main probe's cube target (main.js compiles shaders for it ahead of time).
    get target() {
      return main.target;
    },
    // prepare(): sets the scene up for the capture (walls uncut, overlays hidden, …) and
    // returns a function that restores it. Resolves to the meter reading ({ luminance, color }),
    // or null where the GPU can't read it back.
    capture(prepare, bounces = 2) {
      const restore = prepare();
      const intensity = scene.environmentIntensity;
      try {
        setCeilingEnv(null); // during the capture the ceiling takes the room's light like the rest
        for (let i = 0; i < bounces; i++) {
          // The first pass sees direct light only (no history), each later one the bounce before
          // it. Dimmed rather than unbound: without an environment every shader would differ.
          scene.environmentIntensity = i === 0 ? 0 : intensity;
          main.cube.update(renderer, scene);
          pmrem.fromCubemap(main.target.texture, env);
        }
        scene.environmentIntensity = intensity;
        top.cube.update(renderer, scene);
        ceilingEnv = pmremTop.fromCubemap(top.target.texture, ceilingEnv);
        setCeilingEnv(ceilingEnv.texture);
      } finally {
        scene.environmentIntensity = intensity;
        restore();
      }
      return meter();
    },
    dispose() {
      env.dispose();
      ceilingEnv?.dispose();
      main.target.dispose();
      top.target.dispose();
      pmrem.dispose();
      pmremTop.dispose();
    },
  };
}

// A plain sky environment for outdoor materials, which shouldn't be lit by the room's capture.
// Only re-filtered when the sky's colours have changed, into the same small target: a smooth
// gradient needs no more than 32 px a face.
export function skyEnvironment(renderer, skyMesh) {
  const pmrem = new THREE.PMREMGenerator(renderer);
  const s = new THREE.Scene();
  const sky = skyMesh.clone();
  sky.position.set(0, 0, 0);
  sky.scale.setScalar(0.1);
  s.add(sky);
  const cube = new THREE.CubeCamera(0.1, 200, new THREE.WebGLCubeRenderTarget(32, { type: THREE.HalfFloatType, generateMipmaps: false }));
  let rt = null, key = '';
  return {
    update() {
      const u = skyMesh.material.uniforms;
      const k = ['top', 'horizon', 'bottom'].map((n) => u[n].value.getHexString() + u[n].value.r.toFixed(3)).join();
      if (rt && k === key) return rt.texture;
      key = k;
      cube.update(renderer, s);
      rt = pmrem.fromCubemap(cube.renderTarget.texture, rt);
      return rt.texture;
    },
  };
}
