// The settings panel: a gear button opens a small non-modal dialog with "Show measurements"
// and the rendering quality (quality.js). Self-contained: it builds its own markup, appended to
// <body>, and places itself next to the button wherever that sits (above it in the lower half
// of the screen, below it in the upper half), so the button can move without touching this.
// Keyboard: Enter/Space on the gear opens it with focus on the chosen quality; arrow keys
// move between the levels (native radios); Esc or × closes it and focus returns to the gear.
// A press anywhere outside closes it too.

import { LEVELS, ORDER } from '../quality.js';

// button: the gear <button>. quality: from createQuality(). dims: { get(), set(on) }.
// describe(): a line about what's drawn now ("1.5× resolution · 1024 px shadows").
// reload(): reloads the page, keeping the view (main.js).
export function createSettings({ button, quality, dims, describe = () => '', reload = () => location.reload(), announce = () => {} }) {
  const el = (tag, attrs = {}, ...children) => {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === 'class') n.className = v;
      else if (k === 'text') n.textContent = v;
      else n.setAttribute(k, v === true ? '' : v);
    }
    n.append(...children.filter((c) => c != null));
    return n;
  };

  const choices = [
    { id: 'auto', name: 'Auto', summary: '' },
    ...ORDER.map((id) => ({ id, name: LEVELS[id].name, summary: LEVELS[id].summary })),
  ];
  const close = el('button', { type: 'button', class: 'settings-close', 'aria-label': 'Close settings', title: 'Close (Esc)', text: '×' });
  const dimsBox = el('input', { type: 'checkbox', id: 'settings-dims' });
  const radios = choices.map((c) => el('input', { type: 'radio', name: 'settings-quality', value: c.id, id: `settings-q-${c.id}`, 'aria-describedby': `settings-q-${c.id}-d` }));
  const descs = choices.map((c) => el('span', { class: 'settings-desc', id: `settings-q-${c.id}-d`, text: c.summary }));
  const reloadButton = el('button', { type: 'button', class: 'settings-reload-button', text: 'Reload now' });
  const reloadNote = el('p', { class: 'settings-reload', hidden: true }, el('span', { class: 'settings-reload-text' }), ' ', reloadButton);
  const now = el('p', { class: 'settings-now', 'aria-live': 'polite' });

  const panel = el('section', { id: 'settings', class: 'settings-panel', role: 'dialog', 'aria-modal': 'false', 'aria-labelledby': 'settings-title', hidden: true },
    el('div', { class: 'settings-head' }, el('h2', { id: 'settings-title', text: 'Settings' }), close),
    el('label', { class: 'settings-switch', for: 'settings-dims' }, dimsBox, el('span', { text: 'Show measurements' })),
    el('fieldset', { class: 'settings-quality' },
      el('legend', { text: 'Rendering quality' }),
      ...choices.map((c, i) => el('label', { class: 'settings-option', for: radios[i].id }, radios[i],
        el('span', { class: 'settings-text' }, el('span', { class: 'settings-name', text: c.name }), descs[i])))),
    reloadNote,
    now);
  document.body.append(panel);
  button.setAttribute('aria-haspopup', 'dialog');
  button.setAttribute('aria-controls', panel.id);
  button.setAttribute('aria-expanded', 'false');

  function render() {
    for (const r of radios) r.checked = r.value === quality.choice;
    descs[0].textContent = quality.reason;
    // While on Auto, the level it picked is marked too.
    choices.forEach((c, i) => radios[i].closest('.settings-option').classList.toggle('settings-auto-pick', quality.choice === 'auto' && c.id === quality.level));
    reloadNote.hidden = !quality.needsReload;
    reloadNote.firstChild.textContent = LEVELS[quality.level].antialias ? 'Smooth edges come back after a reload.' : 'Turning off edge smoothing needs a reload.';
    dimsBox.checked = !!dims.get();
    now.textContent = describe();
  }

  // Next to the button, inside the screen: above it if the button is in the lower half.
  function place() {
    const b = button.getBoundingClientRect();
    const vw = document.documentElement.clientWidth, vh = window.innerHeight, m = 8;
    panel.style.maxHeight = '';
    const w = panel.offsetWidth;
    const left = Math.min(Math.max(m, b.right - w), vw - m - w);
    panel.style.left = `${Math.round(Math.max(m, left))}px`;
    const below = b.top + b.height / 2 < vh / 2;
    const room = below ? vh - b.bottom - 2 * m : b.top - 2 * m;
    panel.style.maxHeight = `${Math.max(160, Math.floor(room))}px`;
    const h = Math.min(panel.offsetHeight, room);
    panel.style.top = `${Math.round(below ? b.bottom + m : Math.max(m, b.top - m - h))}px`;
  }

  let opener = null;
  function open() {
    render();
    panel.hidden = false;
    button.setAttribute('aria-expanded', 'true');
    place();
    opener = document.activeElement;
    (radios.find((r) => r.checked) ?? dimsBox).focus({ preventScroll: true });
  }
  function hide({ focus = true } = {}) {
    if (panel.hidden) return;
    panel.hidden = true;
    button.setAttribute('aria-expanded', 'false');
    if (focus && (panel.contains(document.activeElement) || document.activeElement === document.body)) (opener?.isConnected ? opener : button).focus({ preventScroll: true });
  }

  button.addEventListener('click', () => (panel.hidden ? open() : hide()));
  close.addEventListener('click', () => hide());
  panel.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.stopPropagation(); // not also "leave Edit" or "close the info card"
      hide();
    } else if (e.key.startsWith('Arrow') || e.key === ' ') {
      e.stopPropagation(); // the radios' own keys: not also walking or nudging furniture
    }
  });
  // Esc from anywhere while it's open (focus may be on the gear).
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !panel.hidden && !panel.contains(e.target)) {
      e.stopImmediatePropagation();
      hide();
    }
  }, true);
  document.addEventListener('pointerdown', (e) => {
    if (!panel.hidden && !panel.contains(e.target) && !button.contains(e.target)) hide({ focus: false });
  }, true);
  window.addEventListener('resize', () => !panel.hidden && place());

  dimsBox.addEventListener('change', () => {
    dims.set(dimsBox.checked);
    announce(dimsBox.checked ? 'Measurements shown' : 'Measurements hidden');
  });
  for (const r of radios) {
    r.addEventListener('change', () => {
      if (!r.checked) return;
      quality.set(r.value);
      announce(`Rendering quality: ${r.value === 'auto' ? `Auto, ${LEVELS[quality.level].name}` : LEVELS[r.value].name}`);
    });
  }
  reloadButton.addEventListener('click', () => reload());
  quality.onChange(() => !panel.hidden && (render(), place()));

  return { open, close: hide, render, panel, get isOpen() { return !panel.hidden; } };
}
