// The room card's layout check (index.html #info): the score in the card's title line, and, when
// the card is unfolded, the checks with a reason each (furniture/layout-check.js). While the card
// is open the practice zone and the line between the doors are drawn on the floor
// (scene/layout-overlay.js), so a reason can be seen as well as read.
//
// toggle: the card's fold button (aria-expanded says whether the card is open).
// score: the element in the title line. list: the <ul> for the checks. overlay: createLayoutOverlay().

const MARKS = { pass: ['✓', 'passes'], warn: ['!', 'with a caveat'], fail: ['✕', 'fails'], skip: ['–', 'does not apply'] };

export function createLayoutCard({ toggle, score, list, overlay, invalidate = () => {} }) {
  let result = null;
  const isOpen = () => toggle.getAttribute('aria-expanded') === 'true';

  const el = (tag, attrs = {}, ...children) => {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === 'class') n.className = v;
      else n.setAttribute(k, v === true ? '' : v);
    }
    n.append(...children.filter((c) => c != null));
    return n;
  };

  function render(r) {
    result = r;
    if (!r) {
      score.hidden = true;
      list.replaceChildren(el('li', { class: 'check check-skip' }, el('span', { class: 'check-mark', 'aria-hidden': 'true' }, '–'), el('span', { class: 'check-body' }, 'The empty room: nothing to check.')));
    } else {
      score.hidden = false;
      score.textContent = `${r.score}/${r.total}`;
      score.setAttribute('aria-label', `Layout check: ${r.score} of ${r.total}`);
      score.title = `Layout check: ${r.score} of ${r.total} rules met`;
      list.replaceChildren(...r.checks.map((c) => {
        const [mark, word] = MARKS[c.status] ?? MARKS.skip;
        return el('li', { class: `check check-${c.status}` },
          el('span', { class: 'check-mark', 'aria-hidden': 'true' }, mark),
          el('span', { class: 'check-body' },
            el('span', { class: 'check-label' }, c.label),
            el('span', { class: 'sr-only' }, `, ${word}: `),
            el('span', { class: 'check-reason' }, c.reason)));
      }));
    }
    sync();
  }
  function sync() {
    const show = isOpen() && !!result;
    overlay.update(show ? result : null);
    overlay.setVisible(show);
    invalidate();
  }
  new MutationObserver(sync).observe(toggle, { attributes: true, attributeFilter: ['aria-expanded'] });

  return {
    render,
    get result() {
      return result;
    },
  };
}
