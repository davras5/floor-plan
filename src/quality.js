// Rendering quality: how much the app draws, from Battery saver to High, plus Auto, which picks
// a level for the device and steps down by itself when frames come too slowly. The choice is
// kept per browser. main.js applies a level (renderer, shadows, light capture, neighbourhood,
// textures); everything changes live except antialiasing, which a WebGL context can't switch,
// so that one takes effect on the next load (the settings panel offers to reload).
//
// What each level sets was chosen by measuring which settings change the cost of a frame, a
// light capture or the memory used (docs/performance-review.md, second round).

const STORE = 'living-room.quality';

export const LEVELS = {
  low: {
    name: 'Battery saver',
    summary: 'For older phones: lower resolution, simpler shadows and surroundings.',
    pixelRatio: 1, // the most device pixels per CSS pixel, when the view is still
    movingRatio: 0.75, // the same while the view moves (orbit, walk, drag); full again once still
    antialias: false,
    sunShadow: 1024, // shadow map sizes (px)
    lampShadow: 256,
    softShadows: false, // PCF instead of PCF-soft
    probe: 64, // the room's light capture, px per cube face
    whiteBalancePass: false, // no second capture just for white balance
    dragShadows: false, // a dragged piece's shadow follows when it's put down
    anisotropy: 2,
    floorDetail: 280, // px per metre of the parquet texture
    surroundings: 'low',
  },
  medium: {
    name: 'Balanced',
    summary: 'For most phones and tablets: sharp when still, lighter while moving.',
    pixelRatio: 1.5,
    movingRatio: 1,
    antialias: true,
    sunShadow: 1024,
    lampShadow: 512,
    softShadows: true,
    probe: 128,
    whiteBalancePass: true,
    dragShadows: true,
    anisotropy: 4,
    floorDetail: 400,
    surroundings: 'high',
  },
  high: {
    name: 'High',
    summary: 'For desktops and recent phones: full resolution and the sharpest shadows.',
    pixelRatio: 2,
    movingRatio: 1.5,
    antialias: true,
    sunShadow: 2048,
    lampShadow: 512,
    softShadows: true,
    probe: 128,
    whiteBalancePass: true,
    dragShadows: true,
    anisotropy: 16,
    floorDetail: 400,
    surroundings: 'high',
  },
};
export const ORDER = ['low', 'medium', 'high'];
const lower = (a, b) => (ORDER.indexOf(a) <= ORDER.indexOf(b) ? a : b);

// What Auto starts with on this device. Phones (a touch screen that's small) get Balanced, or
// Battery saver where the browser says the device is modest; desktops get High. deviceMemory
// is only reported by Chromium browsers, and the core count is only trusted alongside it
// (other browsers round or cap it), so unknown devices start optimistic and step down if slow.
export function deviceLevel() {
  const mq = (q) => typeof matchMedia === 'function' && matchMedia(q).matches;
  const coarse = mq('(pointer: coarse)') && !mq('(any-pointer: fine)');
  const shortSide = Math.min(screen.width, screen.height);
  const memory = navigator.deviceMemory, cores = navigator.hardwareConcurrency;
  const modest = memory != null && (memory <= 4 || (cores != null && cores <= 4));
  if (coarse && shortSide < 600) return { level: modest ? 'low' : 'medium', device: 'phone' };
  if (coarse) return { level: modest ? 'low' : 'medium', device: 'tablet' };
  return { level: modest ? 'medium' : 'high', device: 'computer' };
}

function read() {
  try {
    const s = JSON.parse(localStorage.getItem(STORE));
    if (s && (s.choice === 'auto' || LEVELS[s.choice])) return { choice: s.choice, stepped: LEVELS[s.stepped] ? s.stepped : null };
  } catch {
    // unavailable or unreadable: Auto
  }
  return { choice: 'auto', stepped: null };
}

function write(state) {
  try {
    localStorage.setItem(STORE, JSON.stringify(state));
  } catch {
    // private windows, previews: the choice just isn't remembered
  }
}

// Frames slower than this (ms, the median of a run while the view moves) make Auto step down.
const SLOW = 45;
const RUN = 24; // frames per verdict

// onChange(level, previous): apply a level. The current level is known right away (main.js
// needs it before it creates the renderer, for antialiasing).
export function createQuality() {
  const stored = read();
  const detected = deviceLevel();
  let choice = stored.choice;
  // Auto remembers a step down on this device (so the next visit starts there); picking
  // Auto again in the panel starts over from what the device suggests.
  let stepped = stored.stepped;
  const listeners = new Set();
  let samples = [], armed = false, reason = '';

  const resolve = () => (choice === 'auto' ? (stepped ? lower(stepped, detected.level) : detected.level) : choice);
  let level = resolve();
  const startedWith = LEVELS[level].antialias;

  function emit(prev) {
    for (const fn of listeners) fn(level, prev);
  }

  return {
    get choice() {
      return choice;
    },
    get level() {
      return level;
    },
    get settings() {
      return LEVELS[level];
    },
    get device() {
      return detected;
    },
    // Why Auto is where it is, for the panel ("Balanced for this phone").
    get reason() {
      return reason || `${LEVELS[level].name} for this ${detected.device}`;
    },
    // Antialiasing is fixed when the page loads; this says whether the current level wants
    // something else (the panel then offers a reload).
    get needsReload() {
      return LEVELS[level].antialias !== startedWith;
    },
    get antialias() {
      return startedWith;
    },
    onChange(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    set(next) {
      if (next !== 'auto' && !LEVELS[next]) return;
      const prev = level;
      choice = next;
      if (next === 'auto') stepped = null; // start over from the device's own level
      reason = '';
      samples = [];
      level = resolve();
      write({ choice, stepped });
      if (level !== prev) emit(prev);
      else for (const fn of listeners) fn(level, level); // the panel still updates
    },
    // Auto only watches frames once the room has loaded (shader compiles and the first light
    // captures make loading frames slow on every device).
    arm() {
      armed = true;
    },
    // ms between two frames drawn back to back while the view moves (main.js leaves out frames
    // with a light capture or new shaders in between).
    sample(ms) {
      if (!armed || choice !== 'auto' || level === 'low') return;
      samples.push(ms);
      if (samples.length < RUN) return;
      const median = [...samples].sort((a, b) => a - b)[samples.length >> 1];
      samples = [];
      if (median <= SLOW) return;
      const prev = level;
      stepped = ORDER[ORDER.indexOf(level) - 1];
      level = resolve();
      reason = `${LEVELS[level].name}: frames were slow (${Math.round(1000 / median)} per second)`;
      write({ choice, stepped });
      emit(prev);
    },
  };
}
