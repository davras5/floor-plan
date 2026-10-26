import * as THREE from 'three';
import { patchShader, editChunk, afterVaryings } from './shader-hooks.js';

// Soft darkening where the room's surfaces meet (wall/floor, wall/ceiling, wall/wall), the
// way light falls off into inside corners. Computed analytically from the room's box in the
// shader, so it costs a few instructions per pixel and no extra render pass.
//
// Each of the six inside planes darkens a surface by strength · e^(−distance / radius),
// weighted by how perpendicular the surface is to that plane (a wall isn't darkened by
// itself). It applies to indirect light and, partly, to the window area lights (which stand
// in for skylight); not to the sun or the lamp, whose light reaches a corner undiminished.

export function cornerAO(box, { radius = 0.22, strength = 0.32, direct = 0.55 } = {}) {
  const uniforms = {
    aoMin: { value: box.min.clone() },
    aoMax: { value: box.max.clone() },
    aoParams: { value: new THREE.Vector3(radius, strength, direct) },
  };

  function hook(shader) {
    Object.assign(shader.uniforms, uniforms);
    afterVaryings(shader, `
      uniform vec3 aoMin, aoMax, aoParams;
      float cornerOcclusion() {
        vec3 p = vRoomPos, n = abs(normalize(vRoomNormal));
        // Only inside the room (outer faces, the balcony and the hallway are left alone).
        if (any(lessThan(p, aoMin - 0.01)) || any(greaterThan(p, aoMax + 0.01))) return 1.0;
        vec3 d0 = max(p - aoMin, 0.0), d1 = max(aoMax - p, 0.0);
        vec3 w = 1.0 - n; // how much each axis' planes can occlude this surface
        vec3 o = w * (exp(-d0 / aoParams.x) + exp(-d1 / aoParams.x));
        return (1.0 - aoParams.y * min(o.x, 1.0)) * (1.0 - aoParams.y * min(o.y, 1.0)) * (1.0 - aoParams.y * min(o.z, 1.0));
      }`);
    // Before the lights: the window area lights are dimmed in corners inside their loop.
    shader.fragmentShader = shader.fragmentShader.replace('#include <lights_fragment_begin>', 'float cornerAo = cornerOcclusion();\n#include <lights_fragment_begin>');
    shader.fragmentShader = editChunk(
      shader.fragmentShader,
      'lights_fragment_begin',
      'rectAreaLight = rectAreaLights[ i ];',
      'rectAreaLight = rectAreaLights[ i ];\n\t\trectAreaLight.color *= mix( 1.0, cornerAo, aoParams.z );',
    );
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <aomap_fragment>',
      '#include <aomap_fragment>\nreflectedLight.indirectDiffuse *= cornerAo;\nreflectedLight.indirectSpecular *= cornerAo;',
    );
  }

  return {
    uniforms,
    apply: (material) => patchShader(material, 'corner-ao', hook),
  };
}
