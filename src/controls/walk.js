import * as THREE from 'three';
import { damp } from '../util.js';

// First-person walking at eye height, like a PC game:
//   mouse      hold the left button and drag to look around (right turns right, up looks up);
//              otherwise it's an ordinary pointer, and a click acts on what's under it (main.js).
//   keyboard   WASD (or ↑/↓) to walk and strafe, Shift to run, Q/E or ←/→ to turn.
//   touch      twin-stick: a thumb on the left half of the view is a joystick that walks you
//              (as far as you push it, that fast); a thumb on the right half drags to look.
//   walkTo()   glides to a point (main.js calls it when you tap the floor).
// Movement eases in and out instead of starting and stopping dead, and furniture footprints
// are walked around.

const KEYS = {
  forward: ['KeyW', 'ArrowUp'],
  back: ['KeyS', 'ArrowDown'],
  left: ['KeyA'],
  right: ['KeyD'],
  turnLeft: ['KeyQ', 'ArrowLeft'],
  turnRight: ['KeyE', 'ArrowRight'],
  run: ['ShiftLeft', 'ShiftRight'],
};
const ALL_KEYS = Object.values(KEYS).flat();
const LOOK = { mouse: 0.0045, touch: 0.006 }; // radians per pixel dragged
const STICK = 52; // px: the joystick's reach
const RUN = 1.9; // running speed, × walking

// Scratch vectors reused every frame (update() runs at 60 fps while walking).
const _f = new THREE.Vector2(), _r = new THREE.Vector2(), _want = new THREE.Vector2(), _d = new THREE.Vector2(), _p = new THREE.Vector2();

export class WalkControls {
  constructor(camera, dom, bounds, eyeHeight = 1.59) {
    this.camera = camera;
    this.dom = dom;
    this.bounds = bounds;
    this.eye = eyeHeight;
    this.enabled = false;
    this.speed = 1.4; // m/s, a relaxed indoor walk
    this.turnSpeed = 1.8; // rad/s
    this.yaw = 0;
    this.pitch = 0;
    this.velocity = new THREE.Vector2();
    this.turnRate = 0;
    this.goal = null;
    this.keys = new Set();
    this.stick = new THREE.Vector2(); // the touch joystick, -1…1 (y down = back)
    this.dirty = true;
    this.obstacles = () => []; // furniture footprints {x0, x1, z0, z1} to walk around
    this.arrowsEnabled = () => true; // main.js turns arrows off while they nudge furniture
    camera.rotation.order = 'YXZ';

    // The joystick drawn under the left thumb.
    this.stickEl = document.createElement('div');
    this.stickEl.className = 'walk-stick';
    this.stickEl.hidden = true;
    this.stickEl.setAttribute('aria-hidden', 'true');
    this.knobEl = document.createElement('div');
    this.knobEl.className = 'walk-knob';
    this.stickEl.append(this.knobEl);
    dom.parentElement?.append(this.stickEl);

    let move = null, look = null;
    // (It throws if the pointer is already gone.)
    const capture = (id) => {
      try {
        dom.setPointerCapture(id);
      } catch {}
    };
    dom.addEventListener('pointerdown', (e) => {
      if (!this.enabled) return;
      if (e.pointerType === 'touch') {
        const r = dom.getBoundingClientRect();
        if (!move && e.clientX - r.left < r.width / 2) {
          move = { id: e.pointerId, x: e.clientX, y: e.clientY };
          this.showStick(e.clientX - r.left, e.clientY - r.top, 0, 0);
        } else if (!look) look = { id: e.pointerId, x: e.clientX, y: e.clientY };
        else return;
        capture(e.pointerId);
        return;
      }
      if (e.button !== 0) return;
      look = { id: e.pointerId, x: e.clientX, y: e.clientY };
      capture(e.pointerId);
    });
    dom.addEventListener('pointermove', (e) => {
      if (!this.enabled) return;
      if (move && move.id === e.pointerId) {
        let dx = e.clientX - move.x, dy = e.clientY - move.y;
        const len = Math.hypot(dx, dy);
        if (len > STICK) (dx *= STICK / len), (dy *= STICK / len);
        this.stick.set(dx / STICK, dy / STICK);
        const r = dom.getBoundingClientRect();
        this.showStick(move.x - r.left, move.y - r.top, dx, dy);
        this.dirty = true;
      } else if (look && look.id === e.pointerId) {
        this.look(e.clientX - look.x, e.clientY - look.y, e.pointerType === 'touch' ? LOOK.touch : LOOK.mouse);
        look.x = e.clientX;
        look.y = e.clientY;
      }
    });
    const end = (e) => {
      if (move && move.id === e.pointerId) {
        move = null;
        this.stick.set(0, 0);
        this.stickEl.hidden = true;
      }
      if (look && look.id === e.pointerId) look = null;
    };
    dom.addEventListener('pointerup', end);
    dom.addEventListener('pointercancel', end);

    window.addEventListener('keydown', (e) => {
      if (!this.enabled || e.metaKey || e.ctrlKey || e.altKey || !ALL_KEYS.includes(e.code)) return;
      // Keys typed into a form control (the sun slider, the month, a field) are the control's.
      // Buttons aren't: right after clicking Walk, its button has the focus.
      if (e.target instanceof Element && e.target.closest('input, select, textarea, [role="slider"], [contenteditable]')) return;
      if (e.code.startsWith('Arrow') && !this.arrowsEnabled()) return;
      this.keys.add(e.code);
      if (!e.code.startsWith('Shift')) e.preventDefault();
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => this.keys.clear());
  }

  // Look by a pointer movement: right turns right, up looks up, as in games.
  look(dx, dy, k) {
    this.yaw -= dx * k;
    this.pitch = THREE.MathUtils.clamp(this.pitch - dy * k, -1.35, 1.35);
    this.dirty = true;
  }

  showStick(x, y, dx, dy) {
    this.stickEl.hidden = false;
    this.stickEl.style.transform = `translate(${x}px, ${y}px)`;
    this.knobEl.style.transform = `translate(${dx}px, ${dy}px)`;
  }

  // Let go of the joystick (leaving Walk).
  release() {
    this.stick.set(0, 0);
    this.stickEl.hidden = true;
  }

  place(x, z, yaw, pitch = 0) {
    this.camera.position.set(x, this.eye, z);
    this.yaw = yaw;
    this.pitch = pitch;
    this.goal = null;
    this.velocity.set(0, 0);
    this.dirty = true;
  }

  walkTo(x, z) {
    // Tapping on a piece of furniture walks you up to its edge.
    this.goal = this.stepOut(new THREE.Vector2(x, z));
    this.goalBest = Infinity;
    this.goalStall = 0;
    if (this.instant) {
      // prefers-reduced-motion: no glide, just be there.
      const b = this.bounds;
      this.camera.position.x = THREE.MathUtils.clamp(this.goal.x, b.minX, b.maxX);
      this.camera.position.z = THREE.MathUtils.clamp(this.goal.y, b.minZ, b.maxZ);
      this.goal = null;
      this.dirty = true;
    }
  }

  // Moves a point (x, y = room z) out of any furniture footprint, to the nearest side
  // that's still inside the room (a sofa against a wall can only be left the other way).
  stepOut(p) {
    const pad = 0.25, b = this.bounds;
    for (const f of this.obstacles()) {
      const x0 = f.x0 - pad, x1 = f.x1 + pad, z0 = f.z0 - pad, z1 = f.z1 + pad;
      if (p.x <= x0 || p.x >= x1 || p.y <= z0 || p.y >= z1) continue;
      const exit = [[p.x - x0, 'x', x0, x0 >= b.minX], [x1 - p.x, 'x', x1, x1 <= b.maxX], [p.y - z0, 'y', z0, z0 >= b.minZ], [z1 - p.y, 'y', z1, z1 <= b.maxZ]]
        .filter((c) => c[3])
        .sort((a, c) => a[0] - c[0])[0];
      if (exit) p[exit[1]] = exit[2];
    }
    return p;
  }

  // Returns true when the view changed and needs a redraw.
  update(dt) {
    const pos = this.camera.position;
    const held = (name) => KEYS[name].some((c) => this.keys.has(c));

    // Turning eases in and out too.
    const turn = (held('turnLeft') ? 1 : 0) - (held('turnRight') ? 1 : 0);
    this.turnRate = damp(this.turnRate, turn * this.turnSpeed, 12, dt);
    if (Math.abs(this.turnRate) < 1e-3) this.turnRate = 0;
    this.yaw += this.turnRate * dt;

    // Where we'd like to be heading, in m/s: keys at full speed (Shift runs), the joystick
    // as far as it's pushed.
    const f = _f.set(-Math.sin(this.yaw), -Math.cos(this.yaw));
    const r = _r.set(Math.cos(this.yaw), -Math.sin(this.yaw));
    const want = _want.set(0, 0);
    if (held('forward')) want.add(f);
    if (held('back')) want.sub(f);
    if (held('right')) want.add(r);
    if (held('left')) want.sub(r);
    if (want.lengthSq() > 0) want.normalize().multiplyScalar(this.speed * (held('run') ? RUN : 1));
    else if (this.stick.lengthSq() > 0.01) want.addScaledVector(f, -this.stick.y).addScaledVector(r, this.stick.x).multiplyScalar(this.speed * (this.stick.length() > 0.95 ? RUN : 1));
    if (want.lengthSq() > 0) this.goal = null;
    else if (this.goal) {
      const d = _d.set(this.goal.x - pos.x, this.goal.y - pos.z);
      const dist = d.length();
      // Give up if furniture in the way stops us getting closer.
      if (dist < this.goalBest - 0.005) {
        this.goalBest = dist;
        this.goalStall = 0;
      } else this.goalStall += dt;
      if (dist < 0.02 || this.goalStall > 0.4) this.goal = null;
      else want.copy(d).multiplyScalar(Math.min(this.speed * 1.3, dist * 3) / dist); // slow down on arrival
    }

    this.velocity.set(damp(this.velocity.x, want.x, 10, dt), damp(this.velocity.y, want.y, 10, dt));
    if (want.lengthSq() === 0 && this.velocity.lengthSq() < 1e-4) this.velocity.set(0, 0);
    const moving = this.velocity.lengthSq() > 0;

    const b = this.bounds;
    const p = this.stepOut(_p.set(pos.x + this.velocity.x * dt, pos.z + this.velocity.y * dt));
    pos.x = THREE.MathUtils.clamp(p.x, b.minX, b.maxX);
    pos.z = THREE.MathUtils.clamp(p.y, b.minZ, b.maxZ);
    pos.y = this.eye;
    this.camera.rotation.set(this.pitch, this.yaw, 0);

    const changed = moving || this.turnRate !== 0 || this.dirty;
    this.dirty = false;
    return changed;
  }
}
