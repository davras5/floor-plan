import * as THREE from 'three';

// Editing furniture: selecting, dragging, nudging and turning pieces, undo, the edit panel
// (looks, finish pickers, model choice) and the info card next to a selected piece.
// main.js creates it once and passes in what it needs from the rest of the app.

// lightOf(item): for a piece with its own light (a floor lamp), { state, actions: [{ label, run }] }
// for its card; null for the rest.
export function createEditor({ furniture, state, canvas, stage, editor, aim, pickItem, invalidate, setEdit, setFurniture = () => {}, getCamera, announce, W, L, track = (label, p) => p, lightOf = () => null }) {
  // ---- Editing furniture: select, drag, rotate, undo -----------------------------
  // The stage listens in the capture phase, so grabbing a piece never reaches the
  // camera controls underneath: dragging furniture moves it, dragging elsewhere navigates.
  const dragPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  const dragHit = new THREE.Vector3();
  let drag = null;

  stage.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || e.target !== canvas) return; // not on the info card
    const hit = pickItem(e);
    if (!hit) return;
    e.stopPropagation();
    selectItem(hit.item);
    if (hit.item.home.movable === false) return; // it stays where it is (on the windowsill)
    dragPlane.constant = -hit.point.y; // drag at the height it was grabbed, so it stays under the pointer
    drag = { item: hit.item, id: e.pointerId, start: hit.point.clone(), x: hit.item.x, z: hit.item.z, sx: e.clientX, sy: e.clientY, moving: false };
    stage.setPointerCapture(e.pointerId);
  }, { capture: true });

  stage.addEventListener('pointermove', (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    if (!drag.moving) {
      // A little slack, so selecting with a tap never nudges the piece.
      if (Math.hypot(e.clientX - drag.sx, e.clientY - drag.sy) < 4) return;
      drag.moving = true;
      remember(drag.item);
      canvas.style.cursor = 'grabbing';
    }
    const ray = aim(e).ray;
    // Rays that only graze the floor (pointer near the horizon) hit it far away; ignore them so the piece can't be flung.
    if (Math.abs(ray.direction.y) < 0.08 || !ray.intersectPlane(dragPlane, dragHit)) return;
    furniture.place(drag.item, drag.x + dragHit.x - drag.start.x, drag.z + dragHit.z - drag.start.z);
  });

  function endDrag(e) {
    if (!drag || e.pointerId !== drag.id) return;
    if (drag.moving) furniture.save();
    drag = null;
    canvas.style.cursor = e.pointerType === 'mouse' ? 'grab' : '';
  }
  stage.addEventListener('pointerup', endDrag);
  stage.addEventListener('pointercancel', endDrag);

  // Undo: each drag, turn, reset, finish or model change is one step; a run of arrow-key nudges
  // (or of swatches tried in one option group) on one piece is one step. "Apply to all", adding or
  // removing a piece and a preset are one step too.
  const history = [];
  let nudging = null;
  function remember(item, run = false) {
    const items = [].concat(item);
    if (run && items.length === 1 && nudging?.item === item && nudging.run === run) return;
    nudging = run && items.length === 1 ? { item, run } : null;
    history.push(items.map((it) => furniture.snapshot(it)));
    if (history.length > 50) history.shift();
    renderEditor();
  }
  function undo() {
    if (applying != null) return; // a preset is still going on: its own step can't be undone halfway
    const last = history.pop();
    if (!last) return;
    nudging = null;
    if (furniture.selected && last.some((s) => s.item === furniture.selected && !s.present)) selectItem(null);
    Promise.all(last.map((s) => furniture.restore(s))).then(() => {
      renderEditor();
      invalidate();
      say('Undone');
    });
    renderEditor();
  }

  // What's selected can be a piece of furniture or one of the room's fittings (fixtures.js:
  // the light, doors, window, curtains), which only get the info card. piece(): furniture only.
  const piece = () => (furniture.selected?.kind === 'fixture' ? null : furniture.selected);

  function selectItem(item) {
    furniture.select(item);
    nudging = null;
    renderEditor();
    invalidate();
  }

  function renderEditor() {
    const item = piece();
    furniture.setEditing(state.edit);
    document.getElementById('ed-idle').hidden = !!item;
    document.getElementById('ed-item').hidden = !item;
    for (const id of ['sel-rotate', 'sel-reset']) document.getElementById(id).hidden = !item || item.home.movable === false;
    document.getElementById('sel-done').hidden = !item;
    document.getElementById('sel-remove').hidden = !item?.home.optional;
    const undoButton = document.getElementById('sel-undo');
    undoButton.disabled = history.length === 0 || applying != null;
    undoButton.title = history.length ? 'Undo the last change (Ctrl+Z)' : 'Nothing to undo yet';
    // Pieces in the room select; optional ones that aren't (the pouf) can be added.
    document.getElementById('ed-pieces').replaceChildren(
      ...furniture.items.map((it) => el('button', {
        type: 'button', class: it.present ? null : 'ed-add', title: it.present ? null : `Add the ${it.spec.name} to the room`,
        on: { click: () => (it.present ? selectItem(it) : addPiece(it)) },
      }, it.present ? it.home.label ?? it.spec.name : `+ ${it.home.label ?? it.spec.name}`)),
    );
    renderPresets();
    renderPopup(furniture.selected);
    renderFinish(item);
    if (item) {
      const d = furniture.describe(item);
      const link = document.getElementById('sel-name');
      link.textContent = titleOf(d, item);
      if (d.url) link.href = d.url;
      else link.removeAttribute('href');
      // On phones the finish is in the Finish line below, so this stays one short line.
      document.getElementById('sel-size').textContent = [cm(d.size), narrowScreen() ? null : d.finish, priceText(d)].filter(Boolean).join(' · ');
    }
    fitEditor();
  }

  // ---- Info card and finish pickers (helpers for renderEditor) ----
  const host = (url) => new URL(url).hostname.replace(/^www\./, '');
  const cm = ({ w, d, h }) => `${Math.round(w * 100)} × ${Math.round(d * 100)} × ${Math.round(h * 100)} cm`;
  // Whole amounts as they are (EUR 1,749); others with their rappen (CHF 166.60).
  const money = (n, cur = 'EUR') => `${cur} ${n.toLocaleString('en-US', { minimumFractionDigits: Number.isInteger(n) ? 0 : 2, maximumFractionDigits: 2 })}`;
  const priceText = (d) => (d.price ? money(d.price.amount, d.price.currency) : d.offered ? '' : 'not sold in this size');
  // A piece is named with its maker (Muuto Outline…, IKEA ASKHOLMEN…), except a model that isn't a
  // product you can buy (a plant), or a print, which is named by its artwork.
  const titleOf = (d, item) => ((d.source && !d.shop) || item.spec.category === 'art' ? d.name : `${d.maker} ${d.name}`);
  const narrowScreen = () => window.innerWidth < 640;
  const coarse = window.matchMedia('(pointer: coarse)');
  const swatchSize = () => (coarse.matches ? 40 : 30); // px, matches .swatch in index.html
  const say = announce; // polite live region (screen readers)

  // The panels at the top: the room card and the looks.
  const topPanels = () => ['info', 'presets'].map((id) => document.getElementById(id).getBoundingClientRect());

  // The edit panel is a bottom sheet: never taller than the space between the top panels (those
  // it would overlap) and the dock rows under it, and at most 40% of a phone's height; it scrolls inside.
  function fitEditor() {
    if (editor.hidden) return;
    const r = editor.getBoundingClientRect();
    const above = topPanels().filter((p) => p.height > 0 && p.right > r.left && p.left < r.right);
    let max = r.bottom - Math.max(12, ...above.map((p) => p.bottom + 8));
    if (narrowScreen()) max = Math.min(max, window.innerHeight * 0.4);
    // max-height counts the content box; take off the panel's own padding and border.
    const cs = getComputedStyle(editor);
    max -= ['paddingTop', 'paddingBottom', 'borderTopWidth', 'borderBottomWidth'].reduce((t, k) => t + parseFloat(cs[k]), 0);
    editor.style.maxHeight = `${Math.max(72, Math.floor(max))}px`;
  }
  const panelResize = new ResizeObserver(() => fitEditor());
  for (const id of ['info', 'presets']) panelResize.observe(document.getElementById(id));
  window.addEventListener('resize', fitEditor);

  function el(tag, attrs = {}, ...children) {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === 'class') n.className = v;
      else if (k === 'on') for (const [ev, fn] of Object.entries(v)) n.addEventListener(ev, fn);
      else n.setAttribute(k, v === true ? '' : v);
    }
    n.append(...children.flat().filter((c) => c != null && c !== false));
    return n;
  }

  // The card keeps clear of the top panels (on phones they sit above the model) and the dock.
  furniture.popupBounds = () => {
    const panels = topPanels();
    const dock = document.getElementById('dock').getBoundingClientRect();
    return { top: narrowScreen() ? Math.max(...panels.map((p) => p.bottom)) + 8 : 12, bottom: dock.top - 8, avoid: panels };
  };

  // The info card is a non-modal dialog. Opened from a control (the piece list, a keyboard), it
  // takes focus on its title and gives it back to that control when it closes.
  let popupKey = null, popupFor = null, popupOpener = null;
  function renderPopup(item) {
    const { object, card } = furniture.popup;
    // While editing on a phone the dock already shows a piece's details, so its card steps aside.
    const fixture = item?.kind === 'fixture';
    const show = !!item && (fixture || !(state.edit && narrowScreen()));
    object.visible = show;
    if (!show) {
      popupKey = null;
      if (popupFor) closedPopup(card);
      return;
    }
    const opened = popupFor !== item;
    popupFor = item;
    const key = JSON.stringify(fixture ? [item.id, item.state(), item.actions().map((a) => a.label)] : [item.id, item.key, item.variant, item.choices, state.edit, lightOf(item)?.state]);
    if (key !== popupKey) {
      popupKey = key;
      (fixture ? fillFixture : fillPopup)(item, card);
    }
    const from = document.activeElement;
    if (opened && !state.edit && from && from !== document.body && from !== canvas && !card.contains(from)) {
      popupOpener = from;
      requestAnimationFrame(() => card.querySelector('.sel-pop-titles')?.focus());
    }
  }
  function closedPopup(card) {
    popupFor = null;
    const back = popupOpener;
    popupOpener = null;
    const lost = !document.activeElement || document.activeElement === document.body || card.contains(document.activeElement);
    if (back?.isConnected && lost) back.focus();
  }
  function fillPopup(item, card) {
    const d = furniture.describe(item);
    const titleId = `sel-pop-title-${item.id}`;
    const light = lightOf(item); // a lamp's own switch
    const refocus = light && card.contains(document.activeElement) && document.activeElement.closest('.sel-pop-actions');
    card.setAttribute('role', 'dialog');
    card.setAttribute('aria-modal', 'false');
    card.setAttribute('aria-labelledby', titleId);
    const price = priceText(d);
    card.replaceChildren(...[
      el('div', { class: 'sel-pop-head' },
        el('div', { class: 'sel-pop-titles', id: titleId, tabindex: '-1' },
          el('span', { class: 'sel-pop-label' }, d.label),
          // A model that isn't a maker's product (a plant) is named on its own; its source is below.
          el(d.url ? 'a' : 'span', { class: 'sel-pop-name', href: d.url, target: d.url && '_blank', rel: d.url && 'noopener' }, titleOf(d, item))),
        el('button', { type: 'button', class: 'sel-pop-close', 'aria-label': 'Close', title: 'Close (Esc)', on: { click: () => selectItem(null) } }, '×')),
      el('dl', { class: 'sel-pop-facts' },
        el('div', {}, el('dt', {}, 'Finish'), el('dd', {}, d.finish, d.notes.map((n) => el('small', { class: 'sel-pop-note' }, n)))),
        el('div', {}, el('dt', {}, 'Size'), el('dd', {}, cm(d.size), el('small', {}, ' W × D × H'))),
        price && el('div', {}, el('dt', {}, 'Price'), el('dd', {}, price, d.itemNumber && el('small', {}, ` · ${d.itemNumber}`))),
        d.shop && el('div', {}, el('dt', {}, 'Shop'), el('dd', {},
          el('a', { class: 'sel-pop-link', href: d.shop, target: '_blank', rel: 'noopener' }, `This configuration at ${host(d.shop)} ↗`))),
        // A plant's model, or a print's artwork (its image).
        d.source && el('div', {}, el('dt', {}, item.spec.category === 'art' ? 'Image' : 'Model'), el('dd', {},
          d.source.url ? el('a', { class: 'sel-pop-link', href: d.source.url, target: '_blank', rel: 'noopener' }, `${d.source.name ?? d.maker} ↗`) : d.source.name ?? d.maker,
          el('small', {}, ` · ${d.source.licence}`))),
        light && el('div', {}, el('dt', {}, 'Light'), el('dd', {}, light.state))),
      // A lamp's switch acts right away, like a fitting's; the card is redrawn with the new state.
      light && el('div', { class: 'sel-pop-actions' }, ...light.actions.map((a, i) => el('button', {
        type: 'button', class: i ? 'sel-pop-cta secondary' : 'sel-pop-cta',
        on: { click: () => { a.run(); say(`${d.label}: ${lightOf(item)?.state ?? ''}`); } },
      }, a.label))),
      !state.edit && d.parts.length && el('button', {
        type: 'button', class: light ? 'sel-pop-cta secondary' : 'sel-pop-cta',
        on: { click: () => { setEdit(true); finishPanel.open = true; renderEditor(); } },
      }, 'Change finish'),
    ].filter(Boolean));
    if (refocus) card.querySelector('.sel-pop-actions .sel-pop-cta')?.focus();
  }

  // A fitting's card: what it is, its state, and what it can do (Open / Close, Turn on / off…).
  // Its buttons act right away; the card is re-drawn with the new state (keeping focus on the
  // first button, so the keyboard can toggle it again).
  function fillFixture(f, card) {
    const titleId = `sel-pop-title-${f.id}`;
    const refocus = card.contains(document.activeElement) && document.activeElement.classList.contains('sel-pop-cta');
    card.setAttribute('role', 'dialog');
    card.setAttribute('aria-modal', 'false');
    card.setAttribute('aria-labelledby', titleId);
    const size = `${Math.round(f.size.w * 100)} × ${Math.round(f.size.h * 100)} cm`;
    card.replaceChildren(
      el('div', { class: 'sel-pop-head' },
        el('div', { class: 'sel-pop-titles', id: titleId, tabindex: '-1' },
          el('span', { class: 'sel-pop-label' }, f.label),
          el('span', { class: 'sel-pop-name' }, f.name)),
        el('button', { type: 'button', class: 'sel-pop-close', 'aria-label': 'Close', title: 'Close (Esc)', on: { click: () => selectItem(null) } }, '×')),
      el('dl', { class: 'sel-pop-facts' },
        el('div', {}, el('dt', {}, 'Now'), el('dd', {}, f.state())),
        el('div', {}, el('dt', {}, 'Size'), el('dd', {}, size, el('small', {}, ' W × H')))),
      el('div', { class: 'sel-pop-actions' }, ...f.actions().map((a, i) => el('button', {
        type: 'button', class: i ? 'sel-pop-cta secondary' : 'sel-pop-cta',
        on: { click: () => { a.run(); say(`${f.label}: ${f.state()}`); } },
      }, a.label))),
    );
    if (refocus) card.querySelector('.sel-pop-cta')?.focus();
  }

  const finishPanel = document.getElementById('ed-finish');
  finishPanel.open = !narrowScreen(); // collapsed on phones until asked for
  const browsing = new Map(); // `${item.key}|${group}` → the upholstery family on show
  let finishKey = null;

  function renderFinish(item) {
    const groups = item ? furniture.optionGroups(item) : [];
    const models = item ? furniture.alternatives(item) : [];
    finishPanel.hidden = !groups.length && models.length < 2;
    if (!groups.length) {
      finishKey = null;
      return;
    }
    const d = furniture.describe(item);
    document.getElementById('ed-finish-sum').textContent = [d.finish, priceText(d)].filter(Boolean).join(' · ');
    const copies = furniture.copies(item);
    const all = document.getElementById('ed-apply-all');
    all.hidden = copies.length < 2;
    all.textContent = `Apply to all ${copies.length} ${(item.home.label ?? 'piece').replace(/\s*\d+$/, '').toLowerCase()}s`;
    all.disabled = copies.every((c) => JSON.stringify(c.choices) === JSON.stringify(item.choices));
    document.getElementById('ed-default').disabled = furniture.isDefault(item);
    // The pouf takes the sofa's upholstery and base until it's given its own.
    document.getElementById('ed-match').hidden = !item.home.match;
    document.getElementById('ed-match-box').checked = !!item.matching;
    const key = JSON.stringify([item.id, item.key, item.choices, item.matching, [...browsing]]);
    if (key === finishKey) return;
    finishKey = key;
    const focused = document.activeElement?.closest?.('.ed-group')?.dataset.group;
    const box = document.getElementById('ed-groups');
    box.replaceChildren(...(models.length > 1 ? [modelGroup(item, models)] : []), ...groups.map((g) => finishGroup(item, g)));
    // Keep keyboard focus on the same group after the rebuild, and the chosen swatch in view.
    for (const row of box.querySelectorAll('.swatches')) {
      const on = row.querySelector('[aria-checked="true"]');
      if (on) row.scrollLeft = Math.max(0, on.offsetLeft - row.clientWidth / 2 + swatchSize() / 2);
    }
    if (focused) box.querySelector(`.ed-group[data-group="${focused}"] .swatch[tabindex="0"]`)?.focus({ preventScroll: true });
  }

  function finishGroup(item, g) {
    const labelId = `ed-g-${g.id}`;
    const choice = g.choice;
    const extra = (o) => (g.price === 'add' && o.price ? ` (+${money(o.price, item.options?.currency)})` : '');
    const head = el('div', { class: 'ed-group-head' },
      el('span', { class: 'ed-group-label', id: labelId }, g.label),
      el('span', { class: 'ed-choice' }, `${choice.name}${extra(choice)}`));
    let options = g.options;
    if (g.families?.length) {
      const bkey = `${item.key}|${g.id}`;
      const fam = browsing.get(bkey) ?? choice.family;
      const select = el('select', { class: 'ed-family', 'aria-label': `${g.label}: fabric or leather family` },
        g.families.map((f) => {
          const n = g.options.filter((o) => o.family === f.id).length;
          const price = typeof f.price === 'number' ? ` · ${money(f.price)}` : '';
          const o = new Option(`${f.name} (${n})${price}`, f.id, false, f.id === fam);
          return o;
        }));
      select.addEventListener('change', () => {
        browsing.set(bkey, select.value);
        renderFinish(item);
      });
      head.append(select);
      options = g.options.filter((o) => o.family === fam);
    }
    const list = el('div', { class: 'swatches', role: 'radiogroup', 'aria-labelledby': labelId });
    for (const o of options) {
      const name = `${o.name}${extra(o)}${o.approx ? ' (colour approximated; Muuto shows no swatch)' : ''}${o.offered === false ? ` (${o.note ?? 'not sold in this size'})` : ''}`;
      const b = el('button', {
        type: 'button', role: 'radio', class: `swatch${o.approx ? ' swatch-approx' : ''}${o.offered === false ? ' swatch-unsold' : ''}`,
        'aria-checked': String(o === choice), tabindex: o === choice ? '0' : '-1', 'aria-label': name, title: name,
        on: { click: () => chooseOption(item, g.id, o.id) },
      });
      Object.assign(b.style, furniture.swatchStyle(item, g, o, swatchSize()));
      list.append(b);
    }
    if (!list.querySelector('[tabindex="0"]')) list.firstElementChild?.setAttribute('tabindex', '0');
    // Arrow keys move along the swatches and pick them, like radio buttons.
    list.addEventListener('keydown', (e) => {
      const all = [...list.children], i = all.indexOf(document.activeElement);
      const to = { ArrowRight: i + 1, ArrowDown: i + 1, ArrowLeft: i - 1, ArrowUp: i - 1, Home: 0, End: all.length - 1 }[e.key];
      if (to == null || i < 0) return;
      e.preventDefault();
      const next = all[(to + all.length) % all.length];
      next.focus();
      next.click();
    });
    return el('div', { class: 'ed-group', 'data-group': g.id }, head, list);
  }

  function chooseOption(item, groupId, optionId) {
    if (item.choices[groupId] === optionId) return;
    remember(item, `finish:${groupId}`);
    if (item.home.match && item.matching) furniture.setMatching(item, false); // its own finish from now on
    track('Loading the finish', furniture.setOption(item, groupId, optionId)).then(() => {
      renderEditor();
      invalidate();
      const g = furniture.optionGroups(item).find((x) => x.id === groupId);
      say(`${item.home.label}: ${g?.label ?? groupId} ${g?.choice?.name ?? ''}`);
    });
    renderEditor();
  }

  // Which product stands in this spot (the sofa: In Situ or Outline). The fabric carries over
  // where the other product offers it; the rest starts from that product's defaults.
  function modelGroup(item, models) {
    const select = el('select', { class: 'ed-family ed-model', 'aria-labelledby': 'ed-g-model' },
      models.map(({ key, spec }) => new Option(`${spec.maker} ${spec.name}`, key, false, key === item.key)));
    select.addEventListener('change', () => {
      const followers = furniture.items.filter((o) => o.home.match === item.id && o.matching);
      remember([item, ...followers]);
      track(`Loading the ${models.find((m) => m.key === select.value)?.spec.name ?? 'model'}`, furniture.setProduct(item, select.value, item.choices)).then(async () => {
        for (const o of followers) await furniture.setMatching(o, true);
        renderEditor();
        invalidate();
        say(`${item.home.label}: now the ${item.spec.maker} ${item.spec.name}`);
      });
    });
    return el('div', { class: 'ed-group', 'data-group': 'model' },
      el('div', { class: 'ed-group-head' }, el('span', { class: 'ed-group-label', id: 'ed-g-model' }, 'Model')),
      select);
  }

  // Adding or removing the pouf can move the sofa too (it makes room), so undo covers both.
  const withHost = (item) => [item, furniture.hostOf(item)].filter(Boolean);

  function addPiece(item) {
    remember(withHost(item));
    furniture.setPresent(item, true);
    selectItem(item);
    say(`${item.home.label} added`);
  }

  // ---- Presets: whole-room looks, in the panel at the top right (works in every view) ----
  // One button per look, then "Custom": the room as the viewer had it before picking a look, so
  // trying the looks never loses their own finishes, and "None": the empty room (the furniture
  // is hidden, not changed). Each look picked is one undo step.
  const presetList = document.getElementById('presets-list');
  const presetCurrent = document.getElementById('presets-current');
  // A preset's maker (e.g. "Muuto", or "Muuto · HAY") is a small label above its name.
  const presetButton = (id, name, summary, note, maker) => el('button', {
    type: 'button', class: 'preset', 'data-preset': id, 'aria-pressed': 'false', disabled: true, title: note,
    on: { click: () => pickPreset(id) },
  }, el('span', { class: 'preset-dots', 'aria-hidden': 'true' }),
  el('span', { class: 'preset-text' },
    maker && el('span', { class: 'preset-maker' }, maker),
    el('span', { class: 'preset-name' }, name), el('span', { class: 'preset-sum' }, summary)));
  const fullName = (p) => (p.maker ? `${p.maker} ${p.name}` : p.name);
  // The presets come with the catalog (assets/catalog/presets.json), so the list is built once it
  // has loaded; until then it shows placeholders.
  let customRow = null;
  function buildPresetList() {
    presetList.replaceChildren(
      ...furniture.presets.map((p) => el('li', {}, presetButton(p.id, p.name, p.summary, p.note, p.maker))),
      el('li', { id: 'preset-custom', hidden: true }, presetButton('', 'Custom', 'Your own finishes and pieces')),
      el('li', {}, presetButton('none', 'None', 'The empty room, without furniture')),
    );
    presetList.querySelector('[data-preset="none"] .preset-dots').replaceChildren(el('span', { class: 'preset-empty' }));
    customRow = document.getElementById('preset-custom');
  }

  // The preset shown is in the page's link, so it can be shared: …#preset=wood-white (or none).
  // Plain #tokens, which the artifact viewer passes through.
  const PRESET_LINK = /(?:^#|&)preset=([a-z0-9-]+)/;
  function linkedPreset() {
    const id = location.hash.match(PRESET_LINK)?.[1];
    return id && (id === 'none' || !furniture.presets.length || furniture.presets.some((p) => p.id === id)) ? id : null;
  }
  let linkShown;
  function showLink(id) {
    if (id === linkShown) return;
    linkShown = id;
    try {
      // (window.history: `history` here is the undo list.)
      window.history.replaceState(window.history.state, '', id ? `#preset=${id}` : location.pathname + location.search);
    } catch {
      // Some embeddings don't allow it; the link just doesn't follow.
    }
  }
  addEventListener('hashchange', () => {
    if (!furniture.items.length) return; // still loading: main.js applies the link once the room is in
    const id = linkedPreset();
    if (id && id !== linkShown) pickPreset(id);
  });
  let custom = null; // every piece's snapshot, taken when a look replaced a room that matched none
  let applying = null, queued = null; // the look being applied, and the latest one picked meanwhile
  const piecesOf = (snapshots) => Object.fromEntries(snapshots.map((s) => [s.item.id, { item: s.key, choices: s.choices }]));

  function pickPreset(id) {
    if (applying != null) {
      queued = id; // applied when the current one is done; only the latest pick counts
      renderPresets();
      return;
    }
    if (id === 'none') {
      if (!state.furniture) return;
      if (furniture.selected) selectItem(null);
      setFurniture(false);
      renderEditor();
      say('The empty room');
      return;
    }
    const current = furniture.currentPreset() ?? '';
    const preset = furniture.presets.find((p) => p.id === id);
    if (id === current) {
      // Back from None to the look the furniture already has.
      if (!state.furniture) {
        setFurniture(true);
        renderEditor();
        say(`Furniture back: ${preset?.name ?? 'your own finishes and pieces'}`);
      }
      return;
    }
    if (!preset && !custom) return;
    remember(furniture.items);
    if (!current) custom = furniture.items.map((it) => furniture.snapshot(it));
    const target = preset ? null : new Map(custom.map((s) => [s.item, s]));
    const leaving = piece() && (preset ? furniture.presetFor(preset, piece())?.present === false : !target.get(piece()).present);
    if (leaving) selectItem(null);
    setFurniture(true);
    applying = id;
    renderEditor(); // the presets, and Undo off until it's done
    const work = preset ? furniture.applyPreset(id) : Promise.all([...target.values()].map((s) => furniture.restore(s)));
    track(preset ? `Applying ${preset.name}` : 'Going back to your changes', work)
      .catch((err) => console.error(err))
      .then(() => {
        applying = null;
        renderEditor();
        invalidate();
        say(preset ? `Preset applied: ${fullName(preset)}` : 'Back to your own finishes and pieces');
        if (queued != null) {
          const next = queued;
          queued = null;
          pickPreset(next);
        }
      });
  }

  let painted = false, customKey = '';
  function paint(button, pieces) {
    furniture.paletteOf(pieces).then((colors) => {
      button.querySelector('.preset-dots').replaceChildren(...colors.map((c) => el('span', { style: `background-color: ${c.color}` })));
    });
  }
  function renderPresets() {
    const ready = furniture.items.length > 0;
    if (ready && !customRow) buildPresetList();
    if (!customRow) return;
    const matched = ready ? furniture.currentPreset() ?? '' : null;
    const shown = queued ?? applying ?? (ready && !state.furniture ? 'none' : matched);
    for (const b of presetList.querySelectorAll('.preset')) {
      b.setAttribute('aria-pressed', String(b.dataset.preset === shown));
      b.disabled = !ready;
    }
    customRow.hidden = !(shown === '' || custom);
    const current = furniture.presets.find((p) => p.id === shown);
    presetCurrent.textContent = shown == null ? '' : shown === 'none' ? 'None' : current ? fullName(current) : 'Custom';
    if (!ready) return;
    if (applying == null && queued == null) showLink(shown || null); // Custom has no link
    // The looks' colours once; Custom's whenever the pieces it shows change.
    if (!painted) for (const p of furniture.presets) paint(presetList.querySelector(`[data-preset="${p.id}"]`), p.pieces);
    painted = true;
    if (customRow.hidden) return;
    const pieces = piecesOf(matched === '' ? furniture.items.map((it) => furniture.snapshot(it)) : custom ?? []);
    const key = JSON.stringify(pieces);
    if (key !== customKey) paint(customRow.firstChild, pieces);
    customKey = key;
  }

  // Arrow keys nudge relative to the screen: ↑ moves the piece away from you along
  // whichever room axis is closest to the view direction. In Plan, ↑ is toward the window wall.
  function screenAxes() {
    const f = getCamera().getWorldDirection(new THREE.Vector3());
    if (state.mode === 'plan' || Math.hypot(f.x, f.z) < 1e-3) f.set(0, 0, -1);
    const fwd = Math.abs(f.x) > Math.abs(f.z) ? [Math.sign(f.x), 0] : [0, Math.sign(f.z)];
    return { fwd, right: [-fwd[1], fwd[0]] };
  }

  window.addEventListener('keydown', (e) => {
    if (e.altKey) return;
    // Keys pressed in the finish pickers stay there (arrows move between swatches).
    if (e.key !== 'Escape' && e.target.closest?.('.ed-finish, select, input, textarea')) return;
    if (!state.edit) {
      // Outside Edit the only thing open is the info card.
      if (e.key === 'Escape' && furniture.selected) selectItem(null);
      return;
    }
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') {
      undo();
      e.preventDefault();
      return;
    }
    if (e.metaKey || e.ctrlKey) return;
    const item = piece();
    if (e.key === 'Escape') return furniture.selected ? selectItem(null) : setEdit(false);
    if (!item || item.home.movable === false) return;
    const { fwd, right } = screenAxes();
    const dir = { ArrowUp: fwd, ArrowDown: [-fwd[0], -fwd[1]], ArrowRight: right, ArrowLeft: [-right[0], -right[1]] }[e.key];
    if (dir) {
      const step = e.shiftKey ? 0.1 : 0.01;
      remember(item, true);
      furniture.place(item, item.x + dir[0] * step, item.z + dir[1] * step, item.rotation, { snap: false });
      furniture.save();
      sayWhere(item);
      e.preventDefault();
    } else if (e.key === 'r' || e.key === 'R') {
      remember(item);
      furniture.rotate(item, e.shiftKey ? -90 : 90);
      sayWhere(item);
    }
  });

  // "Sofa: 0.02 m from the left wall, 0.15 m from the window wall, turned 90°", once the keys settle.
  let whereTimer = 0;
  function sayWhere(item) {
    clearTimeout(whereTimer);
    whereTimer = setTimeout(() => {
      const f = furniture.footprint(item);
      const side = f.x0 <= W - f.x1 ? `${f.x0.toFixed(2)} m from the left wall` : `${(W - f.x1).toFixed(2)} m from the right wall`;
      const end = f.z0 <= L - f.z1 ? `${f.z0.toFixed(2)} m from the window wall` : `${(L - f.z1).toFixed(2)} m from the door wall`;
      say(`${item.home.label}: ${side}, ${end}, turned ${item.rotation}°`);
    }, 450);
  }

  document.getElementById('sel-rotate').addEventListener('click', () => {
    remember(furniture.selected);
    furniture.rotate(furniture.selected);
  });
  document.getElementById('sel-reset').addEventListener('click', () => {
    remember(furniture.selected);
    furniture.reset(furniture.selected);
  });
  document.getElementById('sel-undo').addEventListener('click', undo);
  document.getElementById('sel-done').addEventListener('click', () => selectItem(null));
  // Finishes are reset separately from the position, so moving a piece back keeps the fabric you picked.
  document.getElementById('ed-default').addEventListener('click', () => {
    const item = furniture.selected;
    remember(item);
    furniture.resetOptions(item).then(renderEditor);
  });
  document.getElementById('ed-apply-all').addEventListener('click', () => {
    const item = furniture.selected;
    remember(furniture.copies(item).filter((c) => c !== item));
    furniture.applyToCopies(item).then(renderEditor);
  });
  document.getElementById('sel-remove').addEventListener('click', () => {
    const item = furniture.selected;
    remember(withHost(item));
    selectItem(null);
    furniture.setPresent(item, false);
    renderEditor();
    say(`${item.home.label} removed`);
  });
  document.getElementById('ed-match-box').addEventListener('change', (e) => {
    const item = furniture.selected;
    remember(item);
    furniture.setMatching(item, e.target.checked).then(() => {
      renderEditor();
      invalidate();
    });
  });
  window.addEventListener('resize', () => renderPopup(furniture.selected));
  finishPanel.addEventListener('toggle', fitEditor);

  // dragging(): a piece is being dragged right now (main.js can leave its shadow until it's put down).
  return { selectItem, undo, renderEditor, openPreset: (id) => pickPreset(id), linkedPreset, dragging: () => !!drag?.moving };
}
