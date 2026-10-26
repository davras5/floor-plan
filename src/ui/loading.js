import * as THREE from 'three';

// One loading indicator for the whole app: a slim bar along the top edge and a labelled pill
// in the status row ("Loading furniture · 3 of 7"), announced to screen readers.
//
// Two sources feed it:
//  - three.js's DefaultLoadingManager, which every OBJLoader/TextureLoader/FileLoader uses, so
//    models and textures (new looks, finishes, models) are caught without any wiring;
//  - track(label, promise) for everything else (fetch()es, light capture, whole operations).
//
// Work that finishes within SHOW_AFTER ms never shows, so quick swatch changes don't flicker.

const SHOW_AFTER = 250;
const HIDE_AFTER = 300;

export function createLoading({ bar, status, text, main }) {
  const tasks = new Map(); // id → label
  let nextId = 0, managerLoaded = 0, managerTotal = 0, managerActive = false;
  let tracked = 0, trackedDone = 0;
  let showTimer = 0, hideTimer = 0, shown = false;

  function update() {
    const busy = tasks.size > 0 || managerActive;
    if (busy) {
      clearTimeout(hideTimer);
      if (!shown && !showTimer) showTimer = setTimeout(show, SHOW_AFTER);
    } else {
      clearTimeout(showTimer);
      showTimer = 0;
      if (shown) hideTimer = setTimeout(hide, HIDE_AFTER);
      // Next batch starts its count afresh.
      tracked = trackedDone = 0;
    }
    // Progress: finished items over all items seen in this batch (tracked tasks + files).
    const total = tracked + managerTotal, done = trackedDone + managerLoaded;
    const fraction = total > 0 ? Math.min(1, done / total) : 0;
    bar.style.setProperty('--progress', `${Math.max(8, fraction * 100)}%`);
    bar.classList.toggle('indeterminate', total <= 1);
    // Named after the oldest task still running (the main job, not its last small step).
    // Between two batches there's nothing to name: keep the last label while the pill fades.
    const label = tasks.values().next().value ?? (managerActive ? 'Loading' : '');
    const count = total > 1 ? ` · ${Math.min(done + 1, total)} of ${total}` : '';
    if (label) text.textContent = `${label}${count}…`;
    if (shown) main?.setAttribute('aria-busy', String(busy));
  }
  function show() {
    showTimer = 0;
    shown = true;
    bar.hidden = status.hidden = false;
    main?.setAttribute('aria-busy', 'true');
  }
  function hide() {
    shown = false;
    bar.hidden = status.hidden = true;
    main?.removeAttribute('aria-busy');
  }

  const manager = THREE.DefaultLoadingManager;
  manager.onStart = (url, loaded, total) => {
    managerActive = true;
    managerLoaded = loaded;
    managerTotal = total;
    update();
  };
  manager.onProgress = (url, loaded, total) => {
    managerLoaded = loaded;
    managerTotal = total;
    update();
  };
  manager.onLoad = () => {
    managerActive = false;
    managerLoaded = managerTotal = 0;
    update();
  };
  manager.onError = () => update(); // the others are still loading; onLoad comes when all are done

  return {
    // What's loading right now (for tests and debugging).
    get state() {
      return { tasks: [...tasks.values()], files: managerActive ? `${managerLoaded}/${managerTotal}` : null, shown };
    },
    // Shows `label` while `promise` runs; returns the promise.
    track(label, promise) {
      const id = nextId++;
      tasks.set(id, label);
      tracked++;
      update();
      const done = () => {
        tasks.delete(id);
        trackedDone++;
        update();
      };
      promise.then(done, done);
      return promise;
    },
  };
}
