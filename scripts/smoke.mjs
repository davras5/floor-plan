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
  await send('Page.navigate', { url });
  await until('window.__roomReady', 'the room to render');
  await until('window.__furnitureReady', 'furniture to load');
  await until('window.__surroundingsReady', 'surroundings to load');
  await until('window.__lightCaptured >= 1', "the room's light to be captured");
  await run('localStorage.clear()');

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

  // Phone layout.
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await run("roomApp.setMode('orbit')");
  await shot('phone-orbit');
  const overflow = await run('document.documentElement.scrollWidth > window.innerWidth');
  if (overflow) problems.push('phone: the page scrolls sideways');

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
