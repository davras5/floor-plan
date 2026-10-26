import * as THREE from 'three';

// Soft contact shadows for the simple render path (no shadow maps): a blurred dark footprint on
// the floor under each piece, so furniture stands on the floor instead of floating over it. One
// small gradient texture for all; each shadow hangs from its piece's pivot, so it moves and turns
// with it and disappears with it. Pieces off the floor (on the windowsill) get none.
export function createContactShadows(furniture) {
  const texture = gradient();
  const material = new THREE.MeshBasicMaterial({
    color: 0x000000, alphaMap: texture, transparent: true, opacity: 0.42, depthWrite: false,
    polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
  });
  const geometry = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
  const shadows = new Map(); // item id → mesh
  let visible = false;

  // After loads, new models and presets: one shadow per piece on the floor, sized to it.
  function sync() {
    for (const item of furniture.items) {
      let mesh = shadows.get(item.id);
      if (item.y || item.home?.place?.y) {
        mesh?.removeFromParent();
        continue;
      }
      if (!mesh) {
        mesh = new THREE.Mesh(geometry, material);
        mesh.name = 'contact shadow';
        mesh.raycast = () => {}; // never picked
        mesh.castShadow = mesh.receiveShadow = false;
        mesh.renderOrder = -1;
        shadows.set(item.id, mesh);
      }
      if (mesh.parent !== item.pivot) item.pivot.add(mesh);
      // The piece's own footprint (a plant's pot, not its leaves), a little larger: the shadow's
      // soft edge reaches past the legs.
      const box = item.local, c = box.getCenter(new THREE.Vector3());
      const w = item.spec.footprint?.width ?? box.max.x - box.min.x, d = item.spec.footprint?.depth ?? box.max.z - box.min.z;
      mesh.scale.set(w + 0.16, 1, d + 0.16);
      mesh.position.set(c.x, 0.002, c.z);
      mesh.visible = visible;
    }
  }

  return {
    sync,
    setVisible(on) {
      visible = on;
      for (const mesh of shadows.values()) mesh.visible = on;
    },
  };
}

// A rounded rectangle that fades out toward its edges (grey: three reads an alpha map's green).
function gradient(size = 64) {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');
  const img = ctx.createImageData(size, size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      // Distance from the centre, in a squared-off metric (a soft box rather than an ellipse).
      const u = Math.abs((x + 0.5) / size * 2 - 1), v = Math.abs((y + 0.5) / size * 2 - 1);
      const r = Math.pow(Math.pow(u, 4) + Math.pow(v, 4), 0.25);
      const a = 1 - THREE.MathUtils.smoothstep(r, 0.45, 1);
      const i = (y * size + x) * 4;
      img.data[i] = img.data[i + 1] = img.data[i + 2] = Math.round(255 * a * a);
      img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.NoColorSpace;
  return texture;
}
