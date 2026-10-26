// The Sun control in the toolbar (index.html): one tap switches between day and evening, which is
// what most people want to see; the chevron next to it, or a long press on the button on phones
// (where the chevron is hidden), opens a small panel with the time of day and the month, for the
// real sun at a given moment. The slider and the month in that panel are what main.js reads to
// place the sun, so this only sets them and tells main.js (an 'input' event).
//
// Day is 13:00. Evening is just after dusk for the chosen month (the first quarter hour with the
// sun 4° below the horizon), when the ceiling light comes on by itself; in June that's about
// 22:00, in December about 17:15.
//
// button: the Day/Evening switch (aria-pressed = evening). more: the chevron that opens the panel.
// panel: the [role="dialog"] with the slider (`time`) and the month select (`month`).
// elevationAt(hours, monthIndex): the sun's elevation in degrees, from main.js.
import { createPopover } from './popover.js';

const DAY = 13;
const DUSK = -4; // degrees below the horizon

export function createSunControl({ button, more, panel, time, month, elevationAt, announce = () => {} }) {
  const clock = (h) => `${String(Math.floor(h)).padStart(2, '0')}:${String(Math.round((h % 1) * 60)).padStart(2, '0')}`;
  const evening = () => elevationAt(Number(time.value), Number(month.value)) < 0;
  function dusk(m) {
    for (let h = Number(time.min) || 6; h <= (Number(time.max) || 23); h += Number(time.step) || 0.25) if (elevationAt(h, m) < DUSK) return h;
    return Number(time.max) || 23;
  }
  function set(hours) {
    time.value = String(hours);
    time.dispatchEvent(new Event('input', { bubbles: true })); // main.js places the sun
  }
  function render() {
    const e = evening();
    button.setAttribute('aria-pressed', String(e));
    button.title = e ? 'Evening now. Switch to day (13:00). Hold for the time of day' : 'Day now. Switch to evening, when the ceiling light comes on. Hold for the time of day';
  }
  function toggle() {
    const to = evening() ? DAY : dusk(Number(month.value));
    set(to);
    render();
    announce(evening() ? `Evening, ${clock(to)}: the ceiling light is on` : `Day, ${clock(to)}`);
  }

  const pop = createPopover({ button: more, panel, anchor: () => (more.offsetParent ? more : button), focus: () => time, onOpen: render });
  panel.querySelector('.settings-close')?.addEventListener('click', () => pop.close());

  // A long press on the switch opens the panel too (phones hide the chevron to keep the toolbar
  // one row); the click that follows the press is then not a toggle.
  let timer = 0, held = false;
  button.addEventListener('pointerdown', () => {
    held = false;
    clearTimeout(timer);
    timer = setTimeout(() => {
      held = true;
      pop.open();
    }, 550);
  });
  for (const type of ['pointerup', 'pointercancel', 'pointerleave']) button.addEventListener(type, () => clearTimeout(timer));
  button.addEventListener('contextmenu', (e) => e.preventDefault());
  button.addEventListener('click', () => {
    if (held) {
      held = false;
      return;
    }
    toggle();
  });
  // The slider and month keep the switch's state right (the sun may set under the slider).
  time.addEventListener('input', render);
  month.addEventListener('change', render);

  return {
    toggle,
    render,
    // Until the neighbourhood (and with it the real sun) has loaded, the control waits.
    enable() {
      button.disabled = more.disabled = false;
      render();
    },
    open: pop.open,
    close: pop.close,
    get isOpen() {
      return pop.isOpen;
    },
    get evening() {
      return evening();
    },
  };
}
