import * as THREE from 'three';
import { CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';

// The layout check drawn on the floor while the room card is open (furniture/layout-check.js,
// ui/layout-card.js): the practice zone with the mat in it, and the straight line between the two
// doors as a strip, as in the layout review's plans. Flat tinted planes just above the floor,
// unlit, never picked, never in a light capture (main.js hides the group for those).

const Y = 0.006;

export function createLayoutOverlay() {
  const group = new THREE.Group();
  group.name = 'layout check';
  group.visible = false;

  function plane(color, opacity, order) {
    const mesh = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity, depthWrite: false, toneMapped: false, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 }),
    );
    mesh.raycast = () => {};
    mesh.renderOrder = order;
    mesh.castShadow = mesh.receiveShadow = false;
    mesh.visible = false;
    group.add(mesh);
    return mesh;
  }
  function edge(color) {
    const line = new THREE.LineLoop(
      new THREE.BufferGeometry().setFromPoints([[-0.5, -0.5], [0.5, -0.5], [0.5, 0.5], [-0.5, 0.5]].map(([x, z]) => new THREE.Vector3(x, 0, z))),
      new THREE.LineDashedMaterial({ color, transparent: true, opacity: 0.9, dashSize: 0.08, gapSize: 0.05, toneMapped: false }),
    );
    line.raycast = () => {};
    line.renderOrder = 3;
    line.visible = false;
    group.add(line);
    return line;
  }
  function tag(text) {
    const el = document.createElement('div');
    el.className = 'tag check-tag';
    el.textContent = text;
    el.setAttribute('aria-hidden', 'true'); // the card says it in words
    const obj = new CSS2DObject(el);
    obj.visible = false;
    group.add(obj);
    return obj;
  }

  const zone = plane(0x3f9d63, 0.2, 1), zoneEdge = edge(0x2f7d4b);
  const mat = plane(0x6b5bd2, 0.3, 2);
  const line = plane(0xd0483f, 0.13, 1);
  const zoneTag = tag('practice zone'), lineTag = tag('door to door');

  function fit(mesh, r, y = Y) {
    mesh.position.set((r.x0 + r.x1) / 2, y, (r.z0 + r.z1) / 2);
    mesh.scale.set(r.x1 - r.x0, 1, r.z1 - r.z0);
    mesh.visible = true;
  }
  function outline(line, r, y) {
    line.geometry.setFromPoints([[r.x0, r.z0], [r.x1, r.z0], [r.x1, r.z1], [r.x0, r.z1]].map(([x, z]) => new THREE.Vector3(x, y, z)));
    line.computeLineDistances();
    line.visible = true;
  }

  return {
    group,
    // result: from the layout check, or null for nothing.
    update(result) {
      for (const o of group.children) o.visible = false;
      if (!result) return;
      if (result.zone) {
        fit(zone, result.zone);
        outline(zoneEdge, result.zone, Y + 0.002);
        fit(mat, result.zone.mat, Y + 0.001);
        zoneTag.position.set((result.zone.x0 + result.zone.x1) / 2, Y, result.zone.z0 + 0.18);
        zoneTag.visible = true;
      }
      if (result.line) {
        const { ax, az, bx, bz, width } = result.line;
        const dx = bx - ax, dz = bz - az, len = Math.hypot(dx, dz);
        line.position.set((ax + bx) / 2, Y, (az + bz) / 2);
        line.rotation.y = Math.atan2(-dz, dx); // the plane's x axis along the line
        line.scale.set(len, 1, width);
        line.visible = true;
        lineTag.position.set((ax + bx) / 2, Y, (az + bz) / 2 + 0.9);
        lineTag.visible = true;
      }
    },
    setVisible(on) {
      group.visible = on;
    },
  };
}
