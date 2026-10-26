import * as THREE from 'three';

// Composable shader patches. three.js gives a material a single onBeforeCompile; several
// modules here patch the same materials (corner darkening, box-projected reflections, shadow
// offsets), so each registers a named hook and they run in order. The program cache key
// lists the hooks, so differently patched materials never share a compiled program.
//
// Clones (the cut-away walls) carry the hooks over via onBeforeCompile/customProgramCacheKey;
// see main.js setCut.

export function patchShader(material, key, hook) {
  const hooks = (material.userData.shaderHooks ??= []);
  if (hooks.some((h) => h.key === key)) return material;
  hooks.push({ key, hook });
  material.onBeforeCompile = (shader, renderer) => {
    for (const h of hooks) h.hook(shader, renderer);
  };
  material.customProgramCacheKey = () => hooks.map((h) => h.key).join('|');
  material.needsUpdate = true;
  return material;
}

// Inlines a shader chunk (if it's still an #include) and replaces `from` with `to` inside it.
// Throws if `from` isn't there, so a three.js upgrade that changes the chunk fails loudly.
export function editChunk(source, chunk, from, to) {
  source = source.replace(`#include <${chunk}>`, THREE.ShaderChunk[chunk]);
  if (!source.includes(from)) throw new Error(`shader patch: "${from}" not found in ${chunk}`);
  return source.replace(from, to);
}

// Room-space position and normal as varyings, for patches that need them. Code that uses
// them goes in with afterVaryings(), which places it below the declarations.
const MARK = '// room varyings';
export function worldVaryings(shader) {
  if (shader.vertexShader.includes('vRoomPos')) return;
  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', '#include <common>\nvarying vec3 vRoomPos;\nvarying vec3 vRoomNormal;')
    .replace(
      '#include <project_vertex>',
      '#include <project_vertex>\nvRoomPos = (modelMatrix * vec4(transformed, 1.0)).xyz;\nvRoomNormal = normalize(mat3(modelMatrix) * objectNormal);',
    );
  shader.fragmentShader = shader.fragmentShader.replace('#include <common>', `#include <common>\nvarying vec3 vRoomPos;\nvarying vec3 vRoomNormal;\n${MARK}`);
}
export function afterVaryings(shader, code) {
  worldVaryings(shader);
  shader.fragmentShader = shader.fragmentShader.replace(MARK, `${MARK}\n${code}`);
}

// Box-projected reflections: the environment was captured from one point, so reflections
// are corrected for where on the floor you look, by intersecting the reflected ray with the
// room's box. Without it the windows' reflections slide across the floor as you walk.
export function boxProjectedReflections(material, box, probe) {
  const uniforms = { envBoxMin: { value: box.min.clone() }, envBoxMax: { value: box.max.clone() }, envProbePos: { value: probe.clone() } };
  return patchShader(material, 'box-projection', (shader) => {
    Object.assign(shader.uniforms, uniforms);
    afterVaryings(shader, `
      uniform vec3 envBoxMin, envBoxMax, envProbePos;
      vec3 boxProject(vec3 pos, vec3 dir) {
        vec3 tA = (envBoxMax - pos) / dir, tB = (envBoxMin - pos) / dir;
        vec3 t = max(tA, tB);
        return pos + dir * min(min(t.x, t.y), t.z) - envProbePos;
      }`);
    shader.fragmentShader = editChunk(
      shader.fragmentShader,
      'envmap_physical_pars_fragment',
      'reflectVec = inverseTransformDirection( reflectVec, viewMatrix );',
      'reflectVec = inverseTransformDirection( reflectVec, viewMatrix );\n\t\t\treflectVec = normalize( boxProject( vRoomPos, reflectVec ) );',
    );
  });
}

// Shifts this material's received sun shadows by `metres` away from the light (curtain
// folds would otherwise shadow themselves as a dotted pattern). range = shadow camera far − near.
export function extraSunShadowBias(material, metres, range) {
  return patchShader(material, `sun-bias-${metres}`, (shader) => {
    shader.fragmentShader = editChunk(
      shader.fragmentShader,
      'lights_fragment_begin',
      'directionalLightShadow.shadowBias,',
      `( directionalLightShadow.shadowBias - ${(metres / range).toFixed(8)} ),`,
    );
  });
}

// No window area lights for this material. They stand in for the sky seen through the window
// and balcony door and face into the room, so outdoors (the neighbourhood, the balcony) they add
// nothing but cost: two lookups and a polygon integral per light per pixel.
export function noAreaLights(material) {
  return patchShader(material, 'no-area-lights', (shader) => {
    shader.fragmentShader = editChunk(shader.fragmentShader, 'lights_fragment_begin', '#if ( NUM_RECT_AREA_LIGHTS > 0 ) && defined( RE_Direct_RectArea )', '#if 0');
  });
}

// No normal offset for this receiver. Walls need it; the floor doesn't (it casts nothing),
// and with it low-sun shadows come loose from the furniture legs.
export function noShadowNormalBias(material) {
  return patchShader(material, 'no-normal-bias', (shader) => {
    shader.vertexShader = editChunk(shader.vertexShader, 'shadowmap_vertex', 'shadowWorldNormal * directionalLightShadows[ i ].shadowNormalBias', 'shadowWorldNormal * 0.0');
  });
}
