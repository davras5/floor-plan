import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { CSS2DRenderer } from 'three/addons/renderers/CSS2DRenderer.js';
import { ROOM } from './config.js';
import { buildRoom, PROBE, CEILING_PROBE, SECTION } from './scene/room.js';
import { damp } from './util.js';
import { buildAnnotations } from './scene/annotations.js';
import { createLighting } from './lighting/lighting.js';
import { WalkControls } from './controls/walk.js';
import { buildPendant } from './scene/pendant.js';
import { buildCurtains } from './scene/curtains.js';
import { Furniture } from './furniture/furniture.js';
import { createEditor } from './furniture/editor.js';
import { createCutaway } from './scene/cutaway.js';
import { createFixtures } from './scene/fixtures.js';
import { createAccessibility } from './ui/accessibility.js';
import { createLoading } from './ui/loading.js';
import { loadSurroundings } from './scene/surroundings.js';
import { sunPosition, zurichTime } from './lighting/sun.js';
import { createIndirect, skyEnvironment } from './lighting/indirect.js';
import { createQuality, shadowsBlocked, blockShadows } from './quality.js';
import { createWindowSun } from './lighting/window-sun.js';
import { createContactShadows } from './scene/contact-shadows.js';
import { createSettings } from './ui/settings.js';
import { createDiagnostics } from './ui/diagnostics.js';

const W = ROOM.width, L = ROOM.length, H = ROOM.height, T = ROOM.wallThickness;
const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const stage = document.getElementById('stage');

// Frames are drawn on demand, and the render loop itself sleeps while nothing changes (see
// "Render loop"); invalidate() wakes it. Shadows are cached too: nothing in the room moves on
// its own, so the shadow maps only re-render when furniture, doors or the lighting change.
// The same changes also re-capture the room's indirect light, once things are quiet.
let dirty = true, shadowsDirty = true, captureTimer = 0;
let booted = false; // set once the first view is up (no announcements before that)
let wake = () => {}; // starts the render loop if it's asleep (set up with the loop)
const invalidate = () => {
  dirty = true;
  wake();
};
// The light changed but nothing that casts shadows (a new finish): redraw and re-capture.
const lightChanged = () => {
  invalidate();
  scheduleCapture();
  if (typeof describeRoom === 'function' && furniture?.items) describeRoom(); // text version of the view
};
const shadowsChanged = () => {
  shadowsDirty = true;
  lightChanged();
};

// ---- Rendering quality (quality.js; chosen in the settings panel) ---------------
// Read before the renderer exists: antialiasing can only be chosen when it's created.
const quality = createQuality();
const Q = () => quality.settings;
// Device pixels per CSS pixel: when still, and while the view moves (orbit, walk, a drag).
function ratios() {
  const still = Math.min(window.devicePixelRatio || 1, Q().pixelRatio);
  return { still, moving: Math.min(still, Q().movingRatio) };
}

// ---- Renderer ------------------------------------------------------------
// stencil: the selection outline is drawn only outside the selected piece's silhouette.
const renderer = new THREE.WebGLRenderer({ antialias: quality.antialias, alpha: true, stencil: true });
renderer.setPixelRatio(ratios().still);
// Shadow maps where the level has them and the graphics driver copes with them (quality.js);
// otherwise the simple path: sun through the window by calculation, contact shadows.
let shadowBlock = shadowsBlocked(renderer.getContext());
const useShadows = () => Q().shadows && !shadowBlock;
renderer.shadowMap.enabled = useShadows();
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.shadowMap.autoUpdate = false;
renderer.toneMapping = THREE.NeutralToneMapping;
renderer.localClippingEnabled = true;
renderer.setClearColor(0x000000, 0); // the page background shows behind the model
stage.appendChild(renderer.domElement);
const canvas = renderer.domElement;
// Problems a phone would otherwise hide (a lost context, a shader this GPU can't compile, an
// uncaught error) show in a small panel with what to do and the details for a report.
const diagnostics = createDiagnostics({
  renderer, quality,
  reload: () => reloadKeepingView(),
  onRestored: () => {
    applyShadows();
    shadowsChanged(); // three has rebuilt its GPU resources: shadows and light again
  },
});
// A context lost while shadow maps were on: no more shadow maps on this device (remembered), and
// once the context is back the room carries on in the simple path.
canvas.addEventListener('webglcontextlost', () => {
  if (!renderer.shadowMap.enabled) return;
  shadowBlock = 'the 3D view stopped once with them on';
  blockShadows(shadowBlock);
});

const labels = new CSS2DRenderer();
labels.domElement.className = 'labels';
stage.appendChild(labels.domElement);

// One loading indicator for everything that loads after the first frame (ui/loading.js).
const loading = createLoading({
  bar: document.getElementById('progress'),
  status: document.getElementById('loading-status'),
  text: document.getElementById('loading-text'),
  main: document.querySelector('main'),
});

const scene = new THREE.Scene();

// ---- Room ----------------------------------------------------------------
const room = buildRoom(ROOM, renderer, { anisotropy: Q().anisotropy, floorDetail: Q().floorDetail });
scene.add(room.root);
// The simple path's sunlight (lighting/window-sun.js) goes into every lit material indoors: the
// room's now, before the 3D view's cut-away copies of the walls are made (they share the hooks);
// the fittings and the furniture as they're added.
const windowSun = createWindowSun(room, ROOM);
windowSun.patchAll(room.root, [room.outdoors.group]);
const notes = buildAnnotations(ROOM, room.layout);
scene.add(notes.group, notes.measure);

// Indirect light: the room lights itself (see "Indirect light" below). Until the first capture
// a neutral stand-in lights the scene, made at the capture's size so the first frame's shaders
// are the ones the room keeps using.
const indirect = createIndirect(renderer, scene, PROBE(ROOM), {
  position: CEILING_PROBE(ROOM),
  // the ceiling, and its cut-away copy in Plan
  materials: () => [room.materials.ceiling, cutaway.clippedOf(room.materials.ceiling)].filter(Boolean),
});
scene.environmentIntensity = 0.4;

// ---- Furnishings: the existing pendant, plus pieces from furniture.js -------
// Everything sits in room coordinates (x from the left wall, z from the window wall, y = 0 on the floor).
const pendant = buildPendant(ROOM);
scene.add(pendant.group);
// The curtains hang on the window wall, so the 3D view cuts them down with it.
const curtains = buildCurtains(ROOM);
room.walls.find((w) => w.name === 'north').group.add(curtains.group);
windowSun.patchAll(pendant.group);
windowSun.patchAll(curtains.group);
const lighting = createLighting(scene, ROOM, room.layout, room.outdoors.skyUniforms, pendant);
lighting.setShadowSizes(Q().sunShadow, Q().lampShadow);
// A new finish only changes the light; moving a piece or a new model changes shadows too.
let contact = null; // contact shadows (below)
const furniture = new Furniture(ROOM, renderer, (what) => {
  windowSun.patchAll(furniture.group); // new models and finishes are new materials
  contact?.sync();
  if (what === 'light') lightChanged();
  else shadowsChanged();
}, { anisotropy: Q().anisotropy });
scene.add(furniture.group, furniture.overlay); // the overlay: the info card
// Contact shadows under the furniture, for the simple path (scene/contact-shadows.js).
contact = createContactShadows(furniture);

const state = { mode: 'orbit', dims: false, furniture: true, edit: false };
let camera;
let surroundings = null; // the real neighbourhood, once loaded
let settings = null; // the settings panel (created with the UI wiring below)

// ---- Cameras and controls -------------------------------------------------
const orbitCam = new THREE.PerspectiveCamera(40, 1, 0.05, 300);
const orbit = new OrbitControls(orbitCam, canvas);
orbit.enableDamping = true;
orbit.dampingFactor = 0.08;
orbit.zoomToCursor = true;
orbit.maxPolarAngle = Math.PI * 0.495;
orbit.minDistance = 1.5;
orbit.maxDistance = 30;

// Straight down from 30 m. Its near plane is the plan's cut: everything above 1.2 m is cut off,
// without a clipping plane (which would compile a second version of every material).
const PLAN_HEIGHT = 30;
const planCam = new THREE.OrthographicCamera(-1, 1, 1, -1, PLAN_HEIGHT - SECTION.plan, 100);
const plan = new OrbitControls(planCam, canvas);
plan.enableRotate = false;
plan.zoomToCursor = true;
plan.mouseButtons = { LEFT: THREE.MOUSE.PAN, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.PAN };
plan.touches = { ONE: THREE.TOUCH.PAN, TWO: THREE.TOUCH.DOLLY_PAN };
plan.minZoom = 0.5;
plan.maxZoom = 8;

// Model bounds in plan, including the dimension lines.
const planBounds = { x0: -T.west - 0.85, x1: W + T.east + 0.35, z0: -T.north - ROOM.balcony.depth - 1.05, z1: L + T.south + 0.75 };

// Panning can't lose the room: the orbit point stays in or near it.
const orbitLimits = new THREE.Box3(new THREE.Vector3(-1, 0, -1), new THREE.Vector3(W + 1, H, L + 1));
const planLimits = new THREE.Box3(new THREE.Vector3(planBounds.x0, 0, planBounds.z0), new THREE.Vector3(planBounds.x1, 0, planBounds.z1));
function keepTarget(controls, limits) {
  const fix = controls.target.clone().clamp(limits.min, limits.max).sub(controls.target);
  if (fix.lengthSq() === 0) return;
  controls.target.add(fix);
  controls.object.position.add(fix);
}
// OrbitControls apply a drag or wheel inside their own event handlers. The plan has no damping,
// so the render loop's plan.update() never sees those changes: redraw on 'change' instead.
orbit.addEventListener('change', () => {
  keepTarget(orbit, orbitLimits);
  invalidate();
});
plan.addEventListener('change', () => {
  keepTarget(plan, planLimits);
  invalidate();
});

// Near 10 cm (Walk keeps you 25 cm from any surface), far enough for the neighbourhood: a
// 1:15000 range, where 5 cm would make distant roofs shimmer.
const walkCam = new THREE.PerspectiveCamera(70, 1, 0.1, 1500);
const walk = new WalkControls(walkCam, canvas, { minX: 0.25, maxX: W - 0.25, minZ: 0.25, maxZ: L - 0.3 }, ROOM.person.eye);
// You walk around furniture, and around the pendant when its shade hangs lower than your head.
const shade = (() => {
  const { x, z } = ROOM.ceilingOutlet, r = ROOM.pendant.width / 2;
  return { x0: x - r, x1: x + r, z0: z - r, z1: z + r };
})();
walk.instant = reduceMotion; // with reduced motion, tapping the floor moves you there at once
walk.obstacles = () => [...furniture.obstacles(),...(pendant.group.visible && ROOM.pendant.bottom < ROOM.person.height ? [shade] : [])];
walk.arrowsEnabled = () => !(state.edit && furniture.selected); // then the arrows nudge the piece

// Start just inside the entry door, looking toward the far corner (like the photo from the door).
function walkHome() {
  const sx = room.layout.door.cx, sz = L - 0.45;
  walk.place(sx, sz, Math.atan2(sx - 0.6, sz - 0.6), -0.12);
}
walkHome();

function uiInsets() {
  const top = document.getElementById('top').getBoundingClientRect();
  const dock = document.getElementById('dock').getBoundingClientRect();
  const narrow = window.innerWidth < 640;
  // On narrow screens the room card and the presets sit above the model; on wide screens they float to the sides.
  return { top: narrow ? top.bottom + 8 : 16, bottom: window.innerHeight - dock.top + 8 };
}

function fitPlan() {
  const w = stage.clientWidth, h = stage.clientHeight;
  const { top, bottom } = uiInsets();
  const availH = Math.max(120, h - top - bottom), availW = w - 32;
  const bw = planBounds.x1 - planBounds.x0, bh = planBounds.z1 - planBounds.z0;
  const scale = Math.min(availW / bw, availH / bh); // px per metre
  const cx = (planBounds.x0 + planBounds.x1) / 2;
  // Centre the plan in the free band between the card and the dock.
  const cz = (planBounds.z0 + planBounds.z1) / 2 - ((top + (h - bottom)) / 2 - h / 2) / scale;
  Object.assign(planCam, { left: -w / 2 / scale, right: w / 2 / scale, top: h / 2 / scale, bottom: -h / 2 / scale, zoom: 1 });
  planCam.updateProjectionMatrix();
  // Straight down with the window wall at the top of the screen.
  plan.target.set(cx, 0, cz);
  planCam.position.set(cx, PLAN_HEIGHT, cz + 1e-4);
  plan.update();
}

function fitOrbit() {
  const aspect = orbitCam.aspect;
  orbitCam.fov = aspect < 1 ? 52 : 40;
  orbitCam.updateProjectionMatrix();
  const vfov = THREE.MathUtils.degToRad(orbitCam.fov);
  const hfov = 2 * Math.atan(Math.tan(vfov / 2) * aspect);
  const dist = (aspect < 1 ? 4.0 : 3.5) / Math.sin(Math.min(vfov, hfov) / 2);
  const dir = new THREE.Vector3(0.48, 0.95, 0.78).normalize();
  orbit.target.set(W / 2, 0.3, L / 2);
  orbitCam.position.copy(orbit.target).addScaledVector(dir, dist);
  orbit.update();
}

// Walk keeps an 80° horizontal field of view whatever the screen shape, so a phone
// held upright doesn't feel like looking through a tube and a wide monitor isn't fish-eyed.
function fitWalkFov() {
  const v = 2 * Math.atan(Math.tan(THREE.MathUtils.degToRad(40)) / walkCam.aspect);
  walkCam.fov = THREE.MathUtils.clamp(THREE.MathUtils.radToDeg(v), 50, 90);
  walkCam.updateProjectionMatrix();
}

function resize() {
  const w = stage.clientWidth, h = stage.clientHeight;
  renderer.setSize(w, h);
  labels.setSize(w, h);
  orbitCam.aspect = walkCam.aspect = w / h;
  orbitCam.updateProjectionMatrix();
  fitWalkFov();
  fitPlan();
  invalidate();
}

function resetView(mode) {
  if (mode === 'orbit') fitOrbit();
  else if (mode === 'plan') fitPlan();
  else walkHome();
  invalidate();
}

// Double-click in 3D glides the orbit point to whatever you clicked.
let focus = null;
function focusOn(point) {
  const len = orbitCam.position.distanceTo(orbit.target);
  focus = { from: orbit.target.clone(), to: point.clone().setY(Math.max(point.y, 0.3)), len0: len, len1: THREE.MathUtils.clamp(len, 2.5, 6), t: reduceMotion ? 1 : 0 };
  invalidate();
}
function stepFocus(dt) {
  if (!focus) return false;
  focus.t = Math.min(1, focus.t + dt / 0.45);
  const k = 1 - (1 - focus.t) ** 3; // ease out
  const dir = orbitCam.position.clone().sub(orbit.target).normalize();
  orbit.target.lerpVectors(focus.from, focus.to, k);
  orbitCam.position.copy(orbit.target).addScaledVector(dir, THREE.MathUtils.lerp(focus.len0, focus.len1, k));
  if (focus.t === 1) focus = null;
  return true;
}

// ---- Cutaway (cutaway.js) ---------------------------------------------------------
const cutaway = createCutaway(room, notes);
const { setCut } = cutaway;

// ---- Modes and toggles --------------------------------------------------------
const readout = document.getElementById('readout');
const readoutIdle = readout.innerHTML;
const editor = document.getElementById('editor');

function updateStatus() {
  const walking = state.mode === 'walk';
  document.getElementById('hint').hidden = !walking;
  readout.hidden = walking || state.edit;
  editor.hidden = !state.edit;
}

function setMode(mode) {
  state.mode = mode;
  furniture.popupMaxY = mode === 'plan' ? SECTION.plan - 0.05 : Infinity;
  if (furniture.selected) furniture.anchorPopup(furniture.selected);
  camera = { orbit: orbitCam, plan: planCam, walk: walkCam }[mode];
  orbit.enabled = mode === 'orbit';
  plan.enabled = mode === 'plan';
  walk.enabled = mode === 'walk';
  if (mode !== 'walk') walk.release();
  focus = null;
  room.outdoors.group.visible = room.hallway.visible = mode === 'walk';
  surroundings?.setVisible(mode === 'walk'); // other views keep them only as shadow casters
  notes.group.visible = state.dims && mode !== 'walk';
  if (mode === 'walk') hideMeasure();
  if (mode === 'plan') fitPlan();
  // Radio group: the chosen view is checked and is the one Tab lands on.
  for (const b of document.querySelectorAll('[data-mode]')) {
    b.setAttribute('aria-checked', String(b.dataset.mode === mode));
    b.tabIndex = b.dataset.mode === mode ? 0 : -1;
  }
  describeCanvas();
  if (booted) announce({ orbit: '3D view', plan: 'Floor plan', walk: 'Walking at eye height' }[mode]);
  updateStatus();
  walk.dirty = true;
  // Only the picture changes: shadows and the room's light are the same in every view (cut walls
  // still cast whole shadows, and the hallway, shown only in Walk, casts none).
  invalidate();
}

function setEdit(on) {
  state.edit = on;
  foldPanelsForEdit(on);
  if (on && !state.furniture) setFurniture(true);
  if (!on) selectItem(null);
  hideMeasure();
  canvas.style.cursor = '';
  pressed('toggle-edit', on);
  updateStatus();
  renderEditor();
  invalidate();
}

// The empty room (the "None" preset): the furniture goes; the room's own fittings stay.
function setFurniture(on) {
  if (!on && state.edit) setEdit(false); // nothing to edit in the empty room
  state.furniture = on;
  furniture.group.visible = on;
  if (!on && furniture.selected) selectItem(null);
  shadowsChanged();
}

// The ceiling light ('auto': on once it's dark, or 'on' / 'off'), and the doors. Normally set
// from their info cards (fixtures.js); these are for scripts and tests.
const setLamp = (mode) => fixtures.setLamp(mode);
function setDoors(open) {
  for (const id of ['door', 'balcony-door']) fixtures.setOpen(id, open);
}

function setDims(on) {
  state.dims = on;
  notes.group.visible = on && state.mode !== 'walk';
  settings?.render();
  invalidate();
}

function pressed(id, on) {
  document.getElementById(id).setAttribute('aria-pressed', String(on));
}

// ---- Accessibility and small screens (accessibility.js) ----------------------------
const { announce, describeCanvas, describeRoom, foldPanelsForEdit } = createAccessibility({
  state, canvas, room, furniture, W, L, H, invalidate, fitPlan, resetView,
  fixtures: () => fixtures, // created below
  views: { orbit, orbitCam, plan, planCam },
  setMode: (mode) => setMode(mode),
  selectItem: (item) => selectItem(item),
});

// ---- Fittings: the ceiling light, doors, window and curtains (fixtures.js) -----------
const fixtures = createFixtures({
  room, curtains, pendant, lighting, R: ROOM,
  // Their light, shadows and card change (renderEditor is set up further down).
  onChange: () => {
    shadowsChanged();
    renderEditor();
  },
});
const wallCut = (name) => !!name && !!room.walls.find((w) => w.name === name)?.cut;
// What's off the floor against a wall (the plants on the windowsill, pictures) goes with that
// wall when the 3D view cuts it down, as the curtains do, and can't be picked then: otherwise it
// would float in front of the room.
function wallOf(item) {
  const m = 0.2;
  if (item.z < -0.35) return null; // out on the balcony
  if (item.z < m) return 'north';
  if (item.z > L - m) return 'south';
  if (item.x < m) return 'west';
  if (item.x > W - m) return 'east';
  return null;
}
function syncSill() {
  for (const item of furniture.items) if (item.y) item.pivot.visible = item.present && !wallCut(wallOf(item));
}

// ---- Picking: measuring, tap-to-walk, furniture -----------------------------
const raycaster = new THREE.Raycaster();
const ndc = new THREE.Vector2();

function aim(e) {
  const r = canvas.getBoundingClientRect();
  ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
  camera.updateMatrixWorld();
  raycaster.setFromCamera(ndc, camera);
  return raycaster;
}
const pickFloor = (e) => aim(e).intersectObject(room.floor)[0]?.point ?? null;
// Furniture only moves while editing, so looking around never moves anything by accident.
const pickItem = (e) => (state.edit && state.furniture ? furniture.pick(aim(e)) : null);
// The room's fittings (light, doors, window, curtains) open their card in every mode.
// A fitting can't be picked where it isn't drawn: in a wall that's cut away in this view, or in
// Plan when it's entirely above the plan's cut (the pendant).
const cutAway = (f) => wallCut(f.wall) || (state.mode === 'plan' && f.updateBox().min.y >= SECTION.plan);
const pickFixture = (e) => fixtures.pick(aim(e), cutAway);
furniture.hiddenNow = (item) => item.kind === 'fixture' && cutAway(item); // no outline then either
// Outside Edit a tap on a piece or a fitting only says what it is (the info card).
function pickAny(e) {
  const a = state.furniture ? furniture.pick(aim(e)) : null, b = pickFixture(e);
  return a && b ? (a.distance <= b.distance ? a : b) : a ?? b;
}

function setHover(item) {
  if (furniture.hovered === item) return;
  furniture.hover(item);
  invalidate();
}

function showMeasure(p) {
  const d = (n) => `<b>${n.toFixed(2)}</b>`;
  readout.innerHTML =
    `<span>left wall ${d(p.x)}</span><span>right wall ${d(W - p.x)}</span>` +
    `<span>window wall ${d(p.z)}</span><span>door wall ${d(L - p.z)}</span><span class="unit">m</span>`;
  readout.classList.add('live');
  notes.showMeasure(p.x, p.z);
  invalidate();
}

function hideMeasure() {
  notes.hideMeasure();
  readout.classList.remove('live');
  readout.innerHTML = readoutIdle;
  invalidate();
}

let press = null;
canvas.addEventListener('pointerdown', (e) => (press = { x: e.clientX, y: e.clientY, t: performance.now() }));
canvas.addEventListener('pointerup', (e) => {
  if (!press) return;
  const tap = Math.hypot(e.clientX - press.x, e.clientY - press.y) < 6 && performance.now() - press.t < 500;
  press = null;
  if (!tap) return;
  if (state.edit) {
    // Pieces are picked (and dragged) by the editor. A tap on a fitting opens its card; a tap
    // on empty space first puts the selection down.
    const hit = pickFixture(e);
    if (hit) return selectItem(hit.item);
    if (furniture.selected) return selectItem(null);
  } else {
    // A tap on a piece or fitting opens its info card (in every view; in Walk you stay where
    // you are). A tap anywhere else closes the card and then does what it always does.
    const hit = pickAny(e);
    if (hit) {
      if (notes.measure.visible) hideMeasure();
      return selectItem(hit.item);
    }
    if (furniture.selected) selectItem(null);
  }
  const p = pickFloor(e);
  if (state.mode === 'walk') {
    if (p) walk.walkTo(p.x, p.z);
  } else if (!state.edit) {
    if (p) showMeasure(p);
    else hideMeasure();
  }
});
// Hovering picks what's under the mouse, which can take milliseconds on a dense model; mice
// report moves at 125–1000 Hz, so only the latest move is handled, once per frame.
let hoverMove = null;
canvas.addEventListener('pointermove', (e) => {
  if (e.pointerType !== 'mouse' || e.buttons !== 0) return;
  if (!hoverMove) requestAnimationFrame(() => {
    const m = hoverMove;
    hoverMove = null;
    if (m && m.buttons === 0) hover(m);
  });
  hoverMove = e;
});
function hover(e) {
  if (state.edit) {
    const hit = pickItem(e);
    canvas.style.cursor = hit ? 'grab' : pickFixture(e) ? 'pointer' : '';
    setHover(hit?.item ?? null);
    return;
  }
  canvas.style.cursor = pickAny(e) ? 'pointer' : '';
  if (state.mode === 'walk') return;
  const p = pickFloor(e);
  if (p) showMeasure(p);
  else if (notes.measure.visible) hideMeasure();
}
canvas.addEventListener('pointerleave', (e) => {
  hoverMove = null;
  setHover(null);
  if (e.pointerType === 'mouse' && state.mode !== 'walk' && !state.edit) hideMeasure();
});
canvas.addEventListener('dblclick', (e) => {
  if (state.mode !== 'orbit') return;
  const p = (state.furniture ? furniture.pick(aim(e))?.point : null) ?? pickFloor(e);
  if (p) focusOn(p);
});

// ---- Editing furniture (editor.js) -------------------------------------------------
const { selectItem, undo, renderEditor, openPreset, linkedPreset, dragging } = createEditor({
  furniture, state, canvas, stage, editor, aim, pickItem, invalidate, announce, W, L,
  track: loading.track,
  setEdit: (on) => setEdit(on),
  setFurniture: (on) => state.furniture !== on && setFurniture(on), // the None preset, and back
  getCamera: () => camera,
});

// ---- Theme: dimension lines follow the page's light/dark tokens -------------
function syncTheme() {
  const color = getComputedStyle(document.documentElement).getPropertyValue('--dim-line').trim();
  if (color) notes.setLineColor(color);
  invalidate();
}
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', syncTheme);
new MutationObserver(syncTheme).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });

// ---- UI wiring --------------------------------------------------------------
// Pressing the current view again resets its camera.
for (const b of document.querySelectorAll('[data-mode]')) {
  b.addEventListener('click', () => (b.dataset.mode === state.mode ? resetView(state.mode) : setMode(b.dataset.mode)));
}
document.getElementById('toggle-edit').addEventListener('click', () => setEdit(!state.edit));

// ---- Settings: measurements and rendering quality (ui/settings.js) ------------
// A reload (to switch antialiasing) keeps the view and the time of day.
const RESUME = 'living-room.resume';
function reloadKeepingView() {
  try {
    sessionStorage.setItem(RESUME, JSON.stringify({ mode: state.mode, dims: state.dims, time: sunTime.value, month: sunMonth.value }));
  } catch {
    // no session storage: the reload starts from the defaults
  }
  location.reload();
}
function describeQuality() {
  const q = Q(), r = ratios();
  const res = r.moving < r.still ? `${+r.still.toFixed(2)}× resolution (${+r.moving.toFixed(2)}× while moving)` : `${+r.still.toFixed(2)}× resolution`;
  const shadows = useShadows() ? `${q.sunShadow} px sun shadows` : q.shadows ? `simple shadows: real ones are off, as ${shadowBlock}` : 'simple shadows';
  return `Now: ${q.name} · ${res} · ${shadows}${quality.antialias ? '' : ' · no edge smoothing'}`;
}
settings = createSettings({
  button: document.getElementById('settings-button'),
  quality,
  dims: { get: () => state.dims, set: setDims },
  describe: describeQuality,
  reload: reloadKeepingView,
  announce: (text) => announce(text),
});

document.getElementById('figures').textContent =
  `${W.toFixed(2)} × ${L.toFixed(2)} m · ${(W * L).toFixed(1)} m² · ${H.toFixed(2)} m ceiling`;

window.addEventListener('resize', resize);
resize();
fitOrbit();
syncTheme();
setMode('orbit');
renderEditor();
booted = true;

// ---- Render loop --------------------------------------------------------------
const clock = new THREE.Clock();
let first = true;
const shadowCamera = new THREE.PerspectiveCamera(1, 1, 1, 2);
shadowCamera.position.set(0, -1e4, 0); // looking at nothing, far below the scene
shadowCamera.lookAt(0, -2e4, 0);
shadowCamera.layers.enableAll();
shadowCamera.updateMatrixWorld();
// three picks shadow casters by the viewing camera's layers, and the neighbourhood is on layer 1
// (shown only in Walk). So shadows are rendered with a camera that sees every layer but has
// nothing in view; frames and light captures then reuse those maps.
function renderShadows() {
  syncWindowSun();
  if (renderer.shadowMap.enabled) {
    renderer.shadowMap.needsUpdate = true;
    renderer.render(scene, shadowCamera);
    renderer.shadowMap.needsUpdate = false;
  }
  shadowsDirty = false;
}

// ---- The simple path: no shadow maps (quality.js) ----------------------------------
// The sun comes in through the window panes by calculation (lighting/window-sun.js): toward the
// sun from wherever it is now, through each pane as far as the curtains (closed ones let a
// little through) and the neighbourhood let it. The neighbourhood's share is a few rays per
// pane on the CPU against its buildings and trees, a moment after the sun stops moving.
const _sunDir = new THREE.Vector3();
let neighbours = windowSun.panes.map(() => 1), raysTimer = 0;
function syncWindowSun() {
  const { sun } = lighting;
  windowSun.setSun(_sunDir.subVectors(sun.position, sun.target.position));
  const curtained = 1 - 0.85 * curtains.closed;
  windowSun.setPanes(neighbours.map((k) => k * curtained));
}
const sunRays = new THREE.Raycaster();
sunRays.layers.enableAll(); // the neighbourhood is on layer 1
sunRays.far = 600;
const SAMPLES = [[0.5, 0.5], [0.2, 0.2], [0.8, 0.2], [0.2, 0.8], [0.8, 0.8]];
function traceNeighbours() {
  clearTimeout(raysTimer);
  if (!surroundings || renderer.shadowMap.enabled) return;
  raysTimer = setTimeout(() => {
    const dir = _sunDir.subVectors(lighting.sun.position, lighting.sun.target.position).normalize();
    const start = -T.north - ROOM.balcony.depth - 0.3; // past the balcony (that's in the shader)
    const from = new THREE.Vector3();
    neighbours = windowSun.panes.map(({ rect, z }) => {
      if (dir.y <= 0 || dir.z >= 0) return 1; // no sun through the window anyway
      let clear = 0;
      for (const [u, v] of SAMPLES) {
        from.set(THREE.MathUtils.lerp(rect.x, rect.z, u), THREE.MathUtils.lerp(rect.y, rect.w, v), z);
        from.addScaledVector(dir, (start - z) / dir.z);
        sunRays.set(from, dir);
        if (!sunRays.intersectObject(surroundings.group, true).length) clear++;
      }
      return clear / SAMPLES.length;
    });
    shadowsDirty = true;
    lightChanged();
  }, 150);
}

// Shadow maps on or off: the level (Battery saver and Balanced draw without), or a graphics
// driver that can't take them. Switching changes every shader once.
function applyShadows() {
  const on = useShadows();
  windowSun.on = !on;
  contact.setVisible(!on);
  if (renderer.shadowMap.enabled !== on) {
    renderer.shadowMap.enabled = on;
    scene.traverse((o) => o.material && [].concat(o.material).forEach((m) => (m.needsUpdate = true)));
  }
  traceNeighbours();
}
applyShadows();
let exposureTarget = renderer.toneMappingExposure;

// Adaptive resolution (quality.js): while the view keeps moving (orbit, pan, walk, a dragged
// piece, a door swinging) frames are drawn at the level's lower pixel ratio, and once it has
// been still for SETTLE ms, one frame at the full ratio. A change of ratio resizes the drawing
// buffer: twice per gesture, much cheaper than drawing every moving frame at full size. A
// single changed frame (a view switch, a nudge) isn't motion: it's drawn at full size at once.
const SETTLE = 200;
let movingUntil = 0, streak = 0, idleFrames = 0, looping = false;
let lastFrameAt = 0, lastFrameMoving = false, capturesSeen = 0, programsSeen = 0;

// The first frame compiles the room's shaders, which keeps the main thread busy for a while (a
// second or more on a slow phone). It waits until the furniture's and the neighbourhood's
// downloads have started (their requests depend on small JSON files, preloaded by index.html),
// so they arrive during that time instead of after it; but never more than FIRST_FRAME_WAIT.
const FIRST_FRAME_WAIT = 500;
const requested = { furniture: false, surroundings: false };
const gateUntil = performance.now() + FIRST_FRAME_WAIT;
// Where the GPU compiles shaders in the background (KHR_parallel_shader_compile: most GPUs in
// Chrome), the first frame's shaders are compiled with compileAsync, so the page stays
// responsive and downloads keep being handled meanwhile; without it, compiling blocks anyway.
const parallelCompile = renderer.extensions.has('KHR_parallel_shader_compile');
const settleWithin = (promise, ms) => Promise.race([promise, new Promise((r) => setTimeout(r, ms))]);
let firstCompile = null, firstCompiled = !parallelCompile;

function loop() {
  const dt = Math.min(clock.getDelta(), 0.05);
  const now = performance.now();
  if (first && !(requested.furniture && requested.surroundings) && now < gateUntil) return;
  if (first && !firstCompiled) {
    if (!firstCompile) {
      cutaway.update(state.mode, camera.position);
      firstCompile = settleWithin(renderer.compileAsync(scene, camera), 4000).catch(() => {}).then(() => {
        firstCompiled = true;
        invalidate();
      });
    }
    return;
  }
  let moved = false, changed = false;
  if (state.mode === 'orbit') {
    moved = stepFocus(dt);
    moved = orbit.update() || moved;
  } else if (state.mode === 'plan') moved = plan.update();
  else moved = walk.update(dt);
  if (fixtures.animate(dt, reduceMotion)) {
    shadowsChanged();
    moved = true;
  }
  // Exposure glides to its metered value instead of jumping when a light capture lands.
  // (Until within 0.2 %: at night the exposure is 30–70, where a fixed 0.002 took two seconds more.)
  if (Math.abs(renderer.toneMappingExposure - exposureTarget) > 0.002 * Math.max(1, exposureTarget)) {
    renderer.toneMappingExposure = reduceMotion ? exposureTarget : damp(renderer.toneMappingExposure, exposureTarget, 5, dt);
    changed = true;
  }
  // A pointer held while something changes (dragging a piece, panning the plan) is motion too.
  streak = moved || (pointers.size > 0 && dirty) ? streak + 1 : 0;
  if (streak >= 2) movingUntil = now + SETTLE;
  const moving = now < movingUntil;
  const r = ratios(), ratio = moving ? r.moving : r.still;
  if (renderer.getPixelRatio() !== ratio) {
    renderer.setPixelRatio(ratio);
    dirty = true;
  }
  if (!moved && !changed && !dirty) {
    lastFrameMoving = false;
    // Nothing to draw for half a second: stop asking for frames until something wakes us.
    if (!moving && ++idleFrames > 30) looping = false;
    return;
  }
  idleFrames = 0;
  dirty = false;
  cutaway.update(state.mode, camera.position);
  syncSill();
  if (furniture.selected?.kind === 'fixture') furniture.outlineState(furniture.selected); // its wall may be cut now
  // On Battery saver a dragged piece's shadow follows once it's put down (pointerup redraws).
  if (shadowsDirty && (Q().dragShadows || !dragging())) renderShadows();
  renderer.render(scene, camera);
  labels.render(scene, camera);
  // Auto quality watches the time between frames drawn back to back while moving, leaving out
  // any with a light capture or new shaders in between (those aren't the steady cost).
  const captures = window.__lightCaptured ?? 0, programs = renderer.info.programs.length;
  if (moving && lastFrameMoving && captures === capturesSeen && programs === programsSeen) quality.sample(now - lastFrameAt);
  capturesSeen = captures;
  programsSeen = programs;
  lastFrameAt = now;
  lastFrameMoving = moving;
  if (first) {
    first = false;
    document.getElementById('loading').hidden = true;
    window.__roomReady = true;
  }
}
// The loop runs on its own requestAnimationFrame chain rather than renderer.setAnimationLoop():
// three's loop asks for the next frame after the callback returns, so stopping it from inside
// the callback doesn't stop it, and starting it again would add a second chain (WebXR, the
// reason for setAnimationLoop, isn't used here).
function tick() {
  if (!looping) return;
  loop();
  if (looping) requestAnimationFrame(tick);
}
wake = () => {
  idleFrames = 0;
  if (looping) return;
  looping = true;
  clock.getDelta(); // no jump in dt after a sleep
  requestAnimationFrame(tick);
};
// Input wakes the loop: the controls, Walk's keys and mouse, the joystick all act in their own
// handlers and leave it to the loop to draw.
for (const type of ['pointerdown', 'pointermove', 'wheel', 'keydown', 'touchstart']) addEventListener(type, () => wake(), { capture: true, passive: true });
wake();

// A link can name a preset (#preset=wood-white, or #preset=none for the empty room). A first
// visit loads it directly; otherwise it's applied over the room as the viewer left it (one
// undo step, their own version kept under Custom).
const linked = linkedPreset();
furniture.started.then(() => (requested.furniture = true));
loading.track('Loading furniture', furniture.load({ preset: linked })).then(
  () => {
    if (!notes.measure.visible) readout.innerHTML = readoutIdle;
    const link = linkedPreset(); // again: it may have changed while the furniture loaded
    if (link) openPreset(link);
    renderEditor();
    describeRoom();
    window.__furnitureReady = true;
  },
  (err) => {
    console.error(err);
    readout.textContent = `The furniture models couldn't load (${err.message}). The empty room still works.`;
    announce(readout.textContent);
    diagnostics.report(readout.textContent, err);
  },
).finally(() => settled('furniture'));

// ---- Sun: where it really is, for a chosen time of day and month (default: October, 13:00) ----
const sunTime = document.getElementById('sun-time');
const sunMonth = document.getElementById('sun-month');
const sunLabel = document.getElementById('sun-label');
sunMonth.value = '9'; // October

function updateSun() {
  if (!surroundings) return;
  // Always the 21st of the month (it also gives the solstices and equinoxes), so a setting
  // looks the same whenever the page is opened.
  const day = new Date(Date.UTC(new Date().getFullYear(), Number(sunMonth.value), 21, 12));
  const hours = Number(sunTime.value);
  const { azimuth, elevation } = sunPosition(zurichTime(Math.floor(hours), Math.round((hours % 1) * 60), day), ROOM.site.lat, ROOM.site.lon);
  const lampWasOn = lighting.lampOn;
  lighting.setSun(surroundings.direction(azimuth, elevation));
  if (lighting.lampOn !== lampWasOn) renderEditor(); // the ceiling light's card says what it does now
  syncCasters();
  traceNeighbours();
  const hh = String(Math.floor(hours)).padStart(2, '0'), mm = String(Math.round((hours % 1) * 60)).padStart(2, '0');
  sunLabel.textContent = elevation > 0 ? `${hh}:${mm}` : `${hh}:${mm} · set`;
  sunTime.setAttribute('aria-valuetext', `${hh}:${mm}${elevation > 0 ? '' : ', after sunset'}`);
  shadowsChanged();
}
sunTime.addEventListener('input', updateSun);
sunMonth.addEventListener('change', updateSun);

// ---- Indirect light: the room lights itself ----------------------------------------
// After anything that changes the light settles (sun, lamp, doors, furniture), the room is
// captured from its middle (indirect.js) for ambient light, reflections and exposure.
// A capture is the costliest thing the app does (18 cube faces plus filtering), so it waits:
// CAPTURE_DELAY after the last change, never while a pointer is held (dragging a piece or the
// sun slider), and not before the furniture and the neighbourhood are in, as each would
// change the light again.
const skyEnv = skyEnvironment(renderer, room.outdoors.sky);
const CAPTURE_DELAY = 600;
const pending = { furniture: true, surroundings: true };
const pointers = new Set();
let captureWanted = false;
function scheduleCapture(delay = CAPTURE_DELAY) {
  captureWanted = true;
  clearTimeout(captureTimer);
  captureTimer = setTimeout(() => {
    if (pointers.size || pending.furniture || pending.surroundings) return; // asked again on release / load
    captureWanted = false;
    capture();
  }, delay);
}
function settled(what) {
  pending[what] = false;
  scheduleCapture();
}
addEventListener('pointerdown', (e) => pointers.add(e.pointerId), true);
for (const type of ['pointerup', 'pointercancel']) {
  addEventListener(type, (e) => {
    pointers.delete(e.pointerId);
    if (!pointers.size && shadowsDirty) invalidate(); // a shadow left for after the drag
    if (!pointers.size && captureWanted) scheduleCapture();
  }, true);
}
addEventListener('blur', () => pointers.clear());

// What a camera in the middle of the real room would see: whole walls, the view outside,
// no overlays, and no lamp shade right above the lens (its light still counts).
function prepareCapture() {
  const cut = room.walls.filter((w) => w.cut);
  const caps = room.walls.flatMap((w) => (w.caps ? [w.caps.stub, w.caps.plan] : [])).filter((c) => c.visible);
  const shown = [room.outdoors.group, room.hallway, notes.group, notes.measure, pendant.group, furniture.popup?.object].filter(Boolean).map((o) => [o, o.visible]);
  for (const w of cut) setCut(w, false);
  for (const c of caps) c.visible = false;
  room.outdoors.group.visible = room.hallway.visible = true;
  notes.group.visible = notes.measure.visible = pendant.group.visible = false;
  if (furniture.popup) furniture.popup.object.visible = false;
  return () => {
    for (const w of cut) setCut(w, true);
    for (const c of caps) c.visible = true;
    for (const [o, v] of shown) o.visible = v;
  };
}

let rebalanced = false, captureCompiled = !parallelCompile;
async function capture() {
  const outdoor = skyEnv.update(); // the plain sky, for everything outside
  room.outdoors.group.traverse((o) => o.material && o !== room.outdoors.sky && (o.material.envMap = outdoor));
  surroundings?.group.traverse((o) => o.material && (o.material.envMap = outdoor));
  // The capture renders linear, without tone mapping, so it has its own variant of every shader.
  // Where that can happen in the background, compile them before the first capture.
  if (!captureCompiled) {
    captureCompiled = true;
    const restore = prepareCapture(), current = renderer.getRenderTarget();
    let ready;
    try {
      renderer.setRenderTarget(indirect.target);
      ready = renderer.compileAsync(scene, camera);
    } finally {
      renderer.setRenderTarget(current);
      restore();
    }
    await settleWithin(ready, 4000).catch(() => {});
  }
  if (shadowsDirty) renderShadows(); // the capture uses the current shadow maps
  const metering = loading.track('Lighting the room', indirect.capture(prepareCapture));
  invalidate(); // draw the frame with the new light
  let reading = null;
  try {
    reading = await metering;
  } catch (err) {
    // The read-back fails if the context is lost meanwhile; the next capture meters again.
    if (!renderer.getContext().isContextLost()) console.warn('Light meter unavailable:', err);
  }
  if (reading && Number.isFinite(reading.luminance)) {
    exposureTarget = lighting.exposureFor(reading.luminance);
    // A big white-balance change alters the light itself, so capture once more with it (once;
    // on Battery saver the next capture picks it up instead).
    const moved = lighting.whiteBalance(reading.color);
    if (moved > 0.02 && !rebalanced && Q().whiteBalancePass) {
      rebalanced = true;
      scheduleCapture(0);
    } else rebalanced = false;
  }
  invalidate();
  window.__lightCaptured = (window.__lightCaptured ?? 0) + 1;
  if (window.__lightCaptured === 1) {
    prewarmEvening();
    quality.arm(); // loading is over: Auto may now judge the frame rate
  }
}

// Evening adds the lamp, a point light with shadows, and a new light count means new shaders
// for every material (on screen and in the capture). Where the GPU compiles shaders in the
// background, compile those after the first capture, so switching to Evening doesn't stall.
function prewarmEvening() {
  if (!renderer.extensions.has('KHR_parallel_shader_compile')) return;
  const idle = window.requestIdleCallback ?? ((fn) => setTimeout(fn, 1000));
  idle(() => lighting.withLamp(() => {
    // compileAsync starts every compile at once and only waits for them afterwards, so the
    // lamp can be put back as soon as it returns.
    renderer.compileAsync(scene, camera);
    const current = renderer.getRenderTarget();
    renderer.setRenderTarget(indirect.target); // the capture's variants (linear, no tone mapping)
    renderer.compileAsync(scene, camera);
    renderer.setRenderTarget(current);
  }), { timeout: 5000 });
}

// The neighbourhood only matters for sun shadows. Without the sun it would still be drawn into
// the lamp's shadow cube (six times, as nothing of it can be culled), for nothing.
function syncCasters() {
  surroundings?.setCasting(lighting.sunUp);
}

// The real neighbourhood (swisstopo).
loading.track('Loading the neighbourhood', loadSurroundings(ROOM, { anisotropy: anisotropy(), detail: Q().surroundings, onRequested: () => (requested.surroundings = true) })).then(
  (s) => {
    surroundings = s;
    scene.add(s.group);
    room.outdoors.scenery.visible = false;
    s.setVisible(state.mode === 'walk');
    updateSun();
    document.getElementById('sun-controls').hidden = false;
    document.getElementById('attribution').hidden = false;
    window.__surroundingsReady = true;
    shadowsChanged();
  },
  (err) => console.warn('Real surroundings unavailable, keeping the stand-in scenery:', err),
).finally(() => settled('surroundings'));

// ---- Applying a quality level (quality.js) ------------------------------------------
// Everything but antialiasing changes live. The pixel ratio is picked up by the render loop;
// shadow maps are made anew at their next pass; the neighbourhood rebuilds its terrain and
// trees; textures are filtered again; the parquet is redrawn at its new size.
function anisotropy() {
  return Math.min(Q().anisotropy, renderer.capabilities.getMaxAnisotropy());
}
function applyQuality() {
  const q = Q();
  applyShadows();
  lighting.setShadowSizes(q.sunShadow, q.lampShadow);
  surroundings?.setDetail(q.surroundings);
  room.setFloorDetail(q.floorDetail);
  const aniso = anisotropy();
  furniture.setAnisotropy(aniso);
  const maps = new Set();
  scene.traverse((o) => o.material && [].concat(o.material).forEach((m) => m.map && maps.add(m.map)));
  for (const t of maps) {
    if (t.anisotropy === aniso || t.isDataTexture || t.isRenderTargetTexture) continue;
    t.anisotropy = aniso;
    t.needsUpdate = true;
  }
  shadowsChanged(); // new shadow maps, and the light captured again
  settings?.render();
}
quality.onChange(applyQuality);
window.addEventListener('resize', () => settings?.render()); // the pixel ratio can change with the screen

// After a reload from the settings panel: the same view and time of day.
try {
  const resume = JSON.parse(sessionStorage.getItem(RESUME));
  sessionStorage.removeItem(RESUME);
  if (resume) {
    if (['orbit', 'plan', 'walk'].includes(resume.mode)) setMode(resume.mode);
    if (resume.dims) setDims(true);
    if (resume.time) sunTime.value = resume.time;
    if (resume.month) sunMonth.value = resume.month;
  }
} catch {
  // nothing to resume
}

// Handy from the browser console.
window.roomApp = {
  THREE, scene, room, furniture, pendant, walk, lighting, sunPosition, zurichTime, renderer, capture,
  views: { orbitCam, orbit, planCam, plan, walkCam },
  get surroundings() { return surroundings; },
  quality, settings, diagnostics, windowSun, contact,
  loading,
  setMode, setEdit, setLamp, setDoors, setDims, setFurniture, selectItem, undo, invalidate, shadowsChanged, announce, fixtures,
};
