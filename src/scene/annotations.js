import * as THREE from 'three';
import { CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';

// Plan-style annotations drawn just above the floor: dimension chains outside the
// walls, door and window swings, the ceiling-light position, and a measuring cross.

const Y = 0.02;
const fmt = (m) => m.toFixed(2);

export function buildAnnotations(R, layout) {
  const { W, L, T, win, bal, door, frameZ, wideSash, narrowSash, P } = layout;
  const group = new THREE.Group();
  group.name = 'annotations';

  // Dimension lines sit outside the room over the page background, so they follow the theme.
  const lineMat = new THREE.LineBasicMaterial({ color: 0x3a4350 });
  const faintMat = new THREE.LineBasicMaterial({ color: 0x3a4350, transparent: true, opacity: 0.4 });
  // Swings sit on the oak floor, which looks the same in both themes: fixed dark ink.
  const swingMat = new THREE.LineBasicMaterial({ color: 0x2a1d12, transparent: true, opacity: 0.6 });
  const sashMat = new THREE.LineDashedMaterial({ color: 0x2a1d12, transparent: true, opacity: 0.5, dashSize: 0.05, gapSize: 0.035 });

  const v = (x, z, y = Y) => new THREE.Vector3(x, y, z);

  function segments(points, mat, parent = group) {
    const line = new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(points), mat);
    if (mat.isLineDashedMaterial) line.computeLineDistances();
    parent.add(line);
    return line;
  }
  const polyline = (pts) => pts.slice(1).flatMap((p, i) => [pts[i], p]);

  function label(pos, text, { sub, cls = 'dim', parent = group } = {}) {
    const el = document.createElement('div');
    el.className = cls;
    el.textContent = text;
    // Out of context these are just numbers; the screen-reader summary in index.html says it properly.
    el.setAttribute('aria-hidden', 'true');
    if (sub) {
      const s = document.createElement('small');
      s.textContent = sub;
      el.append(s);
    }
    const obj = new CSS2DObject(el);
    obj.position.copy(pos);
    parent.add(obj);
    return obj;
  }

  // Each wall's dimensions live in their own group: in the 3D view they only show
  // when that wall is cut down, so they never float over a standing wall.
  const sides = {};
  for (const name of ['north', 'south', 'west']) {
    sides[name] = new THREE.Group();
    group.add(sides[name]);
  }

  // A chain of dimensions along x (axis 'x') or z (axis 'z').
  // stops: positions along the axis; line: where the dimension line sits; from: the wall face.
  // names: an optional caption per segment, or 'total' for an overall dimension.
  function chain(parent, axis, stops, line, from, names = []) {
    const p = (s, c) => (axis === 'x' ? v(s, c) : v(c, s));
    const out = Math.sign(line - from);
    const main = [p(stops[0], line), p(stops.at(-1), line)];
    const ticks = [], ext = [];
    for (const s of stops) {
      if (axis === 'x') ticks.push(v(s - 0.05, line + 0.05), v(s + 0.05, line - 0.05));
      else ticks.push(v(line - 0.05, s - 0.05), v(line + 0.05, s + 0.05));
      ext.push(p(s, from), p(s, line + out * 0.08));
    }
    segments([...main, ...ticks], lineMat, parent);
    segments(ext, faintMat, parent);
    const last = stops.length - 2;
    for (let i = 0; i <= last; i++) {
      const len = stops[i + 1] - stops[i];
      let s = (stops[i] + stops[i + 1]) / 2;
      // Too short to hold its own label: park it just past the end of the chain.
      if (len < 0.3 && i === last) s = stops[i + 1] + 0.22;
      else if (len < 0.3 && i === 0) s = stops[0] - 0.22;
      if (names === 'total') label(p(s, line), `${fmt(len)} m`, { cls: 'dim total', parent });
      else label(p(s, line), fmt(len), { sub: names[i], parent });
    }
  }

  const uniq = (arr) => [...new Set(arr.map((n) => Math.round(n * 1000) / 1000))].sort((a, b) => a - b);
  const near = (a, b) => Math.abs(a - b) < 1e-3;

  // Window wall: chain of wall / window / balcony door / wall, plus the overall width.
  const northStops = uniq([0, win.x0, win.x1, bal.x0, bal.x1, W]);
  const northNames = northStops.slice(0, -1).map((s) => (near(s, win.x0) ? 'window' : near(s, bal.x0) ? 'balcony door' : ''));
  const northLine = -T.north - R.balcony.depth - 0.3;
  chain(sides.north, 'x', northStops, northLine, -T.north, northNames);
  chain(sides.north, 'x', [0, W], northLine - 0.5, -T.north, 'total');

  // Entry-door wall.
  const southStops = uniq([0, door.x0, door.x1, W]);
  chain(sides.south, 'x', southStops, L + T.south + 0.4, L + T.south, southStops.slice(0, -1).map((s) => (near(s, door.x0) ? 'entry door' : '')));

  // Long wall, overall.
  chain(sides.west, 'z', [0, L], -T.west - 0.45, -T.west, 'total');

  // Door swings (into the room).
  const arc = (cx, cz, r, a0, a1, n = 32) =>
    Array.from({ length: n + 1 }, (_, i) => {
      const a = a0 + ((a1 - a0) * i) / n;
      return v(cx + r * Math.cos(a), cz + r * Math.sin(a));
    });
  {
    const r = door.width;
    segments([...polyline(arc(door.x1, L, r, Math.PI, Math.PI * 1.5)), v(door.x1, L), v(door.x1, L - r)], swingMat);
  }
  {
    const hx = bal.x1 - P, r = bal.x1 - bal.x0 - 2 * P;
    segments([...polyline(arc(hx, frameZ, r, Math.PI, Math.PI / 2)), v(hx, frameZ), v(hx, frameZ + r)], swingMat);
  }
  // Window sashes open inward above the sill: dashed, so you can see what a tall piece under the window would block.
  {
    const r = wideSash.x1 - wideSash.x0;
    segments(polyline(arc(wideSash.x1, frameZ, r, Math.PI, Math.PI / 2)), sashMat);
    const rn = narrowSash.x1 - narrowSash.x0;
    segments(polyline(arc(narrowSash.x0, frameZ, rn, 0, Math.PI / 2)), sashMat);
  }

  // Ceiling light: the usual plan symbol, a circle with a cross.
  {
    const { x, z } = R.ceilingOutlet, r = 0.13;
    const circle = arc(x, z, r, 0, Math.PI * 2, 40);
    segments([...polyline(circle), v(x - r, z - r), v(x + r, z + r), v(x - r, z + r), v(x + r, z - r)], swingMat);
    label(v(x, z + 0.3), 'ceiling light', { cls: 'tag' });
  }

  // Measuring cross: lines from a picked floor point to all four walls.
  const measure = new THREE.Group();
  measure.visible = false;
  const measureMat = new THREE.LineBasicMaterial({ color: 0x14100c, transparent: true, opacity: 0.75 });
  const measureLines = segments(new Array(8).fill(0).map(() => new THREE.Vector3()), measureMat, measure);
  measureLines.frustumCulled = false; // its bounds change on every move
  const dot = new THREE.Mesh(new THREE.RingGeometry(0.035, 0.06, 32), new THREE.MeshBasicMaterial({ color: 0x14100c }));
  dot.rotation.x = -Math.PI / 2;
  measure.add(dot);

  return {
    group,
    sides,
    measure,
    setLineColor(color) {
      lineMat.color.set(color);
      faintMat.color.set(color);
    },
    showMeasure(x, z) {
      const y = Y + 0.003;
      const pts = [[0, z], [W, z], [x, 0], [x, L]].flatMap(([ex, ez]) => [new THREE.Vector3(x, y, z), new THREE.Vector3(ex, y, ez)]);
      measureLines.geometry.setFromPoints(pts);
      dot.position.set(x, y + 0.001, z);
      measure.visible = true;
    },
    hideMeasure() {
      measure.visible = false;
    },
  };
}
