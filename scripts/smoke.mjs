// Smoke test: opens the app in headless Chrome/Edge, walks through every view and the main
// interactions, saves screenshots to test-output/, and fails on any console error.
//
// usage: npm test            (starts its own server on a free port)
//        node scripts/smoke.mjs --url=http://localhost:5173/   (test a running server)
// Set CHROME_PATH if the browser isn't found automatically.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const root = resolve(import.meta.dirname, '..');
const outDir = join(root, 'test-output');
const arg = (name) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split('=').slice(1).join('=');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((res) => {
  const s = createServer().listen(0, () => {
    const { port } = s.address();
    s.close(() => res(port));
  });
});

function findBrowser() {
  const candidates = [
    process.env.CHROME_PATH,
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
  ];
  return candidates.find((p) => p && existsSync(p));
}

const kill = (proc) => {
  if (!proc || proc.exitCode !== null) return;
  if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { stdio: 'ignore' });
  else proc.kill('SIGKILL');
};
// On Windows, headless Edge re-parents its renderer and GPU processes, so taskkill /T on the
// launcher leaves them running. Each run has its own profile folder: stop every browser
// process whose command line names it (and only those; other tools may run Edge too).
const killProfile = (dir) => {
  if (process.platform !== 'win32') return;
  const needle = dir.replace(/'/g, "''");
  spawnSync('powershell', ['-NoProfile', '-Command',
    `Get-CimInstance Win32_Process -Filter "Name='msedge.exe' OR Name='chrome.exe'" | Where-Object { $_.CommandLine -like '*${needle}*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`,
  ], { stdio: 'ignore' });
};

const browserPath = findBrowser();
if (!browserPath) {
  console.error('No Chrome/Edge found; set CHROME_PATH.');
  process.exit(2);
}

let server = null, url = arg('url');
if (!url) {
  const port = await freePort();
  server = spawn(process.execPath, [join(root, 'scripts/serve.mjs')], { env: { ...process.env, PORT: String(port) }, stdio: 'ignore' });
  url = `http://localhost:${port}/`;
}

const debugPort = await freePort();
const profile = join(tmpdir(), `living-room-smoke-${debugPort}`);
const browser = spawn(browserPath, [
  '--headless=new', `--remote-debugging-port=${debugPort}`, `--user-data-dir=${profile}`,
  '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-first-run', '--no-default-browser-check',
  '--hide-scrollbars', 'about:blank',
], { stdio: 'ignore' });

const problems = [];
let exitCode = 0;
try {
  let page;
  for (let i = 0; i < 100 && !page; i++) {
    await sleep(150);
    try {
      page = (await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json()).find((t) => t.type === 'page');
    } catch {}
  }
  if (!page) throw new Error('browser did not start');

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  let id = 0;
  const pending = new Map();
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id) return pending.get(msg.id)?.(msg);
    if (msg.method === 'Runtime.exceptionThrown') problems.push(`exception: ${msg.params.exceptionDetails.exception?.description ?? msg.params.exceptionDetails.text}`);
    if (msg.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(msg.params.type)) {
      problems.push(`console.${msg.params.type}: ${msg.params.args.map((a) => a.value ?? a.description).join(' ')}`);
    }
    if (msg.method === 'Log.entryAdded' && msg.params.entry.level === 'error' && !/favicon\.ico/.test(msg.params.entry.url ?? '')) {
      problems.push(`log: ${msg.params.entry.text} ${msg.params.entry.url ?? ''}`);
    }
  };
  const send = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
  const run = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.result?.exceptionDetails) throw new Error(`${expr}\n  → ${r.result.exceptionDetails.exception?.description}`);
    return r.result?.result?.value;
  };
  const until = async (expr, what, ms = 30000) => {
    for (const t0 = Date.now(); Date.now() - t0 < ms;) {
      if (await run(`!!(${expr})`)) return;
      await sleep(200);
    }
    throw new Error(`timed out waiting for ${what}`);
  };
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  const shot = async (name) => {
    await sleep(900); // software rendering is slow; let damping, doors and fades settle
    const r = await send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(join(outDir, `${name}.png`), Buffer.from(r.result.data, 'base64'));
  };
  const mouse = async (type, x, y) => {
    await send('Input.dispatchMouseEvent', { type, x, y, button: type === 'mouseMoved' ? 'none' : 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1 });
    await sleep(80);
  };

  await send('Runtime.enable');
  await send('Log.enable');
  await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
  // Counts the page's requestAnimationFrame calls (the render loop must sleep when idle).
  await send('Page.addScriptToEvaluateOnNewDocument', { source: 'window.__rafCount = 0; { const r = window.requestAnimationFrame.bind(window); window.requestAnimationFrame = (cb) => (window.__rafCount++, r(cb)); }' });
  await send('Page.navigate', { url });
  await until('window.__roomReady', 'the room to render');
  await until('window.__furnitureReady', 'furniture to load');
  await until('window.__surroundingsReady', 'surroundings to load');
  await until('window.__lightCaptured >= 1', "the room's light to be captured");
  await run('localStorage.clear()');

  // The render loop sleeps when nothing changes, and wakes for a change: after a few rounds of
  // that, an idle page asks for (almost) no frames. (First, until the light captures are done.)
  for (let last = -1, n; (n = await run('window.__lightCaptured')) !== last; last = n) await sleep(2500);
  for (let i = 0; i < 3; i++) {
    await run('roomApp.invalidate()');
    await sleep(1500);
  }
  // (Up to three windows of 1.5 s, in case a late light capture wakes it in one; a loop that
  // never sleeps fails all three.)
  let idleFrames = Infinity;
  for (let attempt = 0; attempt < 3 && idleFrames > 6; attempt++) {
    const raf0 = await run('window.__rafCount');
    await sleep(1500);
    idleFrames = (await run('window.__rafCount')) - raf0;
  }
  if (idleFrames > 6) problems.push(`render loop: ${idleFrames} frames requested in 1.5 s with nothing to draw`);

  const steps = [
    ['orbit', "roomApp.setMode('orbit')"],
    ['plan', "roomApp.setMode('plan')"],
    ['walk', "roomApp.setMode('walk')"],
    ['walk-evening', "roomApp.setLamp('on')"],
    ['orbit-doors', "roomApp.setLamp('auto'); roomApp.setDoors(true); roomApp.fixtures.setOpen('window', true); roomApp.fixtures.setCurtains(true); roomApp.setMode('orbit')"],
    ['sun-noon', "(() => { const t = document.getElementById('sun-time'); t.value = '12'; t.dispatchEvent(new Event('input')); })()"],
  ];
  for (const [name, js] of steps) {
    await run(js);
    await shot(name);
  }

  // Edit: select the first piece from the editor bar, rotate it, undo, and check it's back.
  await run("roomApp.setDoors(false); roomApp.fixtures.setOpen('window', false); roomApp.fixtures.setCurtains(false); roomApp.setMode('plan'); roomApp.setEdit(true)");
  const before = await run('JSON.stringify(roomApp.furniture.items.map((i) => [i.x, i.z, i.rotation]))');
  await run("document.querySelector('#ed-pieces button')?.click()");
  if (!(await run('!!roomApp.furniture.selected'))) problems.push('editor: picking a piece from the list did not select it');
  await run("document.getElementById('sel-rotate').click()");
  await shot('edit-rotated');
  await run('roomApp.undo()');
  const after = await run('JSON.stringify(roomApp.furniture.items.map((i) => [i.x, i.z, i.rotation]))');
  if (before !== after) problems.push('editor: rotate + undo did not restore the layout');

  // Outside Edit, dragging across the room must never move furniture.
  await run("roomApp.setEdit(false); roomApp.setMode('orbit')");
  const still = await run('JSON.stringify(roomApp.furniture.items.map((i) => [i.x, i.z]))');
  await mouse('mouseMoved', 640, 360);
  await mouse('mousePressed', 640, 360);
  for (let k = 1; k <= 4; k++) await mouse('mouseMoved', 640 + k * 30, 360 + k * 15);
  await mouse('mouseReleased', 760, 420);
  if (still !== (await run('JSON.stringify(roomApp.furniture.items.map((i) => [i.x, i.z]))'))) problems.push('view mode: a drag moved furniture');

  // Presets: each one picked from the panel is the one the room then shows, ticked and in the
  // link, whatever was picked before it (a finish one preset sets mustn't stay for the next).
  const presetIds = await run('roomApp.furniture.presets.map((p) => p.id)');
  const shots = new Set();
  for (const pid of [...presetIds, presetIds[0]]) {
    await run(`document.querySelector('#presets-list [data-preset="${pid}"]').click()`);
    const shown = await run(`(async () => {
      for (let i = 0; i < 150; i++) {
        if (roomApp.furniture.currentPreset() === '${pid}' && location.hash === '#preset=${pid}') return true;
        await new Promise((r) => setTimeout(r, 100));
      }
      return (roomApp.furniture.currentPreset() ?? 'Custom') + ' ' + location.hash;
    })()`);
    if (shown !== true) problems.push(`presets: picking ${pid} shows ${shown}`);
    if (!shots.has(pid)) {
      shots.add(pid);
      await shot(`preset-${pid}`);
    }
  }

  // Settings: the gear opens a labelled dialog with focus inside; Esc closes it and focus goes
  // back to the gear; "Show measurements" works; a quality level applies live.
  const key = (k, code = k) => send('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code, windowsVirtualKeyCode: { Escape: 27, ArrowDown: 40, ArrowUp: 38 }[k] ?? 0 })
    .then(() => send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code }));
  const panelOpen = () => run("!document.getElementById('settings').hidden");
  await run("document.getElementById('settings-button').focus(); document.getElementById('settings-button').click()");
  if (!(await panelOpen())) problems.push('settings: the gear did not open the panel');
  const dialog = await run(`(() => { const p = document.getElementById('settings'); const t = document.getElementById(p.getAttribute('aria-labelledby'));
    return { role: p.getAttribute('role'), title: t?.textContent, focusInside: p.contains(document.activeElement), expanded: document.getElementById('settings-button').getAttribute('aria-expanded'),
      name: document.getElementById('settings-button').getAttribute('aria-label'), radios: p.querySelectorAll('input[type=radio]').length }; })()`);
  if (dialog.role !== 'dialog' || !dialog.title || !dialog.focusInside || dialog.expanded !== 'true' || !dialog.name || dialog.radios !== 4) problems.push(`settings: dialog semantics ${JSON.stringify(dialog)}`);
  await shot('settings-open');
  await key('Escape');
  if (await panelOpen()) problems.push('settings: Esc did not close the panel');
  if (!(await run("document.activeElement === document.getElementById('settings-button')"))) problems.push('settings: focus did not return to the gear');
  await run("document.getElementById('settings-button').click(); document.getElementById('settings-dims').click()");
  if (!(await run("roomApp.scene.getObjectByName('annotations').visible"))) problems.push('settings: Show measurements did not show them');
  await run("document.getElementById('settings-dims').click()");
  // Battery saver from the panel: lower resolution at once, and a reload offered for antialiasing.
  await run("document.getElementById('settings-q-low').click()");
  await sleep(1500);
  const low = await run(`({ level: roomApp.quality.level, ratio: roomApp.renderer.getPixelRatio(), reload: !document.querySelector('#settings .settings-reload').hidden, sun: roomApp.lighting.sun.shadow.mapSize.x })`);
  // (The reload note shows exactly when the page was loaded with antialiasing, which Battery saver turns off.)
  if (low.level !== 'low' || low.ratio > 1 || low.sun !== 1024 || low.reload !== (await run('roomApp.quality.antialias'))) problems.push(`settings: Battery saver not applied ${JSON.stringify(low)}`);
  await shot('settings-low');
  // Arrow keys move between the levels (native radios).
  await run("document.getElementById('settings-q-low').focus()");
  await key('ArrowDown');
  if ((await run('roomApp.quality.choice')) !== 'medium') problems.push('settings: arrow keys did not move to the next level');
  await run("document.getElementById('settings-q-auto').click()");
  await key('Escape');
  await run('roomApp.quality.set("high")');

  // The layout check: a score in the room card's title line; open, the eight rules, and the
  // practice zone drawn on the floor; a score next to every preset, the same as the card's once
  // that preset is applied; the layouts ranked as the review's update says.
  const cardScore = () => run("document.getElementById('check-score').textContent");
  if (!/^\d\/\d$/.test(await cardScore())) problems.push(`layout check: the card's score reads "${await cardScore()}"`);
  await run("document.getElementById('card-toggle').click()");
  await sleep(400);
  const rules = await run("document.querySelectorAll('#check-list .check').length");
  if (rules !== 8) problems.push(`layout check: ${rules} rules listed, not 8`);
  if (!(await run("roomApp.scene.getObjectByName('layout check').visible"))) problems.push('layout check: the zone is not drawn while the card is open');
  await shot('layout-check');
  await run("document.getElementById('card-toggle').click()");
  if (await run("roomApp.scene.getObjectByName('layout check').visible")) problems.push('layout check: the zone stayed on the floor after the card closed');
  await until("roomApp.furniture.presets.every((p) => { const s = document.querySelector('#presets-list [data-preset=' + JSON.stringify(p.id) + '] .preset-score'); return s && !s.hidden && /\\d\\/\\d/.test(s.textContent); })", "the presets' scores", 15000);
  const pills = await run("Object.fromEntries([...document.querySelectorAll('#presets-list [data-preset]')].map((b) => [b.dataset.preset, b.querySelector('.preset-score')?.textContent]))");
  const layouts = ['layout-window-dining', 'layout-one-wall', 'layout-view-sofa'];
  for (const pid of layouts) {
    await run(`document.querySelector('#presets-list [data-preset="${pid}"]').click()`);
    await until(`roomApp.furniture.currentPreset() === '${pid}'`, `${pid} to apply`);
    await sleep(500);
    if ((await cardScore()) !== pills[pid]) problems.push(`layout check: ${pid} scores ${pills[pid]} in the list but ${await cardScore()} in the card`);
  }
  const score = (pid) => Number(pills[pid]?.split('/')[0]);
  if (!(score(layouts[0]) > score(layouts[1]) && score(layouts[1]) > score(layouts[2]))) problems.push(`layout check: the layouts rank ${JSON.stringify(pills)}`);
  // The recommended layout swags the pendant over the dining table; the default hangs it from the outlet again.
  await run(`document.querySelector('#presets-list [data-preset="${layouts[0]}"]').click()`);
  await until(`roomApp.furniture.currentPreset() === '${layouts[0]}'`, 'the recommended layout');
  if ((await run('JSON.stringify(roomApp.pendant.hang)')) === 'null') problems.push('layout: the recommended preset did not swag the pendant');
  await run("document.getElementById('card-toggle').click()");
  await shot('layout-window-dining');
  await run("document.getElementById('card-toggle').click()");
  await run(`document.querySelector('#presets-list [data-preset="${presetIds[0]}"]').click()`);
  await until(`roomApp.furniture.currentPreset() === '${presetIds[0]}'`, 'the default preset again');
  if ((await run('JSON.stringify(roomApp.pendant.hang)')) !== 'null') problems.push('layout: the pendant stayed swagged after the default preset');

  // Fast picking: the bounds trees are built in idle time once three-mesh-bvh has loaded.
  await run('roomApp.furniture.fastPicking');
  await until("roomApp.furniture.items.some((i) => i.meshes?.some((m) => m.geometry.boundsTree))", 'the picking bounds trees', 20000);

  // The Sun switch: one tap is evening (after dusk, the ceiling light on by itself), the next is
  // day; its chevron opens the time-of-day panel (a dialog, the slider focused), Esc closes it.
  await run("document.getElementById('sun-button').click()");
  await sleep(600);
  const evening = await run("({ pressed: document.getElementById('sun-button').getAttribute('aria-pressed'), lamp: roomApp.lighting.lampOn, time: document.getElementById('sun-time').value })");
  if (evening.pressed !== 'true' || !evening.lamp) problems.push(`sun: the switch did not make it evening ${JSON.stringify(evening)}`);
  await shot('sun-evening');
  await run("document.getElementById('sun-button').click()");
  await sleep(300);
  if ((await run("document.getElementById('sun-time').value")) !== '13') problems.push('sun: the switch did not go back to day');
  await run("document.getElementById('sun-more').click()");
  const sunDialog = await run("(() => { const p = document.getElementById('sun-panel'); return { hidden: p.hidden, role: p.getAttribute('role'), focus: document.activeElement?.id, expanded: document.getElementById('sun-more').getAttribute('aria-expanded') }; })()");
  if (sunDialog.hidden || sunDialog.role !== 'dialog' || sunDialog.focus !== 'sun-time' || sunDialog.expanded !== 'true') problems.push(`sun: panel ${JSON.stringify(sunDialog)}`);
  await key('Escape');
  if (!(await run("document.getElementById('sun-panel').hidden"))) problems.push('sun: Esc did not close the panel');

  // Diagnostics: a lost WebGL context shows the panel; when it's restored the panel goes and the
  // room is drawn again. (The browser's own context-lost messages are expected here.)
  const problemsBefore = problems.length;
  const lost = await run("(() => { const x = roomApp.renderer.getContext().getExtension('WEBGL_lose_context'); if (!x) return false; window.__lose = x; x.loseContext(); return true; })()");
  if (lost) {
    await sleep(1000);
    if (!(await run("!document.querySelector('.diag-panel').hidden"))) problems.push('diagnostics: no panel after the WebGL context was lost');
    if (!/GPU: .+\n.*Limits: texture \d+/.test(await run('roomApp.diagnostics.details()'))) problems.push('diagnostics: the details lack the GPU and its limits');
    await run('window.__lose.restoreContext()');
    await sleep(4000);
    await shot('context-restored');
    if (await run("!document.querySelector('.diag-panel').hidden")) problems.push('diagnostics: the panel stayed after the context came back');
    if (await run('roomApp.renderer.getContext().isContextLost()')) problems.push('diagnostics: the context did not come back');
  }
  problems.splice(problemsBefore, problems.length - problemsBefore, ...problems.slice(problemsBefore).filter((p) => !/context (was )?lost|CONTEXT_LOST/i.test(p)));

  // Phone layout.
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await send('Emulation.setTouchEmulationEnabled', { enabled: true });
  await run("roomApp.setMode('orbit')");
  await shot('phone-orbit');
  const overflow = await run('document.documentElement.scrollWidth > window.innerWidth');
  if (overflow) problems.push('phone: the page scrolls sideways');
  // The settings panel on phones: inside the screen, finger-sized targets, the toolbar one row.
  for (const width of [390, 360]) {
    await send('Emulation.setDeviceMetricsOverride', { width, height: 780, deviceScaleFactor: 2, mobile: true });
    await sleep(400);
    const rows = await run("new Set([...document.querySelectorAll('#dock > .group')].map((g) => Math.round(g.getBoundingClientRect().top))).size");
    if (rows !== 1) problems.push(`phone ${width}: the toolbar wraps to ${rows} rows`);
    await run("document.getElementById('settings-button').click()");
    await sleep(300);
    const fit = await run(`(() => { const p = document.getElementById('settings').getBoundingClientRect();
      const small = [...document.querySelectorAll('#settings label, #settings button:not([hidden]), #settings-button')].filter((e) => e.offsetParent && e.getBoundingClientRect().height < 44).map((e) => e.id || e.className);
      return { inside: p.left >= 0 && p.right <= innerWidth && p.top >= 0 && p.bottom <= innerHeight, overflow: document.documentElement.scrollWidth > innerWidth, small }; })()`);
    if (!fit.inside || fit.overflow || fit.small.length) problems.push(`phone ${width}: settings panel ${JSON.stringify(fit)}`);
    await shot(`phone-${width}-settings`);
    await key('Escape');
  }

  ws.close();
} catch (err) {
  problems.push(`failed: ${err.message}`);
} finally {
  kill(browser);
  killProfile(profile);
  kill(server);
  // The browser can hold its profile folder for a moment after it's killed.
  for (let i = 0; i < 10; i++) {
    try {
      rmSync(profile, { recursive: true, force: true });
      break;
    } catch {
      await sleep(300);
    }
  }
}

if (problems.length) {
  console.error(`✗ ${problems.length} problem(s):\n  ` + problems.join('\n  '));
  exitCode = 1;
} else console.log(`✓ smoke test passed; screenshots in ${outDir}`);
process.exit(exitCode);
