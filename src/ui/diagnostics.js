// On-screen diagnostics. On a phone, a problem after the first frame is otherwise invisible: a
// lost WebGL context (the graphics memory ran out) leaves a blank view, a shader that doesn't
// compile on that GPU leaves things missing, an uncaught error just stops something. A small
// panel says what happened and offers what helps (reload, or Battery saver and reload), with
// "Copy details" for a report: the GPU and its limits, the screen, the quality level, the browser
// and the errors so far. Self-contained: builds its own markup; the styles are in index.html.

// renderer: the WebGLRenderer. quality: from createQuality(). onRestored(): the context is back
// (main.js redraws shadows and the light). reload(): reload keeping the view.
export function createDiagnostics({ renderer, quality, onRestored = () => {}, reload = () => location.reload() }) {
  const canvas = renderer.domElement;
  const gpu = describeGpu(renderer.getContext());
  const errors = [];

  // ---- the panel ----
  const el = (tag, attrs = {}, ...children) => {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === 'class') n.className = v;
      else if (k === 'text') n.textContent = v;
      else if (k === 'on') for (const [e, fn] of Object.entries(v)) n.addEventListener(e, fn);
      else n.setAttribute(k, v === true ? '' : v);
    }
    n.append(...children.filter((c) => c != null));
    return n;
  };
  const title = el('h2', { id: 'diag-title' });
  const text = el('p', { class: 'diag-text', id: 'diag-text' });
  const copied = el('span', { class: 'diag-copied', 'aria-live': 'polite' });
  const detailText = el('pre', { class: 'diag-pre' });
  const actions = el('div', { class: 'diag-actions' });
  const panel = el('section', { class: 'diag-panel', role: 'alertdialog', 'aria-modal': 'false', 'aria-labelledby': 'diag-title', 'aria-describedby': 'diag-text', hidden: true },
    el('div', { class: 'diag-head' }, title,
      el('button', { type: 'button', class: 'diag-close', 'aria-label': 'Close', title: 'Close', text: '×', on: { click: () => hide() } })),
    text,
    actions,
    el('details', { class: 'diag-details' }, el('summary', { text: 'Details' }), detailText));
  document.body.append(panel);

  const button = (label, run, primary = false) => el('button', { type: 'button', class: primary ? 'diag-button primary' : 'diag-button', text: label, on: { click: run } });
  const copyButton = () => button('Copy details', async () => {
    const t = details();
    try {
      await navigator.clipboard.writeText(t);
      copied.textContent = 'Copied';
    } catch {
      // No clipboard access (an embedding, an old browser): select the text to copy by hand.
      panel.querySelector('.diag-details').open = true;
      const range = document.createRange();
      range.selectNodeContents(detailText);
      getSelection().removeAllRanges();
      getSelection().addRange(range);
      copied.textContent = 'Selected: copy it from here';
    }
  });

  let shownKind = null;
  function show(kind, heading, message, buttons) {
    shownKind = kind;
    title.textContent = heading;
    text.textContent = message;
    copied.textContent = '';
    actions.replaceChildren(...buttons, copyButton(), copied);
    detailText.textContent = details();
    const wasHidden = panel.hidden;
    panel.hidden = false;
    if (wasHidden) actions.querySelector('button')?.focus({ preventScroll: true });
  }
  function hide() {
    panel.hidden = true;
    shownKind = null;
  }

  function record(kind, message, stack = '') {
    errors.push({ at: new Date().toISOString(), kind, message: String(message).slice(0, 500), stack: String(stack ?? '').split('\n').slice(0, 6).join('\n') });
    if (errors.length > 20) errors.shift();
  }

  // ---- what's reported ----
  // The WebGL context is lost: almost always the GPU ran out of memory (or the system reclaimed
  // it). three keeps the scene and recreates its GPU resources if the context comes back.
  canvas.addEventListener('webglcontextlost', () => {
    record('context lost', `WebGL context lost (quality: ${quality.level})`);
    console.warn('The WebGL context was lost');
    show('context', 'The 3D view stopped', 'The graphics memory probably ran out. Reload the page, or switch to Battery saver, which uses about half the memory, and reload.', [
      button('Reload', () => reload(), true),
      quality.level !== 'low' && button('Battery saver and reload', () => {
        quality.set('low');
        reload();
      }),
    ].filter(Boolean));
  });
  canvas.addEventListener('webglcontextrestored', () => {
    record('context restored', 'WebGL context restored');
    if (shownKind === 'context') hide();
    onRestored();
  });

  // A shader that doesn't compile or link on this GPU (three calls this instead of logging).
  renderer.debug.onShaderError = (gl, program, vs, fs) => {
    const log = [gl.getProgramInfoLog(program), gl.getShaderInfoLog(vs), gl.getShaderInfoLog(fs)].map((s) => (s ?? '').trim()).filter(Boolean).join('\n');
    record('shader', log || 'shader compile or link error');
    console.error('Shader error:', log);
    show('shader', 'Part of the view couldn’t be drawn', 'A shader didn’t compile on this graphics chip, so some surfaces may be missing. Copying the details helps fix it.', [
      quality.level !== 'low' && button('Try Battery saver', () => {
        quality.set('low');
        reload();
      }),
    ].filter(Boolean));
  };

  // Uncaught errors after the first frame (before it, index.html says so in the loading box).
  const uncaught = (message, stack) => {
    if (!window.__roomReady) return;
    record('error', message, stack);
    // While the context is lost, errors are its consequences; the context panel says it all.
    if (renderer.getContext().isContextLost()) return;
    show('error', 'Something went wrong', `${message}. The rest may still work; reload if it doesn’t.`, [button('Reload', () => reload(), true)]);
  };
  addEventListener('error', (e) => {
    if (e.target && e.target !== window) return; // a resource that didn't load (logged by the browser)
    uncaught(e.message || 'Error', e.error?.stack);
  });
  addEventListener('unhandledrejection', (e) => uncaught(e.reason?.message ?? String(e.reason), e.reason?.stack));

  // ---- details for a report ----
  function details() {
    const gl = renderer.getContext();
    const buffer = gl.drawingBufferWidth ? `${gl.drawingBufferWidth} × ${gl.drawingBufferHeight}` : '?';
    const m = renderer.info.memory;
    const q = quality.settings;
    const lines = [
      'Living room planner: diagnostics',
      `When: ${new Date().toISOString()}`,
      `Page: ${location.href}`,
      `Browser: ${navigator.userAgent}`,
      `Screen: ${screen.width} × ${screen.height} CSS px, window ${innerWidth} × ${innerHeight}, device pixel ratio ${devicePixelRatio}`,
      `Drawing buffer: ${buffer} (pixel ratio ${renderer.getPixelRatio()})`,
      `Device: ${navigator.deviceMemory ?? '?'} GB memory reported, ${navigator.hardwareConcurrency ?? '?'} cores, ${matchMedia('(pointer: coarse)').matches ? 'touch' : 'mouse'}`,
      `Quality: ${quality.choice}${quality.choice === 'auto' ? ` (${quality.level})` : ''}; antialiasing ${quality.antialias ? 'on' : 'off'}; sun shadow ${q.sunShadow} px; lamp shadow ${q.lampShadow} px`,
      `GPU: ${gpu.renderer} (${gpu.vendor}), ${gpu.version}`,
      `Limits: texture ${gpu.MAX_TEXTURE_SIZE}, cube map ${gpu.MAX_CUBE_MAP_TEXTURE_SIZE}, renderbuffer ${gpu.MAX_RENDERBUFFER_SIZE}, samples ${gpu.MAX_SAMPLES}; ` +
        `texture units ${gpu.MAX_TEXTURE_IMAGE_UNITS} (vertex ${gpu.MAX_VERTEX_TEXTURE_IMAGE_UNITS}, combined ${gpu.MAX_COMBINED_TEXTURE_IMAGE_UNITS}); ` +
        `uniform vectors: fragment ${gpu.MAX_FRAGMENT_UNIFORM_VECTORS}, vertex ${gpu.MAX_VERTEX_UNIFORM_VECTORS}; varying vectors ${gpu.MAX_VARYING_VECTORS}`,
      `Extensions: ${gpu.extensions}`,
      `Scene: ${m.geometries} geometries, ${m.textures} textures, ${renderer.info.programs?.length ?? '?'} shader programs`,
      `Errors (${errors.length}):`,
      ...errors.map((e) => `  ${e.at} ${e.kind}: ${e.message}${e.stack ? `\n    ${e.stack.replace(/\n/g, '\n    ')}` : ''}`),
    ];
    return lines.join('\n');
  }

  return {
    get gpu() {
      return gpu;
    },
    get errors() {
      return errors;
    },
    details,
    // For main.js: a problem it caught itself (e.g. the furniture didn't load).
    report(message, error) {
      record('reported', message, error?.stack);
      show('error', 'Something didn’t load', message, [button('Reload', () => reload(), true)]);
    },
    hide,
    get isOpen() {
      return !panel.hidden;
    },
  };
}

// The GPU and the limits that matter for this app's shaders, read once while the context is fine.
function describeGpu(gl) {
  const out = {};
  try {
    const info = gl.getExtension('WEBGL_debug_renderer_info');
    out.vendor = info ? gl.getParameter(info.UNMASKED_VENDOR_WEBGL) : gl.getParameter(gl.VENDOR);
    out.renderer = info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
    out.version = gl.getParameter(gl.VERSION);
    for (const name of ['MAX_TEXTURE_SIZE', 'MAX_CUBE_MAP_TEXTURE_SIZE', 'MAX_RENDERBUFFER_SIZE', 'MAX_TEXTURE_IMAGE_UNITS', 'MAX_VERTEX_TEXTURE_IMAGE_UNITS',
      'MAX_COMBINED_TEXTURE_IMAGE_UNITS', 'MAX_FRAGMENT_UNIFORM_VECTORS', 'MAX_VERTEX_UNIFORM_VECTORS', 'MAX_VARYING_VECTORS', 'MAX_SAMPLES']) {
      out[name] = gl[name] != null ? gl.getParameter(gl[name]) : '?';
    }
    out.extensions = ['KHR_parallel_shader_compile', 'EXT_color_buffer_float', 'EXT_color_buffer_half_float', 'EXT_texture_filter_anisotropic', 'OES_texture_float_linear']
      .map((x) => `${x} ${gl.getExtension(x) ? 'yes' : 'no'}`).join(', ');
  } catch (e) {
    out.error = String(e);
  }
  return out;
}
