import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { parquetTextureAsync, PARQUET_AVERAGE, tileTexture, concreteTexture } from './textures.js';
import { cornerAO } from '../lighting/corner-ao.js';
import { boxProjectedReflections, noShadowNormalBias, noAreaLights } from '../lighting/shader-hooks.js';

// Where the room's light probe sits (indirect.js): the middle of the room, at 1.2 m. The
// ceiling has its own, just below it (see main.js).
export const PROBE = (R) => new THREE.Vector3(R.width / 2, 1.2, R.length / 2);
export const CEILING_PROBE = (R) => new THREE.Vector3(R.width / 2, R.height - 0.3, R.length / 2);

// Builds the empty room (walls, openings, fixtures) from the measurements in config.js.
// Each wall is its own group so the 3D view can cut it down when it blocks the camera.

// Heights where walls are cut: down to a low stub in the 3D view, and the plan's section.
export const SECTION = { stub: 0.12, plan: 1.2 };

// options: anisotropy (texture filtering) and floorDetail (px per metre of the parquet), from
// the rendering quality; setFloorDetail() changes the latter later.
export function buildRoom(R, renderer, { anisotropy, floorDetail = 400 } = {}) {
  const W = R.width, L = R.length, H = R.height, T = R.wallThickness;
  const aniso = Math.min(anisotropy ?? Infinity, renderer.capabilities.getMaxAnisotropy());
  const M = createMaterials(R, aniso);
  // The parquet is generated after the first frame (it takes a while on phones); until then the
  // floor shows its average colour through a 1 px stand-in, so its shader is the same either way.
  let floorPpm = 0, floorJob = null;
  function setFloorDetail(ppm) {
    if (ppm === floorPpm) return floorJob;
    floorPpm = ppm;
    const job = (floorJob = parquetTextureAsync(R.width, R.length, ppm).then((tex) => {
      if (job !== floorJob) return tex.dispose(); // superseded by another size
      tex.anisotropy = M.floor.map.anisotropy;
      const old = M.floor.map;
      M.floor.map = tex;
      old.dispose();
      return tex;
    }));
    return job;
  }
  setFloorDetail(floorDetail);
  const roomBox = new THREE.Box3(new THREE.Vector3(0, 0, 0), new THREE.Vector3(R.width, R.height, R.length));
  const ao = cornerAO(roomBox);
  for (const m of [M.wall, M.ceiling, M.floor]) ao.apply(m);
  // The lacquer reflects the room's light probe (indirect.js, captured at PROBE); box-projected
  // so the windows' reflections stay put on the floor as you move.
  boxProjectedReflections(M.floor, roomBox, PROBE(R));
  noShadowNormalBias(M.floor);
  // The balcony is outside, behind the window's area lights (which shine one way, into the room).
  for (const m of [M.concrete, M.parapet, M.capping, M.screen, M.soffit, M.awning]) noAreaLights(m);

  // Positions derived from the config, in room coordinates.
  const frameZ = -R.window.reveal; // room-side face of the window and balcony-door frames
  const win = { x0: R.window.offset, x1: R.window.offset + R.window.width, y0: R.window.sill, y1: R.window.head };
  const bal = { x0: R.balconyDoor.offset, x1: R.balconyDoor.offset + R.balconyDoor.width, y1: R.balconyDoor.head };
  const door = { x1: W - R.entryDoor.offsetFromEast, width: R.entryDoor.width, height: R.entryDoor.height };
  door.x0 = door.x1 - door.width;
  door.cx = (door.x0 + door.x1) / 2;

  // Visible face widths (m) of the outer frames, as measured in the photos: t(op), b(ottom), l(eft), r(ight).
  const WF = { t: 0.045, b: 0.06, l: 0.06, r: 0.063 }; // window
  const BF = { t: 0.045, b: 0.03, l: 0.035, r: 0.055 }; // balcony door (b = threshold)
  const P = BF.r; // balcony-door frame on the hinge side (the annotations' swing arc starts here)
  const lining = 0.02, casing = R.entryDoor.casing ?? 0.07, casingT = 0.012;
  const sillT = 0.025;
  // The two window sashes meet at one joint (no mullion): narrow one hinged left, wide one hinged right.
  const meetX = win.x0 + R.window.leftSash;
  const wideSash = { x0: meetX, x1: win.x1 - WF.r };
  const narrowSash = { x0: win.x0 + WF.l, x1: meetX };

  const layout = { W, L, H, T, frameZ, win, bal, door, P, wideSash, narrowSash };

  const root = new THREE.Group();
  root.name = 'room';

  // Floor. The walls run a little below it and a little above the ceiling, so the
  // room's inside corners are always backed by wall (no hairline gaps along the edges).
  const base = -0.22, wallTop = H + 0.02;
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(W, L), M.floor);
  floor.rotation.x = -Math.PI / 2;
  floor.position.set(W / 2, 0, L / 2);
  floor.receiveShadow = true;
  floor.name = 'floor';
  root.add(floor);

  // ---- Walls -------------------------------------------------------------
  // Each wall also gets flat black section caps: one at the height the 3D view cuts walls
  // down to, one at the plan's cut height. They live outside the wall's group so cutting
  // the wall (which clips its materials) never clips the caps.
  const walls = [];
  const caps = new THREE.Group();
  caps.name = 'section caps';
  root.add(caps);
  function wall(name, spec, outside) {
    const group = new THREE.Group();
    group.name = `${name}-wall`;
    const cells = wallCells({ ...spec, base, height: wallTop });
    const mesh = new THREE.Mesh(wallGeometry(cells), M.wall);
    mesh.castShadow = mesh.receiveShadow = true;
    group.add(mesh);
    root.add(group);
    const cap = (y) => {
      const m = new THREE.Mesh(sectionGeometry(cells, y - 0.0005), M.section);
      m.visible = false;
      caps.add(m);
      return m;
    };
    const w = { name, group, outside, cut: false, caps: { stub: cap(SECTION.stub), plan: cap(SECTION.plan) } };
    walls.push(w);
    return group;
  }

  const north = wall('north', {
    axis: 'x', s0: -T.west, s1: W + T.east, c0: -T.north, c1: 0,
    openings: [
      { from: win.x0, to: win.x1, bottom: win.y0 - sillT, top: win.y1 },
      { from: bal.x0, to: bal.x1, bottom: 0, top: bal.y1 },
    ],
  }, (p) => p.z < 0);

  const south = wall('south', {
    axis: 'x', s0: -T.west, s1: W + T.east, c0: L, c1: L + T.south,
    openings: [{ from: door.x0 - lining, to: door.x1 + lining, bottom: 0, top: door.height + lining }],
  }, (p) => p.z > L);

  // The long walls tuck 1 cm into the end walls, and the ceiling 1 cm into all four,
  // so no two surfaces ever share a plane (which shows up as flickering dotted edges).
  const tuck = 0.01;
  const west = wall('west', { axis: 'z', s0: -tuck, s1: L + tuck, c0: -T.west, c1: 0, openings: [] }, (p) => p.x < 0);
  const east = wall('east', { axis: 'z', s0: -tuck, s1: L + tuck, c0: W, c1: W + T.east, openings: [] }, (p) => p.x > W);

  // Ceiling: treated like a fifth wall that is cut whenever the camera is above it.
  const ceiling = new THREE.Group();
  ceiling.name = 'ceiling';
  {
    const geo = new THREE.BoxGeometry(W + 2 * tuck, 0.18, L + 2 * tuck);
    geo.translate(W / 2, H + 0.09, L / 2);
    const mesh = new THREE.Mesh(geo, M.ceiling);
    mesh.castShadow = mesh.receiveShadow = true;
    ceiling.add(mesh);
    // Ceiling outlet where the pendant hangs.
    const canopy = new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.06, 0.03, 32), M.frame);
    canopy.position.set(R.ceilingOutlet.x, H - 0.015, R.ceilingOutlet.z);
    // Everything that's lit by the sun must also receive its shadow, or it's sunlit through
    // the walls (a sunny side that swings round with the time of day).
    canopy.receiveShadow = true;
    ceiling.add(canopy);
    root.add(ceiling);
    walls.push({ name: 'ceiling', group: ceiling, outside: (p) => p.y > H, cut: false });
  }

  // ---- Baseboards (oak, as in the photos) --------------------------------
  const bh = R.baseboard.height, bt = R.baseboard.thickness;
  const doorEdgeW = door.x0 - lining - casing, doorEdgeE = door.x1 + lining + casing;
  for (const [a, b] of [[0, bal.x0], [bal.x1, W]]) addBox(north, M.oak, b - a, bh, bt, (a + b) / 2, bh / 2, bt / 2);
  for (const [a, b] of [[0, doorEdgeW], [doorEdgeE, W]]) addBox(south, M.oak, b - a, bh, bt, (a + b) / 2, bh / 2, L - bt / 2);
  addBox(west, M.oak, bt, bh, L, bt / 2, bh / 2, L / 2);
  addBox(east, M.oak, bt, bh, L, W - bt / 2, bh / 2, L / 2);

  // ---- Window: two sashes meeting in the middle (no mullion), wooden sill ----
  // As in the photos: a narrow left sash hinged on the left with no handle of its own (its
  // lever sits in the meeting edge), and a wide right sash hinged on the right whose handle is
  // on the meeting stile.
  const zf1 = frameZ, zf0 = frameZ - 0.07;
  rectFrame(north, M.frame, win.x0, win.x1, win.y0, win.y1, WF, zf0, zf1);
  const sy0 = win.y0 + WF.b, sy1 = win.y1 - WF.t, joint = 0.004;
  // Each sash turns inward on its own hinge (its outer edge, on the room face), like the doors.
  const sashPivot = (x) => {
    const pivot = new THREE.Group();
    pivot.position.set(x, 0, zf1 + 0.008);
    north.add(pivot);
    return pivot;
  };
  const narrowPivot = sashPivot(narrowSash.x0), widePivot = sashPivot(wideSash.x1);
  sash(narrowPivot, 0, narrowSash.x1 - joint / 2 - narrowSash.x0, sy0, sy1, -0.008, { t: 0.07, b: 0.08, l: 0.084, r: 0.068 });
  sash(widePivot, wideSash.x0 + joint / 2 - wideSash.x1, 0, sy0, sy1, -0.008, { t: 0.07, b: 0.08, l: 0.085, r: 0.084 },
    { x: wideSash.x0 + 0.045 - wideSash.x1, y: R.window.handle });
  // The meeting joint reads as a thin shadowed groove: a strip set back behind the gap.
  addBox(north, M.frame, 0.02, sy1 - sy0, 0.01, meetX, (sy0 + sy1) / 2, zf1 - 0.06);
  const sillOut = R.window.sillDepth ?? 0.035;
  addBox(north, M.oak, win.x1 - win.x0 + 0.04, sillT, sillOut - frameZ,
    (win.x0 - 0.04 + win.x1) / 2, win.y0 - sillT / 2, (frameZ + sillOut) / 2);

  // ---- Balcony door: its own frame, coupled to the window's right side; ----
  // ---- one sash, hinged on the right, opens inward, solid panel at the foot.
  rectFrame(north, M.frame, bal.x0, bal.x1, 0, bal.y1, BF, zf0, zf1);
  const balPivot = new THREE.Group();
  balPivot.position.set(bal.x1 - BF.r, BF.b, zf1 + 0.008);
  north.add(balPivot);
  balconySash(balPivot, bal.x1 - bal.x0 - BF.l - BF.r, bal.y1 - BF.t - BF.b, R.balconyDoor.panel - BF.b, R.balconyDoor.handle - BF.b);

  // ---- Curtain rail, corner pipe -----------------------------------------
  const cr = R.curtainRail;
  addBox(north, M.frame, cr.to - cr.from, 0.025, 0.05, (cr.from + cr.to) / 2, cr.height, 0.055);
  for (const x of [cr.from + 0.08, (cr.from + cr.to) / 2, cr.to - 0.08]) {
    addBox(north, M.frame, 0.025, 0.04, 0.035, x, cr.height + 0.03, 0.0175);
  }
  const pipe = new THREE.Mesh(new THREE.CylinderGeometry(0.016, 0.016, H, 16), M.frame);
  pipe.position.set(R.pipeX, H / 2, 0.03);
  pipe.castShadow = pipe.receiveShadow = true;
  north.add(pipe);

  // ---- Entry door: frame, casings, leaf hinged on the right, swings in ---
  const dh = door.height;
  addBox(south, M.frame, lining, dh + lining, T.south, door.x0 - lining / 2, (dh + lining) / 2, L + T.south / 2);
  addBox(south, M.frame, lining, dh + lining, T.south, door.x1 + lining / 2, (dh + lining) / 2, L + T.south / 2);
  addBox(south, M.frame, door.width + 2 * lining, lining, T.south, door.cx, dh + lining / 2, L + T.south / 2);
  for (const zc of [L - casingT / 2, L + T.south + casingT / 2]) {
    const ch = dh + lining + casing;
    addBox(south, M.frame, casing, ch, casingT, door.x0 - lining - casing / 2, ch / 2, zc);
    addBox(south, M.frame, casing, ch, casingT, door.x1 + lining + casing / 2, ch / 2, zc);
    addBox(south, M.frame, door.width + 2 * (lining + casing), casing, casingT, door.cx, dh + lining + casing / 2, zc);
  }
  addBox(south, M.oak, door.width, 0.008, T.south, door.cx, 0.004, L + T.south / 2, { cast: false });

  const leafW = door.width - 0.004, leafH = dh - 0.012, leafT = 0.04;
  const doorPivot = new THREE.Group();
  doorPivot.position.set(door.x1 - 0.002, 0.008, L + 0.004);
  south.add(doorPivot);
  addBox(doorPivot, M.leaf, leafW, leafH, leafT, -leafW / 2, leafH / 2, leafT / 2);
  for (const side of [-1, 1]) lever(doorPivot, -leafW + 0.065, 1.05 - 0.008, side < 0 ? 0 : leafT, side);

  // Light switch just left of the door, as seen from inside (its plate is ~7 cm clear of the frame).
  const swX = doorEdgeW - 0.11;
  addBox(south, M.frame, 0.085, 0.085, 0.012, swX, R.switchHeight, L - 0.006);
  addBox(south, M.handle, 0.05, 0.05, 0.006, swX, R.switchHeight, L - 0.015);

  // ---- Hallway stub beyond the entry door (Walk view only) ---------------
  const hallway = new THREE.Group();
  hallway.name = 'hallway';
  {
    const hw = R.hallway.width, hd = R.hallway.depth, z0 = L + T.south;
    const f = new THREE.Mesh(new THREE.PlaneGeometry(hw, hd), M.tiles);
    f.rotation.x = -Math.PI / 2;
    f.position.set(door.cx, 0.002, z0 + hd / 2);
    f.receiveShadow = true;
    hallway.add(f);
    // It can't shade the room (it's behind the door wall, away from the window), so it casts no
    // shadows: that keeps the shadow maps the same in every view, and view switches cheap.
    const noCast = { cast: false };
    addBox(hallway, M.hallWall, 0.1, H, hd, door.cx - hw / 2 - 0.05, H / 2, z0 + hd / 2, noCast);
    addBox(hallway, M.hallWall, 0.1, H, hd, door.cx + hw / 2 + 0.05, H / 2, z0 + hd / 2, noCast);
    addBox(hallway, M.hallWall, hw + 0.2, H, 0.1, door.cx, H / 2, z0 + hd + 0.05, noCast);
    addBox(hallway, M.ceiling, hw + 0.2, 0.1, hd + 0.1, door.cx, H + 0.05, z0 + hd / 2, noCast);
    hallway.visible = false;
    root.add(hallway);
  }

  // ---- Balcony outside the window wall -----------------------------------
  // As in the photos taken on it: a concrete slab a step below the room, inside a solid parapet
  // along the front and a short side one at the right-hand end, both under the same dark metal
  // cover. A grey-green metal screen on the party-wall line parts it from the neighbour's
  // balcony; it goes with the left-hand wall, so the 3D view cuts it down with that wall. The
  // balcony above (its slab, and an awning's cassette under the front edge) is the roof, shown
  // with the outdoors; its shade comes from lighting/window-sun.js. The parapet and the screen
  // cast shadows (a few boxes), so the balcony floor isn't sunlit right up to them.
  const balcony = new THREE.Group();
  balcony.name = 'balcony';
  const balconyRoof = new THREE.Group();
  balconyRoof.name = 'balcony above';
  {
    const B = R.balcony, drop = B.drop, t = B.wall, cap = 0.05, top = B.parapet - drop;
    const x0 = -T.west, x1 = B.to, z1 = -T.north, z0 = z1 - B.depth; // party wall → side parapet, facade → front
    const noCast = { cast: false };
    addBox(balcony, M.concrete, x1 - x0, 0.18, B.depth, (x0 + x1) / 2, -drop - 0.09, (z0 + z1) / 2, noCast);
    M.concrete.map.repeat.set(x1 - x0, B.depth); // the texture tiles every metre
    // Parapet walls, up to their capping: along the front, and the side one back to the facade.
    const wh = top - cap + drop, wy = (top - cap - drop) / 2;
    addBox(balcony, M.parapet, x1 - x0, wh, t, (x0 + x1) / 2, wy, z0 + t / 2);
    addBox(balcony, M.parapet, t, wh, z1 - z0 - t, x1 - t / 2, wy, (z0 + t + z1) / 2);
    // Both parapets wear the same metal cover: 2 cm proud of both faces along the front, running
    // into the side's, which is a little thicker and 3–4 cm proud.
    addBox(balcony, M.capping, x1 - t - x0, cap, t + 0.04, (x0 + x1 - t) / 2, top - cap / 2, z0 + t / 2);
    addBox(balcony, M.capping, t + 0.07, cap + 0.015, z1 - z0 + 0.03, x1 - t / 2 - 0.005, top + 0.01 - (cap + 0.015) / 2, (z0 - 0.03 + z1) / 2);

    // The screen: a 4 cm panel standing 5 cm clear of the floor, from the facade to the front of
    // the parapet, its top outer corner rounded. Outlined in (out from the facade, up).
    const sl = B.depth - 0.01, sh = B.screen - 0.05, r = 0.18;
    const outline = new THREE.Shape();
    outline.moveTo(0, 0);
    outline.lineTo(sl, 0);
    outline.lineTo(sl, sh - r);
    outline.absarc(sl - r, sh - r, r, 0, Math.PI / 2, false);
    outline.lineTo(0, sh);
    outline.closePath();
    const screenGeo = new THREE.ExtrudeGeometry(outline, { depth: 0.04, bevelEnabled: false, curveSegments: 6 });
    screenGeo.rotateY(Math.PI / 2); // outline x → −z (outward), the extrusion → +x
    screenGeo.translate(-T.west / 2 - 0.02, 0.05 - drop, z1);
    const screen = new THREE.Mesh(screenGeo, M.screen);
    screen.castShadow = screen.receiveShadow = true;
    screen.name = 'balcony screen';
    west.add(screen);

    // The balcony above, as deep as this one: only its underside and front edge are ever seen.
    const roof = { cast: false, receive: false };
    addBox(balconyRoof, M.soffit, x1 - x0, 0.18, B.depth, (x0 + x1) / 2, B.soffit + 0.09, (z0 + z1) / 2, roof);
    addBox(balconyRoof, M.awning, x1 - x0 - 0.1, 0.13, 0.15, (x0 + x1) / 2, B.soffit - 0.065, z0 + 0.12, roof);
    root.add(balcony);
  }

  // ---- Outdoors: sky, ground, a few trees (Walk view only) ---------------
  const outdoors = buildOutdoors(W, L, T);
  outdoors.group.visible = false;
  root.add(outdoors.group);
  outdoors.group.add(balconyRoof); // the balcony above, which would only hide the room from above

  // ---- Doors that open and close ------------------------------------------
  // Everything that swings open, by what it belongs to (the window's two sashes open together).
  const doors = [
    { id: 'door', pivot: doorPivot, sign: -1, angle: 0, open: false, openAngle: THREE.MathUtils.degToRad(92) },
    { id: 'balcony-door', pivot: balPivot, sign: 1, angle: 0, open: false, openAngle: THREE.MathUtils.degToRad(86) },
    { id: 'window', pivot: narrowPivot, sign: -1, angle: 0, open: false, openAngle: THREE.MathUtils.degToRad(80) },
    { id: 'window', pivot: widePivot, sign: 1, angle: 0, open: false, openAngle: THREE.MathUtils.degToRad(80) },
  ];

  // floorReady(): resolves when the current parquet texture is on the floor.
  // The room is built from about 130 small boxes. Drawn one by one, that's a draw call each, in
  // every frame and 18 times in every light capture. Within each wall, door, sash and the
  // balcony, boxes of the same material are merged (moving parts keep their own pivot).
  for (const g of [north, south, west, east, ceiling, hallway, balcony, doorPivot, narrowPivot, widePivot, balPivot]) mergeBoxes(g);

  return { root, floor, walls, hallway, balcony, outdoors, doors, layout, materials: M, setFloorDetail, floorReady: () => floorJob };

  // ---- helpers that need the materials ------------------------------------

  // A window sash: frame with per-side widths w = { t, b, l, r }, glass, and optionally a handle { x, y }.
  function sash(parent, x0, x1, y0, y1, zFace, w, handle) {
    const z0 = zFace - 0.065, z1 = zFace + 0.008;
    rectFrame(parent, M.frame, x0, x1, y0, y1, w, z0, z1);
    // The glass sits ~2 cm behind the sash's room face (glazing bead), not in the middle of its depth.
    glass(parent, x1 - x0 - w.l - w.r + 0.01, y1 - y0 - w.t - w.b + 0.01,
      (x0 + w.l + x1 - w.r) / 2, (y0 + w.b + y1 - w.t) / 2, z1 - 0.022);
    if (handle) windowHandle(parent, handle.x, handle.y, z1);
  }

  function balconySash(pivot, w, h, panelTop, handleY) {
    // Local coordinates: hinge at x = 0, sash extends to -x, frame depth behind z = 0.
    // Narrow stile on the handle side, wide one on the hinge side (as in the photos).
    const z0 = -0.073, z1 = 0, zm = (z0 + z1) / 2, d = z1 - z0;
    const top = 0.075, bottomRail = 0.11, hingeStile = 0.12, handleStile = 0.05, midRail = 0.06;
    const sh = h - top - bottomRail, sy = bottomRail + sh / 2;
    const inner = w - hingeStile - handleStile, ix = -hingeStile - inner / 2;
    addBox(pivot, M.frame, w, top, d, -w / 2, h - top / 2, zm);
    addBox(pivot, M.frame, w, bottomRail, d, -w / 2, bottomRail / 2, zm);
    addBox(pivot, M.frame, handleStile, sh, d, -w + handleStile / 2, sy, zm);
    addBox(pivot, M.frame, hingeStile, sh, d, -hingeStile / 2, sy, zm);
    addBox(pivot, M.frame, inner, midRail, d, ix, panelTop + midRail / 2, zm); // mid rail
    // Solid panel, with a raised field inside a 3 cm border.
    const ph = panelTop - bottomRail;
    addBox(pivot, M.frame, inner, ph, 0.03, ix, bottomRail + ph / 2, zm);
    addBox(pivot, M.frame, inner - 0.06, ph - 0.06, 0.04, ix, bottomRail + ph / 2, zm);
    const gy0 = panelTop + midRail, gy1 = h - top;
    glass(pivot, inner + 0.01, gy1 - gy0 + 0.01, ix, (gy0 + gy1) / 2, z1 - 0.022);
    windowHandle(pivot, -w + handleStile / 2, handleY, z1);
  }

  function glass(parent, w, h, x, y, z) {
    const m = addBox(parent, M.glass, w, h, 0.006, x, y, z, { cast: false, receive: false });
    m.renderOrder = 2;
  }

  function windowHandle(parent, x, y, z) {
    addBox(parent, M.handle, 0.032, 0.075, 0.012, x, y, z + 0.006);
    addBox(parent, M.handle, 0.02, 0.12, 0.02, x, y - 0.045, z + 0.03);
  }

  function lever(parent, x, y, zFace, side) {
    // side -1 = room face (z = 0 of the leaf), +1 = hallway face.
    const rose = new THREE.Mesh(new THREE.CylinderGeometry(0.026, 0.026, 0.012, 24), M.steel);
    rose.rotation.x = Math.PI / 2;
    rose.position.set(x, y, zFace + side * 0.006);
    const neck = new THREE.Mesh(new THREE.CylinderGeometry(0.009, 0.009, 0.05, 12), M.steel);
    neck.rotation.x = Math.PI / 2;
    neck.position.set(x, y, zFace + side * 0.03);
    const bar = new THREE.Mesh(new THREE.BoxGeometry(0.13, 0.019, 0.019), M.steel);
    bar.position.set(x + 0.058, y, zFace + side * 0.052);
    const key = new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.018, 0.01, 20), M.steel);
    key.rotation.x = Math.PI / 2;
    key.position.set(x, y - 0.1, zFace + side * 0.005);
    for (const m of [rose, neck, bar, key]) {
      m.castShadow = m.receiveShadow = true;
      parent.add(m);
    }
  }
}

// A wall as a grid of cells around its openings. Coordinates are world metres: s runs
// along the wall (x or z), c across its thickness, y up. The grid is split through every
// opening edge, so neighbouring cells share whole edges (no hairline cracks).
function wallCells({ axis, s0, s1, c0, c1, openings, base, height }) {
  const breaks = (vals) => [...new Set(vals.map((n) => Math.round(n * 1e4) / 1e4))].sort((a, b) => a - b);
  const ss = breaks([s0, s1, ...openings.flatMap((o) => [o.from, o.to])]);
  const ys = breaks([base, 0, height, ...openings.flatMap((o) => [o.bottom, o.top])]);
  const ni = ss.length - 1, nj = ys.length - 1;
  const solid = (i, j) => {
    if (i < 0 || j < 0 || i >= ni || j >= nj) return false;
    const sm = (ss[i] + ss[i + 1]) / 2, ym = (ys[j] + ys[j + 1]) / 2;
    return !openings.some((o) => sm > o.from && sm < o.to && ym > o.bottom && ym < o.top);
  };
  const toWorld = (s, y, c) => (axis === 'x' ? [s, y, c] : [c, y, s]);
  return { ss, ys, ni, nj, solid, c0, c1, toWorld };
}

// The flat cross-section of a wall at height y: what a saw cut would expose.
function sectionGeometry({ ss, ys, ni, nj, solid, c0, c1, toWorld }, y) {
  const j = ys.findIndex((v, k) => k < nj && y >= v && y < ys[k + 1]);
  const pos = [];
  for (let i = 0; i < ni; i++) {
    if (j < 0 || !solid(i, j)) continue;
    const q = [[ss[i], c0], [ss[i], c1], [ss[i + 1], c1], [ss[i + 1], c0]].map(([s, c]) => toWorld(s, y, c));
    for (const k of [0, 1, 2, 0, 2, 3]) pos.push(...q[k]); // the cap material is double-sided
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  return geo;
}

// One wall as a single closed mesh: side faces are only emitted where a cell borders an
// opening or the wall's end, so there are no hidden internal faces to flicker through.
function wallGeometry({ ss, ys, ni, nj, solid, c0, c1, toWorld }) {
  const pos = [], nrm = [];
  const tmpA = new THREE.Vector3(), tmpB = new THREE.Vector3(), tmpN = new THREE.Vector3();
  // corners in (s, y, c); normal in (s, y, c) too
  function quad(corners, normal) {
    const p = corners.map((q) => new THREE.Vector3(...toWorld(...q)));
    const n = new THREE.Vector3(...toWorld(...normal));
    tmpA.subVectors(p[1], p[0]);
    tmpB.subVectors(p[2], p[0]);
    if (tmpN.crossVectors(tmpA, tmpB).dot(n) < 0) p.reverse();
    for (const k of [0, 1, 2, 0, 2, 3]) {
      pos.push(p[k].x, p[k].y, p[k].z);
      nrm.push(n.x, n.y, n.z);
    }
  }

  for (let i = 0; i < ni; i++) {
    for (let j = 0; j < nj; j++) {
      if (!solid(i, j)) continue;
      const a = ss[i], b = ss[i + 1], y0 = ys[j], y1 = ys[j + 1];
      quad([[a, y0, c1], [b, y0, c1], [b, y1, c1], [a, y1, c1]], [0, 0, 1]);
      quad([[a, y0, c0], [b, y0, c0], [b, y1, c0], [a, y1, c0]], [0, 0, -1]);
      if (!solid(i - 1, j)) quad([[a, y0, c0], [a, y0, c1], [a, y1, c1], [a, y1, c0]], [-1, 0, 0]);
      if (!solid(i + 1, j)) quad([[b, y0, c0], [b, y0, c1], [b, y1, c1], [b, y1, c0]], [1, 0, 0]);
      if (!solid(i, j - 1)) quad([[a, y0, c0], [b, y0, c0], [b, y0, c1], [a, y0, c1]], [0, -1, 0]);
      if (!solid(i, j + 1)) quad([[a, y1, c0], [b, y1, c0], [b, y1, c1], [a, y1, c1]], [0, 1, 0]);
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  return geo;
}

// A rectangular frame. p is one width for all four sides, or per side: { t, b, l, r }.
function rectFrame(parent, mat, x0, x1, y0, y1, p, z0, z1, bottom) {
  const s = typeof p === 'number' ? { t: p, b: bottom ?? p, l: p, r: p } : p;
  const d = z1 - z0, zm = (z0 + z1) / 2, w = x1 - x0, xm = (x0 + x1) / 2;
  addBox(parent, mat, w, s.t, d, xm, y1 - s.t / 2, zm);
  addBox(parent, mat, w, s.b, d, xm, y0 + s.b / 2, zm);
  const jh = y1 - y0 - s.t - s.b, jy = y0 + s.b + jh / 2;
  addBox(parent, mat, s.l, jh, d, x0 + s.l / 2, jy, zm);
  addBox(parent, mat, s.r, jh, d, x1 - s.r / 2, jy, zm);
}

// Merges a group's own meshes (not its subgroups') that share a material, shadow flags and draw
// order into one mesh each.
function mergeBoxes(group) {
  const bins = new Map();
  for (const m of group.children) {
    if (!m.isMesh || !m.geometry.index) continue;
    const key = `${m.material.uuid}|${m.castShadow}|${m.receiveShadow}|${m.renderOrder}`;
    if (!bins.has(key)) bins.set(key, []);
    bins.get(key).push(m);
  }
  for (const list of bins.values()) {
    if (list.length < 2) continue;
    const geometry = mergeGeometries(list.map((m) => {
      m.updateMatrix();
      return m.geometry.clone().applyMatrix4(m.matrix);
    }));
    if (!geometry) continue;
    const [first] = list;
    const merged = new THREE.Mesh(geometry, first.material);
    merged.castShadow = first.castShadow;
    merged.receiveShadow = first.receiveShadow;
    merged.renderOrder = first.renderOrder;
    merged.name = `${group.name || 'part'} · ${first.material.name || first.material.type} × ${list.length}`;
    for (const m of list) {
      group.remove(m);
      m.geometry.dispose();
    }
    group.add(merged);
  }
}

function addBox(parent, mat, sx, sy, sz, x, y, z, { cast = true, receive = true } = {}) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(sx, sy, sz), mat);
  m.position.set(x, y, z);
  m.castShadow = cast;
  m.receiveShadow = receive;
  parent.add(m);
  return m;
}

function createMaterials(R, aniso) {
  const parquet = new THREE.DataTexture(new Uint8Array([...PARQUET_AVERAGE, 255]), 1, 1);
  parquet.colorSpace = THREE.SRGBColorSpace;
  parquet.anisotropy = aniso;
  parquet.needsUpdate = true;
  const tiles = tileTexture(R.hallway.width, R.hallway.depth);
  tiles.anisotropy = aniso;

  return {
    // The shell casts shadows from both faces, so the depth stored for a sunbeam is the slab's
    // outside face, 15–30 cm away: no light creeps in along wall/ceiling/floor junctions.
    // dithering: the big smooth gradients on white walls and ceiling would show 8-bit banding.
    wall: new THREE.MeshStandardMaterial({ color: 0xf2f0eb, roughness: 0.93, shadowSide: THREE.DoubleSide, dithering: true }),
    ceiling: new THREE.MeshStandardMaterial({ color: 0xf6f5f1, roughness: 0.95, shadowSide: THREE.DoubleSide, dithering: true }),
    // Oiled/lacquered oak: one satin lacquer layer (the clearcoat) over matte wood. The wood's
    // own specular is turned down, or two glossy layers stack into a milky haze at low angles.
    floor: new THREE.MeshPhysicalMaterial({ map: parquet, roughness: 0.7, specularIntensity: 0.4, clearcoat: 0.2, clearcoatRoughness: 0.35, dithering: true }),
    // Section caps on cut walls: flat black, like the fill of a cut wall in an architectural section.
    section: new THREE.MeshBasicMaterial({ color: 0x15171b, side: THREE.DoubleSide, toneMapped: false }),
    oak: new THREE.MeshStandardMaterial({ color: 0xb8875a, roughness: 0.55 }),
    frame: new THREE.MeshStandardMaterial({ color: 0xf6f6f3, roughness: 0.38 }),
    leaf: new THREE.MeshStandardMaterial({ color: 0xf1f0ea, roughness: 0.42 }),
    handle: new THREE.MeshStandardMaterial({ color: 0xf0f0ee, roughness: 0.3 }),
    steel: new THREE.MeshStandardMaterial({ color: 0xc9ccce, metalness: 1, roughness: 0.28 }),
    glass: new THREE.MeshStandardMaterial({ color: 0xd2e4ec, roughness: 0.02, transparent: true, opacity: 0.14, depthWrite: false }),
    tiles: new THREE.MeshStandardMaterial({ map: tiles, roughness: 0.7 }),
    hallWall: new THREE.MeshStandardMaterial({ color: 0xe4e5e2, roughness: 0.92 }),
    // The balcony, as in its photos.
    concrete: new THREE.MeshStandardMaterial({ map: concreteTexture(), roughness: 0.95 }), // the floor slab, plain concrete
    parapet: new THREE.MeshStandardMaterial({ color: 0xc2bdb2, roughness: 0.92 }), // painted concrete
    capping: new THREE.MeshStandardMaterial({ color: 0x4b4e50, roughness: 0.5 }), // dark grey powder-coated metal, on both parapets
    screen: new THREE.MeshStandardMaterial({ color: 0x7b8574, roughness: 0.6 }), // powder-coated metal, a muted grey green
    soffit: new THREE.MeshStandardMaterial({ color: 0xdedbd3, roughness: 0.95 }), // the balcony above
    awning: new THREE.MeshStandardMaterial({ color: 0x666869, roughness: 0.6 }), // its cassette, grey
  };
}

function buildOutdoors(W, L, T) {
  const group = new THREE.Group();
  group.name = 'outdoors';

  const skyUniforms = {
    top: { value: new THREE.Color(0x8fb6dd) },
    horizon: { value: new THREE.Color(0xe7eef3) },
    bottom: { value: new THREE.Color(0xb9c2b0) },
  };
  const sky = new THREE.Mesh(
    new THREE.SphereGeometry(700, 32, 16), // big enough to hold the real surroundings (500 m across)
    new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      uniforms: skyUniforms,
      vertexShader: /* glsl */ `
        varying vec3 vDir;
        void main() {
          vDir = normalize(position);
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }`,
      fragmentShader: /* glsl */ `
        uniform vec3 top; uniform vec3 horizon; uniform vec3 bottom;
        varying vec3 vDir;
        void main() {
          float h = vDir.y;
          vec3 c = h > 0.0 ? mix(horizon, top, pow(h, 0.6)) : mix(horizon, bottom, pow(-h, 0.4));
          gl_FragColor = vec4(c, 1.0);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }`,
    }),
  );
  sky.position.set(W / 2, 0, L / 2);
  sky.renderOrder = -1;
  sky.name = 'sky';
  group.add(sky);

  // Stand-in scenery until the real surroundings (surroundings.js) have loaded, or if they can't.
  const scenery = new THREE.Group();
  group.add(scenery);
  const groundMat = new THREE.MeshStandardMaterial({ color: 0x7f9467, roughness: 1 });
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(120, 120), groundMat);
  ground.rotation.x = -Math.PI / 2;
  ground.position.set(W / 2, -1.2, L / 2 - 30);
  scenery.add(ground);

  // A low building across the courtyard and a few trees, so the windows have a view.
  const building = new THREE.Mesh(new THREE.BoxGeometry(30, 12, 10), new THREE.MeshStandardMaterial({ color: 0xe6e1d8, roughness: 0.9 }));
  building.position.set(W / 2 + 2, -1.2 + 6, -T.north - 30);
  scenery.add(building);
  const leaf = [0x7d9a5a, 0x6b8b4c, 0x8daa66].map((c) => new THREE.MeshStandardMaterial({ color: c, roughness: 0.9 }));
  const bark = new THREE.MeshStandardMaterial({ color: 0x5a4636, roughness: 1 });
  const trees = [[-2.5, -6, 1.2], [1.2, -8.5, 1.6], [4.5, -5.5, 1.1], [7.5, -9.5, 1.8], [-6, -10, 1.5], [3, -13, 2.0]];
  trees.forEach(([x, z, s], i) => {
    const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.12 * s, 0.16 * s, 2.6 * s, 8), bark);
    trunk.position.set(x, -1.2 + 1.3 * s, z);
    scenery.add(trunk);
    for (let k = 0; k < 3; k++) {
      const blob = new THREE.Mesh(new THREE.IcosahedronGeometry((1.1 + 0.3 * k) * s, 3), leaf[(i + k) % 3]);
      blob.position.set(x + (k - 1) * 0.5 * s, -1.2 + (2.6 + 0.6 * k) * s, z + ((k % 2) - 0.5) * 0.6 * s);
      scenery.add(blob);
    }
  });

  return { group, sky, skyUniforms, scenery };
}
