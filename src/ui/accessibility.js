import * as THREE from 'three';

// Accessibility and small screens: screen-reader announcements, the room card and presets that
// fold on small screens, views as a radio group, keyboard navigation of the 3D view,
// and "the room in words" (a text version of the scene with a button per piece).

export function createAccessibility({ state, canvas, room, furniture, fixtures, views, W, L, H, invalidate, fitPlan, resetView, setMode, selectItem }) {
  const { orbit, orbitCam, plan, planCam } = views;
  // Polite announcements for screen readers (results of actions that only show in the 3D view).
  const announcer = document.getElementById('announce');
  function announce(text) {
    announcer.textContent = '';
    requestAnimationFrame(() => (announcer.textContent = text));
  }

  // The room card and the presets fold to their title line. Phones and short screens start folded,
  // and the viewer's own choice is kept for the visit.
  const smallScreen = () => window.matchMedia('(max-width: 640px), (max-height: 560px)').matches;
  function foldable(toggle, body, titles) {
    let preference = !smallScreen(), chosen = false;
    function setOpen(open) {
      body.hidden = !open;
      toggle.setAttribute('aria-expanded', String(open));
      toggle.title = open ? titles.open : titles.closed;
      // The free space for the model changed: refit Plan, reposition the info card.
      requestAnimationFrame(() => {
        if (state.mode === 'plan') fitPlan();
        invalidate();
      });
    }
    toggle.addEventListener('click', () => {
      preference = toggle.getAttribute('aria-expanded') !== 'true';
      chosen = true;
      setOpen(preference);
    });
    setOpen(preference);
    // Until the viewer picks, it follows the screen (e.g. folds when a phone turns sideways).
    window.addEventListener('resize', () => {
      if (chosen || state.edit) return;
      const open = !smallScreen();
      if (open !== preference) setOpen((preference = open));
    });
    // While editing on a small screen it folds away, so the piece stays in view.
    return { foldForEdit: (editing) => smallScreen() && setOpen(editing ? false : preference) };
  }
  const panels = [
    foldable(document.getElementById('card-toggle'), document.getElementById('card-body'), { open: 'Show less', closed: 'Show room details and sun' }),
    foldable(document.getElementById('presets-toggle'), document.getElementById('presets-body'), { open: 'Hide the presets', closed: 'Show the presets' }),
  ];

  // Views behave as a radio group: arrow keys move the choice.
  document.getElementById('views').addEventListener('keydown', (e) => {
    const order = ['orbit', 'plan', 'walk'];
    const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
    if (!step) return;
    e.preventDefault();
    e.stopPropagation();
    const next = order[(order.indexOf(state.mode) + step + order.length) % order.length];
    setMode(next);
    document.querySelector(`[data-mode="${next}"]`).focus();
  });

  // The 3D view is focusable and works from the keyboard. Its label says how.
  canvas.tabIndex = 0;
  canvas.setAttribute('role', 'application');
  canvas.setAttribute('aria-roledescription', '3D view');
  const VIEW_HELP = {
    orbit: '3D view of the room. Arrow keys orbit, Shift and arrow keys pan, plus and minus zoom, Home resets.',
    plan: 'Floor plan. Arrow keys pan, plus and minus zoom, Home resets.',
    walk: 'Walking through the room at eye height. W, A, S, D or the up and down arrows walk, Shift runs, Q and E or the left and right arrows turn, Home goes back to the door.',
  };
  function describeCanvas() {
    canvas.setAttribute('aria-label', VIEW_HELP[state.mode]);
  }
  const _sph = new THREE.Spherical(), _off = new THREE.Vector3(), _pan = new THREE.Vector3();
  canvas.addEventListener('keydown', (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (state.edit && furniture.selected) return; // then the arrow keys nudge the selected piece
    if (e.key === 'Home') {
      resetView(state.mode);
      e.preventDefault();
      return;
    }
    if (state.mode === 'walk') return; // walk.js handles its own keys
    const zoom = { '+': 0.85, '=': 0.85, '-': 1 / 0.85, _: 1 / 0.85 }[e.key];
    const arrow = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[e.key];
    if (!zoom && !arrow) return;
    e.preventDefault();
    if (state.mode === 'plan') {
      if (zoom) planCam.zoom = THREE.MathUtils.clamp(planCam.zoom / zoom, plan.minZoom, plan.maxZoom);
      else {
        const d = 0.4 / planCam.zoom;
        _pan.set(arrow[0] * d, 0, arrow[1] * d);
        plan.target.add(_pan);
        planCam.position.add(_pan);
      }
      planCam.updateProjectionMatrix();
      plan.update();
    } else if (zoom || !e.shiftKey) {
      _off.subVectors(orbitCam.position, orbit.target);
      _sph.setFromVector3(_off);
      if (zoom) _sph.radius = THREE.MathUtils.clamp(_sph.radius * zoom, orbit.minDistance, orbit.maxDistance);
      else {
        _sph.theta -= arrow[0] * THREE.MathUtils.degToRad(8);
        _sph.phi = THREE.MathUtils.clamp(_sph.phi + arrow[1] * THREE.MathUtils.degToRad(5), 0.05, orbit.maxPolarAngle);
      }
      orbitCam.position.copy(orbit.target).add(_off.setFromSpherical(_sph));
      orbit.update();
    } else {
      // Pan along the ground, relative to the view.
      const yaw = Math.atan2(orbitCam.position.x - orbit.target.x, orbitCam.position.z - orbit.target.z);
      const right = [Math.cos(yaw), -Math.sin(yaw)], fwd = [-Math.sin(yaw), -Math.cos(yaw)];
      _pan.set((arrow[0] * right[0] - arrow[1] * fwd[0]) * 0.3, 0, (arrow[0] * right[1] - arrow[1] * fwd[1]) * 0.3);
      orbit.target.add(_pan);
      orbitCam.position.add(_pan);
      orbit.update();
    }
    invalidate();
  });

  // A text version of what the 3D view shows: the room, each piece with where it stands, and the
  // fittings (light, doors, window, curtains) with their state. Each is a button that opens its
  // info card, so everything is reachable without pointing.
  const srRoom = document.getElementById('sr-room'), srList = document.getElementById('sr-furniture');
  let srTimer = 0;
  function describeRoom() {
    clearTimeout(srTimer);
    srTimer = setTimeout(() => {
      const { win, bal, door } = room.layout;
      srRoom.textContent =
        `${W.toFixed(2)} by ${L.toFixed(2)} metres, ${H.toFixed(2)} metre ceiling. The window wall has a window ` +
        `${(win.x1 - win.x0).toFixed(2)} metres wide and a balcony door ${(bal.x1 - bal.x0).toFixed(2)} metres wide; ` +
        `the entry door is on the opposite wall, ${(W - door.x1).toFixed(2)} metres from the right-hand wall.`;
      const items = [...(state.furniture ? furniture.items.filter((it) => it.pivot.visible !== false) : []), ...fixtures().list];
      // Same pieces as before: update the text in place, so keyboard focus in the list survives.
      if (srList.children.length !== items.length || items.some((it, i) => srList.children[i].dataset.id !== it.id)) {
        srList.replaceChildren(...items.map((it) => {
          const b = document.createElement('button');
          b.type = 'button';
          b.addEventListener('click', () => {
            selectItem(it);
            // On to the piece's info card (this panel closes as focus leaves it).
            const card = furniture.popup?.object.visible ? furniture.popup.card : null;
            if (card) card.tabIndex = -1;
            (card || canvas).focus();
          });
          const li = document.createElement('li');
          li.dataset.id = it.id;
          li.append(b);
          return li;
        }));
      }
      items.forEach((it, i) => {
        if (it.kind === 'fixture') {
          srList.children[i].firstChild.textContent = `${it.label}: ${it.name}. ${it.state()}.`;
          return;
        }
        const f = furniture.footprint(it), d = furniture.describe?.(it);
        const name = d ? `${d.label}: ${d.maker} ${d.name}, ${d.finish}` : it.id;
        const where = `${f.x0.toFixed(2)} m from the left wall, ${f.z0.toFixed(2)} m from the window wall, ` +
          `${(W - f.x1).toFixed(2)} m from the right wall, ${(L - f.z1).toFixed(2)} m from the door wall`;
        srList.children[i].firstChild.textContent = `${name}. ${where}.`;
      });
    }, 400);
  }

  const foldPanelsForEdit = (editing) => panels.forEach((p) => p.foldForEdit(editing));

  return { announce, describeCanvas, describeRoom, foldPanelsForEdit };
}
