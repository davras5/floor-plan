import * as THREE from 'three';
import { patchShader, afterVaryings, editChunk } from './shader-hooks.js';

// Sunlight through the window without shadow maps, for the simple render path (quality.js:
// phones, and graphics drivers that crash with shadow maps). Without shadows the sun would light
// the room as if it had no walls. Instead, every surface indoors follows its ray toward the sun
// and lets the sun in only where that ray leaves through a pane of the window or the balcony
// door: inside the wall opening, under the balcony above, over the parapet and past the screen
// to the neighbour's balcony. Edges soften with distance, as the sun's own penumbra does
// (0.27°, about 5 mm per metre).
//
// The balcony and the facade get the same treatment without the panes: shaded by the balcony
// above, the parapet and the screen.
//
// What it leaves out: the furniture casts no sun shadows (contact-shadows.js grounds it instead),
// and the neighbourhood (buildings, trees) only dims each pane as a whole (setPanes, from a few
// rays in main.js). With shadow maps on, the hook stays compiled in and adds only the balcony
// above's shade, the one shadow the maps leave out (it's hidden outside Walk); so switching
// between the two paths doesn't change the shaders' code.
//
// room: from buildRoom(); R: the room config.
export function createWindowSun(room, R) {
  const { W, L, H, T, win, bal } = room.layout;
  const B = R.balcony;
  const panes = findPanes(room, win, bal);
  const n = panes.length;
  const z1 = -T.north, z0 = z1 - B.depth; // the facade, and the parapet's outer face
  const uniforms = {
    wsOn: { value: 0 },
    wsDir: { value: new THREE.Vector3(0, 1, -1).normalize() }, // toward the sun
    wsRoom: { value: new THREE.Vector3(W, H, L) },
    wsPane: { value: panes.map((p) => p.rect) }, // glass: x0, y0, x1, y1 on the plane z = wsPaneZ
    wsOpening: { value: panes.map((p) => p.opening) }, // the wall opening in front of it (z = 0)
    wsPaneZ: { value: panes.reduce((s, p) => s + p.z, 0) / Math.max(1, n) },
    wsK: { value: panes.map(() => 1) }, // per pane: 1 clear, 0 blocked (curtains, the neighbourhood)
    // The balcony: underside of the one above (y), the facade and the front (z), the slab's x range.
    wsBalcony: { value: new THREE.Vector4(B.soffit, z1, z0, 0) },
    wsBalconyX: { value: new THREE.Vector2(-T.west, B.to) },
    // Parapet top (y, both parts), the side parapet's inner face (x), the screen (x, top y).
    wsParapet: { value: new THREE.Vector4(B.parapet - B.drop, B.to - B.wall, -T.west / 2, B.screen - B.drop) },
  };

  const glsl = `
    #define WS_PANES ${n}
    uniform float wsOn, wsPaneZ;
    uniform vec3 wsDir, wsRoom;
    uniform vec4 wsPane[WS_PANES], wsOpening[WS_PANES], wsBalcony, wsParapet;
    uniform vec2 wsBalconyX;
    uniform float wsK[WS_PANES];
    float wsRect(vec2 q, vec4 r, float s) {
      vec2 a = smoothstep(r.xy - s, r.xy + s, q) * (1.0 - smoothstep(r.zw - s, r.zw + s, q));
      return a.x * a.y;
    }
    float wsPast(float v, float edge, float s) { return smoothstep(edge - s, edge + s, v); }
    float wsSoft(float t) { return 0.002 + 0.0047 * max(t, 0.0); }
    // How much of the sun reaches p (room coordinates). Indoors (the simple path): only what
    // comes through the panes; 0 in the hallway and the other rooms. Out on the balcony and on
    // the facade: what the balcony above, the parapet and the screen leave. Beyond: all of it.
    // With shadow maps (wsOn 0) only the balcony above counts, the one thing they leave out
    // (it's hidden outside Walk).
    float windowSun(vec3 p) {
      vec3 d = wsDir;
      float zFacade = wsBalcony.y, zFront = wsBalcony.z;
      bool outside = p.z < -0.005;
      if (outside && (p.z < zFront - 0.01 || p.x < wsBalconyX.x - 0.01 || p.x > wsBalconyX.y + 0.01 || p.y > wsBalcony.x + 0.01)) return 1.0;
      float m = 1.0;
      if (!outside && wsOn > 0.5) {
        if (p.x < -0.005 || p.x > wsRoom.x + 0.005 || p.y < -0.005 || p.y > wsRoom.y + 0.005 || p.z > wsRoom.z + 0.005) return 0.0;
        if (d.z > -1e-3) return 0.0; // the sun is behind the house
        float tIn = -p.z / d.z, tPane = (wsPaneZ - p.z) / d.z;
        vec2 qIn = p.xy + d.xy * tIn, qPane = p.xy + d.xy * tPane;
        m = 0.0;
        for (int i = 0; i < WS_PANES; i++) m = max(m, wsRect(qPane, wsPane[i], wsSoft(tPane)) * wsRect(qIn, wsOpening[i], wsSoft(tIn)) * wsK[i]);
        if (m <= 0.0) return 0.0;
      }
      // The balcony above: blocked if the ray is still under it when it reaches its underside.
      if (d.y > 1e-3 && (outside || d.z < -1e-3)) {
        float t = (wsBalcony.x - p.y) / d.y, s = wsSoft(t);
        vec3 q = p + d * t;
        m *= 1.0 - wsPast(q.x, wsBalconyX.x, s) * (1.0 - wsPast(q.x, wsBalconyX.y, s)) * wsPast(q.z, zFront, s);
      }
      if (wsOn < 0.5) return m;
      // The parapet along the front: blocked if the ray meets its outer face below the top
      // (only from inside its inner face: not for the parapet itself and its cover).
      if (p.z > ${(z0 + B.wall - 0.005).toFixed(3)} && d.z < -1e-3) {
        float t = (zFront - p.z) / d.z, s = wsSoft(t);
        vec3 q = p + d * t;
        m *= 1.0 - wsPast(q.x, wsBalconyX.x, s) * (1.0 - wsPast(q.x, wsBalconyX.y, s)) * (1.0 - wsPast(q.y, wsParapet.x, s));
      }
      // The short side parapet (right) and the screen (left): blocked if the ray crosses them,
      // ahead of p, between the facade and the front, below their top.
      if (abs(d.x) > 1e-3) {
        bool right = d.x > 0.0;
        float x = right ? wsParapet.y : wsParapet.z, top = right ? wsParapet.x : wsParapet.w;
        float t = (x - p.x) / d.x, s = wsSoft(t);
        vec3 q = p + d * t;
        if (t > 0.01) m *= 1.0 - wsPast(q.z, zFront, s) * (1.0 - wsPast(q.z, zFacade, s)) * (1.0 - wsPast(q.y, top, s));
      }
      return m;
    }`;

  // Every lit material of the room's interior, its fittings, the furniture and the balcony.
  function patch(material) {
    if (!n || !material?.isMeshStandardMaterial) return material;
    return patchShader(material, 'window-sun', (shader) => {
      Object.assign(shader.uniforms, uniforms);
      afterVaryings(shader, glsl);
      shader.fragmentShader = editChunk(
        shader.fragmentShader,
        'lights_fragment_begin',
        'getDirectionalLightInfo( directionalLight, directLight );',
        'getDirectionalLightInfo( directionalLight, directLight );\n\t\tdirectLight.color *= windowSun( vRoomPos );',
      );
    });
  }

  return {
    patch,
    // Everything under root, except what's under one of `skip` (the outdoors).
    patchAll(root, skip = []) {
      const walk = (o) => {
        if (skip.includes(o)) return;
        if (o.material) [].concat(o.material).forEach(patch);
        for (const c of o.children) walk(c);
      };
      walk(root);
    },
    get on() {
      return uniforms.wsOn.value > 0.5;
    },
    set on(v) {
      uniforms.wsOn.value = v ? 1 : 0;
    },
    setSun(dir) {
      uniforms.wsDir.value.copy(dir).normalize();
    },
    // The panes (for rays toward the sun: { rect: x0 y0 x1 y1, z }), and how much each lets through.
    panes,
    setPanes(k) {
      k.forEach((v, i) => (uniforms.wsK.value[i] = v));
    },
  };
}

// The glass of the window's sashes and the balcony door (closed, as built), each with the wall
// opening it sits in.
function findPanes(room, win, bal) {
  room.root.updateMatrixWorld(true);
  const panes = [], box = new THREE.Box3();
  room.root.traverse((o) => {
    if (!o.isMesh || o.material !== room.materials.glass) return;
    box.setFromObject(o);
    if (box.max.z > 0) return; // not in the window wall
    const cx = (box.min.x + box.max.x) / 2;
    const inWindow = cx > win.x0 && cx < win.x1;
    panes.push({
      rect: new THREE.Vector4(box.min.x, box.min.y, box.max.x, box.max.y),
      z: (box.min.z + box.max.z) / 2,
      opening: inWindow ? new THREE.Vector4(win.x0, win.y0, win.x1, win.y1) : new THREE.Vector4(bal.x0, 0, bal.x1, bal.y1),
    });
  });
  return panes;
}
