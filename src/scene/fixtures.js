import * as THREE from 'three';

// The room's own fittings that can be tapped like furniture: the ceiling light, the two doors,
// the window and the curtains. Each says what it is (for the info card) and what it can do:
// open and close, draw the curtains, switch the light on or off or back to automatic (on once
// it's dark). They move there smoothly; main.js picks them and editor.js shows their card.
//
// A fitting in a wall that's cut away in the current view can't be picked: what's left of it
// is a stub, and a tap above it should reach what's behind.

const SWING_SPEED = 2.4; // rad/s
const DRAW_TIME = 1.2; // s for the curtains, end to end

export function createFixtures({ room, curtains, pendant, lighting, R, onChange }) {
  const swingsOf = (id) => room.doors.filter((d) => d.id === id);
  const opener = (id, what) => ({
    state: () => (swingsOf(id)[0].open ? 'Open' : 'Closed'),
    actions: () => {
      const open = swingsOf(id)[0].open;
      return [{ label: open ? `Close the ${what}` : `Open the ${what}`, run: () => setOpen(id, !open) }];
    },
  });
  const { win, bal, door } = room.layout;
  let curtainsTarget = 0; // 0 open (gathered at the ends), 1 drawn

  const list = [
    {
      // Not part of the ceiling's geometry, so it stays when the ceiling is cut away (Plan's cut hides it).
      id: 'lamp', label: 'Ceiling light', name: 'Pendant lamp (in the room now)', wall: null,
      objects: [pendant.group],
      size: { w: R.pendant.width, d: R.pendant.width, h: R.pendant.height },
      state: () => {
        const on = lighting.lampOn ? 'On' : 'Off';
        return lighting.lampMode === 'auto' ? `${on} · automatic, on after sunset` : `${on} · switched by hand`;
      },
      actions: () => [
        { label: lighting.lampOn ? 'Turn off' : 'Turn on', run: () => setLamp(lighting.lampOn ? 'off' : 'on') },
        lighting.lampMode !== 'auto' && { label: 'Automatic', run: () => setLamp('auto') },
      ].filter(Boolean),
    },
    {
      id: 'door', label: 'Entry door', name: 'Door to the hallway', wall: 'south',
      objects: swingsOf('door').map((d) => d.pivot),
      size: { w: door.width, d: 0.04, h: door.height },
      ...opener('door', 'door'),
    },
    {
      id: 'balcony-door', label: 'Balcony door', name: 'Door to the balcony', wall: 'north',
      objects: swingsOf('balcony-door').map((d) => d.pivot),
      size: { w: bal.x1 - bal.x0, d: 0.07, h: bal.y1 },
      ...opener('balcony-door', 'door'),
    },
    {
      id: 'window', label: 'Window', name: 'Two sashes, opening inward', wall: 'north',
      objects: swingsOf('window').map((d) => d.pivot),
      size: { w: win.x1 - win.x0, d: 0.07, h: win.y1 - win.y0 },
      ...opener('window', 'window'),
    },
    {
      id: 'curtains', label: 'Curtains', name: 'Sheer white voile, two panels', wall: 'north',
      objects: curtains.meshes,
      noOutline: true, // their geometry changes as they're drawn; the card is enough
      size: { w: R.curtainRail.to - R.curtainRail.from, d: 0.1, h: R.curtainRail.height },
      state: () => (curtainsTarget ? 'Drawn' : 'Open'),
      actions: () => [{ label: curtainsTarget ? 'Open the curtains' : 'Close the curtains', run: () => setCurtains(!curtainsTarget) }],
    },
  ];
  const box = new THREE.Box3();
  for (const f of list) {
    f.kind = 'fixture';
    f.box = new THREE.Box3();
    // Its meshes, for the selection outline (furniture.js), and its box now (doors move).
    f.meshes = [];
    for (const o of f.objects) o.traverse((m) => m.isMesh && !m.userData.outline && f.meshes.push(m));
    f.updateBox = () => {
      f.box.makeEmpty();
      for (const o of f.objects) f.box.union(box.setFromObject(o));
      return f.box;
    };
  }

  function setOpen(id, open) {
    for (const d of swingsOf(id)) d.open = open;
    onChange();
  }
  function setCurtains(closed) {
    curtainsTarget = closed ? 1 : 0;
    onChange();
  }
  function setLamp(mode) {
    lighting.setLamp(mode);
    onChange();
  }

  return {
    list,
    get: (id) => list.find((f) => f.id === id),
    setOpen,
    setCurtains,
    setLamp,

    // The nearest fixture under the ray as { item, point, distance }, or null.
    // cut(wallName): whether that wall is cut away in the current view.
    pick(raycaster, cut) {
      let best = null;
      for (const f of list) {
        if (cut(f.wall)) continue;
        const hit = raycaster.intersectObjects(f.objects, true)[0];
        if (hit && hit.distance < (best?.distance ?? Infinity)) best = { item: f, point: hit.point, distance: hit.distance };
      }
      return best;
    },

    // Moves doors, sashes and curtains toward their targets. Returns whether anything moved.
    animate(dt, instant) {
      let moved = false;
      for (const d of room.doors) {
        const goal = d.open ? d.openAngle : 0;
        if (d.angle === goal) continue;
        const step = instant ? Infinity : SWING_SPEED * dt;
        d.angle = Math.abs(goal - d.angle) <= step ? goal : d.angle + Math.sign(goal - d.angle) * step;
        d.pivot.rotation.y = d.sign * d.angle;
        moved = true;
      }
      if (curtains.closed !== curtainsTarget) {
        const step = instant ? Infinity : dt / DRAW_TIME;
        const c = curtains.closed;
        curtains.setClosed(Math.abs(curtainsTarget - c) <= step ? curtainsTarget : c + Math.sign(curtainsTarget - c) * step);
        moved = true;
      }
      return moved;
    },
  };
}
