// A small non-modal dialog that opens from a button and places itself next to it, wherever that
// sits (below it in the upper half of the screen, above it in the lower half), inside the screen.
// Shared by the settings panel (settings.js) and the sun panel (sun.js).
//
// Keyboard: the button opens it with focus inside (`focus()` says where, the panel otherwise);
// Esc, or the panel's own close button, closes it and focus goes back to where it came from. A
// press anywhere outside closes it too. Arrow keys and Space inside stay inside (the panel's
// own controls), so they don't also orbit the view, walk, or nudge furniture.
//
// button: the <button> that opens it (gets aria-haspopup / aria-controls / aria-expanded).
// panel: a [role="dialog"] element, hidden to start with, placed with position: fixed.
// anchor(): the element to place the panel next to (the button, unless that's hidden).
// onOpen(): fills the panel before it shows.

export function createPopover({ button, panel, anchor = () => button, focus = () => null, onOpen = () => {} }) {
  if (!panel.id) panel.id = `popover-${Math.random().toString(36).slice(2, 8)}`;
  button.setAttribute('aria-haspopup', 'dialog');
  button.setAttribute('aria-controls', panel.id);
  button.setAttribute('aria-expanded', 'false');

  function place() {
    const b = (anchor() ?? button).getBoundingClientRect();
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
    onOpen();
    panel.hidden = false;
    button.setAttribute('aria-expanded', 'true');
    place();
    opener = document.activeElement;
    const target = focus() ?? panel;
    if (target === panel) panel.tabIndex = -1;
    target.focus({ preventScroll: true });
  }
  function hide({ focus: giveBack = true } = {}) {
    if (panel.hidden) return;
    panel.hidden = true;
    button.setAttribute('aria-expanded', 'false');
    const inside = panel.contains(document.activeElement) || document.activeElement === document.body;
    if (giveBack && inside) (opener?.isConnected ? opener : button).focus({ preventScroll: true });
  }

  button.addEventListener('click', () => (panel.hidden ? open() : hide()));
  panel.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.stopPropagation(); // not also "leave Edit" or "close the info card"
      hide();
    } else if (e.key.startsWith('Arrow') || e.key === ' ') {
      e.stopPropagation(); // the panel's own keys: not also walking or nudging furniture
    }
  });
  // Esc from anywhere while it's open (focus may be on the button).
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

  return {
    open,
    close: hide,
    toggle: () => (panel.hidden ? open() : hide()),
    place,
    get isOpen() {
      return !panel.hidden;
    },
  };
}
